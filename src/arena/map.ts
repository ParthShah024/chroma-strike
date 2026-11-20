import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type {
  AABB,
  ArenaDoorHudState,
  ArenaDoorStatus,
  BombSiteId,
  BombSiteZone,
  Vec3,
} from '../core/types';
import { loadOptionalGlbAsset } from '../entities/glbOverride';
import {
  ARENA_DEPTH_M,
  ARENA_WIDTH_M,
  ASCENT_CALLOUTS,
  ASCENT_MAP_DATA,
  type ArenaCallout,
  type ArenaMinimapData,
  type ArenaWaypoint,
  type ArenaZone,
  type AscentDoorDef,
} from './ascentMapData';
import { getArenaTexture, getBuyBarrierTexture } from './textures';

export {
  ARENA_DEPTH_M,
  ARENA_WIDTH_M,
  ASCENT_CALLOUTS,
  ASCENT_MAP_DATA,
  type ArenaCallout,
  type ArenaMinimapData,
  type ArenaWaypoint,
  type ArenaZone,
};

/**
 * ============================================================================
 * "Chroma Ascent" True 3D Blender `.glb` + Single-Source-of-Truth Arena
 * (`84m x 92m` Multi-Elevation Venetian S&D Compound & Breakable Blast Doors)
 * ============================================================================
 *
 * 1. **1:1 Physics / Visual Single Source of Truth**:
 *    `scripts/blender/build_ascent_map.py` exports BOTH `/models/ascent_map.glb`
 *    and `./ascentMapData.ts` from the exact same Python architectural primitives.
 *    `ARENA_COLLIDERS` is populated immediately at module import (`staticColliderCount`)
 *    and mutated strictly in-place whenever interactive Blast Doors (`a_tree`,
 *    `b_market`) close, open, or shatter.
 *
 * 2. **True Two-Story Verticality**:
 *    - **A Heaven (`y = 3.00m`)** sits directly above **A Hell (`y = 0.00m`,
 *      ceiling `2.65m`)**, climbed via a 7-tread CT staircase (`~0.43m` step rise).
 *    - **Mid Catwalk (`y = 0.85m`)** & **B Lane (`y = 0.85m`)** connect via
 *      smooth `0.425m` stone steps.
 *    - **Shoot-Through Windows (`y = 1.10..2.50m`)** in Mid Market and B Boat House.
 *
 * 3. **Interactive Breakable Blast Doors (`a_tree` & `b_market`)**:
 *    Start `'open'` (`400 HP`) each round. Pressing `[F]` near `DoorSwitch_<id>`
 *    slides `DoorPanel_<id>` smoothly over `0.6s` (`+3.1m` travel) and toggles
 *    its `'door'` collider in `ARENA_COLLIDERS`. Weapon fire damages closed doors;
 *    at `0 HP` the shutter shatters into tumbling metallic debris shards for the
 *    remainder of the round.
 */

export interface ArenaSpawns {
  allies: [Vec3, Vec3, Vec3];
  enemies: [Vec3, Vec3, Vec3];
  buyMinAllyZ: number;
  buyMaxDefenderZ: number;
}

const DOOR_SLIDE_DURATION_SEC = 0.6;
const DOOR_OPEN_LIFT_M = 3.1;
const DEFAULT_SWITCH_INTERACT_DIST_M = 2.6;

const COLOR_SKY_BG = 0xd4e6f6;
const COLOR_SITE_A = 0xff8a3d;
const COLOR_SITE_B = 0x38bdf8;
const COLOR_RADIANITE = 0xff4d6d;
const COLOR_BARRIER_ATTACK = 0x4f9dff;
const COLOR_BARRIER_DEFEND = 0xff4d5e;

const COLOR_SWITCH_OPEN = 0x2ecc71;
const COLOR_SWITCH_CLOSED = 0xf59e0b;
const COLOR_SWITCH_BROKEN = 0xef4444;

function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function cloneSite(site: BombSiteZone): BombSiteZone {
  return {
    site: site.site,
    minX: site.minX,
    maxX: site.maxX,
    minZ: site.minZ,
    maxZ: site.maxZ,
    center: cloneVec3(site.center),
  };
}

function smoothStep01(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function nowSeconds(): number {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

// ---------------------------------------------------------------------------
// Authoritative Static Colliders + Live Interactive Door State
// ---------------------------------------------------------------------------

/**
 * Live arena colliders read by player physics, hitscan raycasts, projectiles,
 * and AI perception. Mutated strictly in-place so imported bindings stay live.
 */
export const ARENA_COLLIDERS: AABB[] = ASCENT_MAP_DATA.colliders.map((c) => ({
  min: cloneVec3(c.min),
  max: cloneVec3(c.max),
  tag: c.tag,
}));

const staticColliderCount = ARENA_COLLIDERS.length;

interface DoorRuntimeState {
  def: AscentDoorDef;
  status: ArenaDoorStatus;
  hp: number;
  /** 1.0 = fully open (`+3.1m` up inside housing), 0.0 = fully closed. */
  openProgress: number;
  hitFlashTimer: number;
  glbPanel: THREE.Object3D | null;
  glbPanelMats: THREE.MeshStandardMaterial[];
  glbSwitchMats: THREE.MeshStandardMaterial[];
  fallbackPanel: THREE.Mesh | null;
  fallbackPanelMat: THREE.MeshStandardMaterial | null;
  fallbackSwitchMat: THREE.MeshStandardMaterial | null;
}

interface DoorDebrisShard {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  geo: THREE.BufferGeometry;
  vel: Vec3;
  rotVel: Vec3;
  age: number;
  maxAge: number;
}

const doorStates: DoorRuntimeState[] = ASCENT_MAP_DATA.doors.map((def) => ({
  def,
  status: 'open',
  hp: def.maxHp,
  openProgress: 1.0,
  hitFlashTimer: 0,
  glbPanel: null,
  glbPanelMats: [],
  glbSwitchMats: [],
  fallbackPanel: null,
  fallbackPanelMat: null,
  fallbackSwitchMat: null,
}));

const activeShards: DoorDebrisShard[] = [];

let arenaRoot: THREE.Group | null = null;
let barrierGroup: THREE.Group | null = null;
let shatterGroup: THREE.Group | null = null;
let barriersVisible = false;

/**
 * Returns `true` when `(x, z)` lies inside a side's forward Buy-Phase setup region
 * behind the 11 Valorant-style forward choke barriers.
 */
export function isInsideBuyZone(x: number, z: number, side: 'attacker' | 'defender'): boolean {
  if (side === 'attacker') {
    if (z >= 20.0) return true;
    if (x <= -16.0 && z >= 6.0) return true;
    if (x > -16.0 && x < 11.5 && z >= 12.3) return true;
    if (x >= 11.5 && z >= 4.0) return true;
    return false;
  }
  if (z <= -25.5) return true;
  if (x <= -5.0 && z <= -8.0) return true;
  if (x > -5.0 && x <= 1.75 && z <= -16.0) return true;
  if (x > 1.75 && x <= 14.0 && z <= -15.1) return true;
  if (x > 14.0 && z <= -8.0) return true;
  return false;
}

/** Synchronizes dynamic `'closed'` Blast Doors & active Buy-Phase barriers into `ARENA_COLLIDERS` in-place. */
function syncDynamicColliders(): void {
  ARENA_COLLIDERS.length = staticColliderCount;
  for (const d of doorStates) {
    if (d.status === 'closed') {
      ARENA_COLLIDERS.push({
        min: cloneVec3(d.def.bounds.min),
        max: cloneVec3(d.def.bounds.max),
        tag: 'door',
        doorId: d.def.id,
        color: 0x4b5868,
      });
    }
  }
  if (barriersVisible) {
    for (const span of ASCENT_MAP_DATA.buyBarrierSpans) {
      const axis = span.axis ?? 'z';
      const minY = span.baseY;
      const maxY = span.baseY + Math.max(span.height, 4.5);
      if (axis === 'x') {
        const cx = span.x ?? 0;
        const z0 = span.z0 ?? 0;
        const z1 = span.z1 ?? 0;
        ARENA_COLLIDERS.push({
          min: { x: cx - 0.18, y: minY, z: Math.min(z0, z1) },
          max: { x: cx + 0.18, y: maxY, z: Math.max(z0, z1) },
          tag: 'wall',
        });
      } else {
        const cz = span.z ?? 0;
        const x0 = span.x0 ?? 0;
        const x1 = span.x1 ?? 0;
        ARENA_COLLIDERS.push({
          min: { x: Math.min(x0, x1), y: minY, z: cz - 0.18 },
          max: { x: Math.max(x0, x1), y: maxY, z: cz + 0.18 },
          tag: 'wall',
        });
      }
    }
  }
}

syncDynamicColliders();

/** Default South (`+Z`) human player spawn: central Attacker pad. */
export const PLAYER_SPAWN: Vec3 = cloneVec3(ASCENT_MAP_DATA.spawns.allies[1]);

// ---------------------------------------------------------------------------
// Public Tactical & Minimap Accessors
// ---------------------------------------------------------------------------

export function getSpikeSpawnPos(): Vec3 {
  return cloneVec3(ASCENT_MAP_DATA.spawns.spikePedestal);
}

export function getArenaWaypoints(): ArenaWaypoint[] {
  return ASCENT_MAP_DATA.waypoints.map((wp) => ({
    id: wp.id,
    pos: cloneVec3(wp.pos),
    neighbors: [...wp.neighbors],
    zone: wp.zone,
  }));
}

export function getArenaSpawns(): ArenaSpawns {
  const s = ASCENT_MAP_DATA.spawns;
  return {
    allies: [cloneVec3(s.allies[0]), cloneVec3(s.allies[1]), cloneVec3(s.allies[2])],
    enemies: [cloneVec3(s.enemies[0]), cloneVec3(s.enemies[1]), cloneVec3(s.enemies[2])],
    buyMinAllyZ: s.buyMinAllyZ,
    buyMaxDefenderZ: s.buyMaxDefenderZ,
  };
}

export function getBombSites(): Record<BombSiteId, BombSiteZone> {
  return {
    A: cloneSite(ASCENT_MAP_DATA.bombSites.A),
    B: cloneSite(ASCENT_MAP_DATA.bombSites.B),
  };
}

export function getBombSiteAt(x: number, z: number): BombSiteId | null {
  for (const id of ['A', 'B'] as const) {
    const s = ASCENT_MAP_DATA.bombSites[id];
    if (x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ) {
      return id;
    }
  }
  return null;
}

export function getArenaMinimapData(): ArenaMinimapData {
  return {
    walkableRects: ASCENT_MAP_DATA.minimapShapes.walkableRects.map((r) => ({ ...r })),
    wallRects: ASCENT_MAP_DATA.minimapShapes.wallRects.map((r) => ({ ...r })),
  };
}

// ---------------------------------------------------------------------------
// Interactive Breakable Blast Door API
// ---------------------------------------------------------------------------

function applyDoorVisualState(d: DoorRuntimeState): void {
  const closedY = d.def.center.y;
  const liftedY = closedY + smoothStep01(d.openProgress) * DOOR_OPEN_LIFT_M;
  const visible = d.status !== 'broken';

  if (d.glbPanel) {
    d.glbPanel.visible = visible;
    d.glbPanel.position.y = liftedY;
  }
  if (d.fallbackPanel) {
    d.fallbackPanel.visible = visible && !d.glbPanel;
    d.fallbackPanel.position.y = liftedY;
  }

  // Damage & hit-flash emissive tint on door steel materials
  const hpFrac = Math.max(0, Math.min(1, d.hp / d.def.maxHp));
  const stress = d.status === 'closed' ? Math.max(0, 1 - hpFrac) : 0;
  const flash = d.hitFlashTimer > 0 ? d.hitFlashTimer / 0.12 : 0;
  const emissiveHex = flash > 0.25 ? 0xff9a3d : 0xd93829;
  const emissiveStrength = flash * 1.15 + stress * stress * 0.65;

  const panelMats = d.fallbackPanelMat ? [...d.glbPanelMats, d.fallbackPanelMat] : d.glbPanelMats;
  for (const mat of panelMats) {
    mat.emissive.setHex(emissiveHex);
    mat.emissiveIntensity = emissiveStrength;
  }

  // Switch LED indicator color
  const ledColor =
    d.status === 'open'
      ? COLOR_SWITCH_OPEN
      : d.status === 'closed'
        ? COLOR_SWITCH_CLOSED
        : COLOR_SWITCH_BROKEN;
  const ledIntensity = d.status === 'broken' ? 0.45 : 1.85;
  const switchMats = d.fallbackSwitchMat ? [...d.glbSwitchMats, d.fallbackSwitchMat] : d.glbSwitchMats;
  for (const sm of switchMats) {
    sm.color.setHex(ledColor);
    sm.emissive.setHex(ledColor);
    sm.emissiveIntensity = ledIntensity;
  }
}

function clearDebrisShards(): void {
  for (const s of activeShards) {
    s.mesh.removeFromParent();
    s.geo.dispose();
    s.mat.dispose();
  }
  activeShards.length = 0;
}

function spawnDoorShatterShards(d: DoorRuntimeState): void {
  if (!shatterGroup) return;
  const { min, max } = d.def.bounds;
  const spanZ = max.z - min.z;
  const spanY = max.y - min.y;
  const cx = d.def.center.x;

  const shardCount = 20;
  for (let i = 0; i < shardCount; i++) {
    const w = 0.12 + (i % 3) * 0.05;
    const h = 0.24 + ((i * 7) % 5) * 0.08;
    const depth = 0.28 + ((i * 3) % 4) * 0.09;
    const geo = new THREE.BoxGeometry(w, h, depth);
    const isHazard = i % 5 === 0;
    const mat = new THREE.MeshStandardMaterial({
      color: isHazard ? 0xe5a91a : 0x4b5868,
      roughness: 0.36,
      metalness: isHazard ? 0.3 : 0.75,
      emissive: 0xff6b2b,
      emissiveIntensity: 0.55,
    });

    const mesh = new THREE.Mesh(geo, mat);
    const u = ((i + 0.5) / shardCount) - 0.5;
    const py = min.y + 0.35 + (((i * 13) % 17) / 17) * (spanY - 0.7);
    const pz = d.def.center.z + u * (spanZ - 0.4);
    mesh.position.set(cx, py, pz);
    mesh.castShadow = true;
    shatterGroup.add(mesh);

    const sideSign = i % 2 === 0 ? 1 : -1;
    const speedX = (2.4 + ((i * 11) % 9) * 0.45) * sideSign;
    const speedY = 1.8 + ((i * 5) % 7) * 0.42;
    const speedZ = (((i * 17) % 11) - 5) * 0.38;

    activeShards.push({
      mesh,
      mat,
      geo,
      vel: { x: speedX, y: speedY, z: speedZ },
      rotVel: {
        x: (i % 2 === 0 ? 1 : -1) * (4.0 + (i % 5)),
        y: (3.2 + (i % 4)) * sideSign,
        z: (i % 3 === 0 ? -1 : 1) * (3.5 + (i % 6)),
      },
      age: 0,
      maxAge: 1.55 + (i % 4) * 0.18,
    });
  }
}

export function getArenaDoors(): ArenaDoorHudState[] {
  return doorStates.map((d) => ({
    id: d.def.id,
    label: d.def.label,
    status: d.status,
    hp: Math.ceil(d.hp),
    maxHp: d.def.maxHp,
    center: cloneVec3(d.def.center),
    switchPos: cloneVec3(d.def.switchPos),
    minX: d.def.bounds.min.x,
    maxX: d.def.bounds.max.x,
    minZ: d.def.bounds.min.z,
    maxZ: d.def.bounds.max.z,
  }));
}

export function resetArenaDoors(): void {
  clearDebrisShards();
  for (const d of doorStates) {
    d.status = 'open';
    d.hp = d.def.maxHp;
    d.openProgress = 1.0;
    d.hitFlashTimer = 0;
    applyDoorVisualState(d);
  }
  syncDynamicColliders();
}

export function toggleArenaDoor(doorId: string): 'closed' | 'open' | null {
  const d = doorStates.find((item) => item.def.id === doorId);
  if (!d || d.status === 'broken') return null;

  d.status = d.status === 'open' ? 'closed' : 'open';
  syncDynamicColliders();
  applyDoorVisualState(d);
  return d.status;
}

export function damageArenaDoor(
  doorId: string,
  damage: number
): { hit: boolean; broken: boolean; remainingHp: number } {
  const d = doorStates.find((item) => item.def.id === doorId);
  if (!d) return { hit: false, broken: false, remainingHp: 0 };
  if (d.status !== 'closed' || damage <= 0) {
    return { hit: false, broken: d.status === 'broken', remainingHp: Math.ceil(d.hp) };
  }

  d.hp = Math.max(0, d.hp - damage);
  d.hitFlashTimer = 0.12;

  if (d.hp <= 0) {
    d.hp = 0;
    d.status = 'broken';
    syncDynamicColliders();
    spawnDoorShatterShards(d);
    applyDoorVisualState(d);
    return { hit: true, broken: true, remainingHp: 0 };
  }

  applyDoorVisualState(d);
  return { hit: true, broken: false, remainingHp: Math.ceil(d.hp) };
}

export function updateArenaDoors(dt: number): void {
  const clampedDt = Math.min(Math.max(dt, 0), 0.1);
  if (clampedDt <= 0) return;

  const slideStep = clampedDt / DOOR_SLIDE_DURATION_SEC;
  for (const d of doorStates) {
    const targetOpen = d.status === 'open' ? 1.0 : 0.0;
    let dirty = false;

    if (d.status !== 'broken' && Math.abs(d.openProgress - targetOpen) > 1e-4) {
      if (d.openProgress < targetOpen) {
        d.openProgress = Math.min(targetOpen, d.openProgress + slideStep);
      } else {
        d.openProgress = Math.max(targetOpen, d.openProgress - slideStep);
      }
      dirty = true;
    }

    if (d.hitFlashTimer > 0) {
      d.hitFlashTimer = Math.max(0, d.hitFlashTimer - clampedDt);
      dirty = true;
    }

    if (dirty) {
      applyDoorVisualState(d);
    }
  }

  // Simulate metallic shatter debris shards
  for (let i = activeShards.length - 1; i >= 0; i--) {
    const s = activeShards[i];
    s.age += clampedDt;
    if (s.age >= s.maxAge) {
      s.mesh.removeFromParent();
      s.geo.dispose();
      s.mat.dispose();
      activeShards.splice(i, 1);
      continue;
    }

    s.vel.y -= 18.5 * clampedDt;
    s.mesh.position.x += s.vel.x * clampedDt;
    s.mesh.position.y += s.vel.y * clampedDt;
    s.mesh.position.z += s.vel.z * clampedDt;

    if (s.mesh.position.y < 0.08) {
      s.mesh.position.y = 0.08;
      s.vel.y = Math.abs(s.vel.y) * 0.34;
      s.vel.x *= 0.72;
      s.vel.z *= 0.72;
    }

    s.mesh.rotation.x += s.rotVel.x * clampedDt;
    s.mesh.rotation.y += s.rotVel.y * clampedDt;
    s.mesh.rotation.z += s.rotVel.z * clampedDt;

    const lifeFrac = s.age / s.maxAge;
    s.mat.emissiveIntensity = Math.max(0, 0.55 * (1 - lifeFrac * 1.4));
    if (lifeFrac > 0.72) {
      const shrink = Math.max(0.01, (1 - lifeFrac) / 0.28);
      s.mesh.scale.setScalar(shrink);
    }
  }
}

export function findNearbyDoorSwitch(
  pos: Vec3,
  maxDist = DEFAULT_SWITCH_INTERACT_DIST_M
): { doorId: string; label: string; action: 'CLOSE' | 'OPEN' } | null {
  let bestDoor: DoorRuntimeState | null = null;
  let bestDistSq = maxDist * maxDist;

  for (const d of doorStates) {
    if (d.status === 'broken') continue;
    const sw = d.def.switchPos;
    const dy = Math.abs(pos.y + 1.1 - sw.y);
    if (dy > 2.2) continue;

    const dx = pos.x - sw.x;
    const dz = pos.z - sw.z;
    const d2 = dx * dx + dz * dz;
    if (d2 <= bestDistSq) {
      bestDistSq = d2;
      bestDoor = d;
    }
  }

  if (!bestDoor) return null;
  return {
    doorId: bestDoor.def.id,
    label: bestDoor.def.label,
    action: bestDoor.status === 'open' ? 'CLOSE' : 'OPEN',
  };
}

// ---------------------------------------------------------------------------
// Scene Visual Helpers: Site Holograms, Spike Pedestal, Fallback & Buy Barriers
// ---------------------------------------------------------------------------

function decalMat(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
  });
}

function glowMat(color: number, opacity = 1, additive = false): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1 || additive,
    opacity,
    depthWrite: !(opacity < 1 || additive),
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: additive ? THREE.DoubleSide : THREE.FrontSide,
    toneMapped: false,
  });
}

function createSiteLetterTexture(letter: string, color: number, ring: boolean): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const css = `#${color.toString(16).padStart(6, '0')}`;
  ctx.clearRect(0, 0, 256, 256);
  if (ring) {
    ctx.fillStyle = 'rgba(10, 14, 22, 0.58)';
    ctx.beginPath();
    ctx.arc(128, 128, 108, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 12;
    ctx.strokeStyle = css;
    ctx.shadowColor = css;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(128, 128, 104, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.shadowColor = css;
  ctx.shadowBlur = 22;
  ctx.fillStyle = ring ? '#ffffff' : css;
  ctx.font = 'bold 170px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, 128, 138);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.userData.ownedByArenaScene = true;
  return tex;
}

function buildSiteHologramsAndPedestalBeam(root: THREE.Group): void {
  const siteDefs: ReadonlyArray<{ id: BombSiteId; color: number }> = [
    { id: 'A', color: COLOR_SITE_A },
    { id: 'B', color: COLOR_SITE_B },
  ];

  for (const def of siteDefs) {
    const zone = ASCENT_MAP_DATA.bombSites[def.id];
    const floorTex = createSiteLetterTexture(def.id, def.color, false);
    if (floorTex) {
      const letterMat = decalMat(0xffffff, 0.76);
      letterMat.map = floorTex;
      const letter = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.6), letterMat);
      letter.rotation.x = -Math.PI / 2;
      letter.position.set(zone.center.x, zone.center.y + 0.022, zone.center.z);
      letter.renderOrder = 4;
      root.add(letter);
    }

    const holoTex = createSiteLetterTexture(def.id, def.color, true);
    if (holoTex) {
      const spriteMat = new THREE.SpriteMaterial({
        map: holoTex,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(spriteMat);
      sprite.scale.set(1.75, 1.75, 1);
      sprite.position.set(zone.center.x, 5.1, zone.center.z);
      sprite.renderOrder = 5;
      root.add(sprite);
    }
  }

  // Pulsing energy ring & vertical column above the T-Spawn Spike Pedestal
  const ped = ASCENT_MAP_DATA.spawns.spikePedestal;
  const pedGroup = new THREE.Group();
  pedGroup.position.set(ped.x, 0, ped.z);

  const ringMat = decalMat(COLOR_RADIANITE, 0.92);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.54, 0.68, 6, 1, Math.PI / 6), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = ped.y + 0.022;
  ring.renderOrder = 4;
  pedGroup.add(ring);

  const beamMat = glowMat(COLOR_RADIANITE, 0.1, true);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.66, 1.6, 6, 1, true), beamMat);
  beam.position.y = ped.y + 0.8;
  beam.renderOrder = 6;
  beam.onBeforeRender = () => {
    const t = nowSeconds();
    beamMat.opacity = 0.07 + 0.05 * (0.5 + 0.5 * Math.sin(t * 2.6));
    ringMat.opacity = 0.72 + 0.22 * (0.5 + 0.5 * Math.sin(t * 2.6 + 1.1));
  };
  pedGroup.add(beam);

  root.add(pedGroup);
}

/**
 * Lightweight merged fallback boxes shown immediately on boot (or headless)
 * and hidden seamlessly the instant `/models/ascent_map.glb` swaps in.
 */
function buildProceduralFallbackGroup(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'ascent-procedural-fallback';

  const wallGeos: THREE.BufferGeometry[] = [];
  const floorGeos: THREE.BufferGeometry[] = [];
  const coverGeos: THREE.BufferGeometry[] = [];

  for (const c of ASCENT_MAP_DATA.colliders) {
    const sx = c.max.x - c.min.x;
    const sy = c.max.y - c.min.y;
    const sz = c.max.z - c.min.z;
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    geo.translate((c.min.x + c.max.x) * 0.5, (c.min.y + c.max.y) * 0.5, (c.min.z + c.max.z) * 0.5);
    if (c.tag === 'floor') floorGeos.push(geo);
    else if (c.tag === 'cover') coverGeos.push(geo);
    else wallGeos.push(geo);
  }

  const addBatch = (
    geos: THREE.BufferGeometry[],
    color: number,
    roughness: number,
    castShadow: boolean
  ) => {
    if (geos.length === 0) return;
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (geos.length > 1) {
      for (const g of geos) g.dispose();
    }
    if (!merged) return;
    const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.08 });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  addBatch(floorGeos, 0xb8ad9c, 0.9, false);
  addBatch(wallGeos, 0xe4d5c0, 0.85, true);
  addBatch(coverGeos, 0x2f6b6d, 0.55, true);

  // Fallback interactive door panels & switches
  for (const d of doorStates) {
    const { min, max } = d.def.bounds;
    const pMat = new THREE.MeshStandardMaterial({ color: 0x4b5868, roughness: 0.4, metalness: 0.72 });
    const pMesh = new THREE.Mesh(
      new THREE.BoxGeometry(max.x - min.x, max.y - min.y, max.z - min.z),
      pMat
    );
    pMesh.position.set(d.def.center.x, d.def.center.y, d.def.center.z);
    pMesh.castShadow = true;
    pMesh.receiveShadow = true;
    group.add(pMesh);

    const sMat = new THREE.MeshStandardMaterial({
      color: COLOR_SWITCH_OPEN,
      roughness: 0.3,
      emissive: COLOR_SWITCH_OPEN,
      emissiveIntensity: 1.8,
    });
    const sMesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.36, 0.28), sMat);
    sMesh.position.set(d.def.switchPos.x, d.def.switchPos.y, d.def.switchPos.z);
    group.add(sMesh);

    d.fallbackPanel = pMesh;
    d.fallbackPanelMat = pMat;
    d.fallbackSwitchMat = sMat;
    applyDoorVisualState(d);
  }

  return group;
}

/**
 * Enhances loaded Blender Principled BSDF materials with subtle cached procedural
 * micro-bump maps and binds `DoorPanel_<id>` + `DoorSwitch_<id>`.
 */
function bindLoadedAscentGlb(gltfRoot: THREE.Group, fallbackGroup: THREE.Group): void {
  const stoneBump = getArenaTexture('sandstone_ashlar').bumpMap;
  const plazaBump = getArenaTexture('plaza_concrete').bumpMap;
  const crateBump = getArenaTexture('radianite_crate').bumpMap;

  gltfRoot.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const isFloorGroup = obj.parent?.name === 'Ascent_Floors' || obj.name.startsWith('Ascent_Floors');
    obj.castShadow = !isFloorGroup;
    obj.receiveShadow = true;

    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const mat of mats) {
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
      if (mat.bumpMap) continue;
      const mName = mat.name || '';
      if (mName.includes('Plaster') || mName.includes('Brick') || mName.includes('Limestone')) {
        if (stoneBump) {
          mat.bumpMap = stoneBump;
          mat.bumpScale = 0.28;
          mat.needsUpdate = true;
        }
      } else if (mName.includes('Floor') || mName.includes('Cobble') || mName.includes('Slate')) {
        if (plazaBump) {
          mat.bumpMap = plazaBump;
          mat.bumpScale = 0.24;
          mat.needsUpdate = true;
        }
      } else if (mName.includes('Radianite') || mName.includes('BlastSteel')) {
        if (crateBump) {
          mat.bumpMap = crateBump;
          mat.bumpScale = 0.22;
          mat.needsUpdate = true;
        }
      }
    }
  });

  // Bind interactive DoorPanel_<id> & DoorSwitch_<id> with cloned instance materials
  for (const d of doorStates) {
    const panelNode = gltfRoot.getObjectByName(`DoorPanel_${d.def.id}`) ?? null;
    const switchNode = gltfRoot.getObjectByName(`DoorSwitch_${d.def.id}`) ?? null;
    d.glbPanel = panelNode;
    d.glbPanelMats = [];
    d.glbSwitchMats = [];

    if (panelNode) {
      panelNode.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.castShadow = true;
        child.receiveShadow = true;
        if (Array.isArray(child.material)) {
          child.material = child.material.map((m) => {
            const cloned = m.clone();
            if (cloned instanceof THREE.MeshStandardMaterial) d.glbPanelMats.push(cloned);
            return cloned;
          });
        } else if (child.material) {
          const cloned = child.material.clone();
          child.material = cloned;
          if (cloned instanceof THREE.MeshStandardMaterial) d.glbPanelMats.push(cloned);
        }
      });
    }

    if (switchNode) {
      switchNode.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.castShadow = false;
        child.receiveShadow = false;
        if (Array.isArray(child.material)) {
          child.material = child.material.map((m) => {
            const cloned = m.clone();
            if (cloned instanceof THREE.MeshStandardMaterial) d.glbSwitchMats.push(cloned);
            return cloned;
          });
        } else if (child.material) {
          const cloned = child.material.clone();
          child.material = cloned;
          if (cloned instanceof THREE.MeshStandardMaterial) d.glbSwitchMats.push(cloned);
        }
      });
    }

    applyDoorVisualState(d);
  }

  // Completely hide & exclude procedural fallback geometry from rendering, shadows, and raycasting
  fallbackGroup.visible = false;
  fallbackGroup.traverse((child) => {
    child.visible = false;
    if (child instanceof THREE.Mesh) {
      child.castShadow = false;
      child.receiveShadow = false;
      child.raycast = () => {};
    }
  });
}

/**
 * Opaque armored hex-grid Buy-Phase Setup Barriers across all 11 Valorant-style
 * Attacker & Defender forward chokes using `getBuyBarrierTexture()`.
 */
function buildBuyBarriers(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'buy-phase-barriers';
  const hex = getBuyBarrierTexture();
  const uvRepeatM = 1.6;
  const baseAttackColor = new THREE.Color(COLOR_BARRIER_ATTACK);
  const baseDefendColor = new THREE.Color(COLOR_BARRIER_DEFEND);

  const sideMatByTeam: Record<'attacker' | 'defender', THREE.MeshBasicMaterial> = {
    attacker: new THREE.MeshBasicMaterial({
      color: COLOR_BARRIER_ATTACK,
      transparent: false,
      opacity: 1.0,
      side: THREE.DoubleSide,
      depthWrite: true,
      toneMapped: false,
    }),
    defender: new THREE.MeshBasicMaterial({
      color: COLOR_BARRIER_DEFEND,
      transparent: false,
      opacity: 1.0,
      side: THREE.DoubleSide,
      depthWrite: true,
      toneMapped: false,
    }),
  };

  for (const side of ['attacker', 'defender'] as const) {
    if (hex.map) sideMatByTeam[side].map = hex.map;
  }

  const railMats: Record<'attacker' | 'defender', THREE.MeshBasicMaterial> = {
    attacker: glowMat(COLOR_BARRIER_ATTACK),
    defender: glowMat(COLOR_BARRIER_DEFEND),
  };

  // Frame-deduplicated animation callback attached to EVERY curtain so frustum culling never freezes UV scrolling
  let lastAnimTime = -1;
  const animateBarriers = () => {
    const t = nowSeconds();
    if (t === lastAnimTime) return;
    lastAnimTime = t;
    sideMatByTeam.attacker.color
      .copy(baseAttackColor)
      .multiplyScalar(0.92 + 0.12 * Math.sin(t * 2.4));
    sideMatByTeam.defender.color
      .copy(baseDefendColor)
      .multiplyScalar(0.92 + 0.12 * Math.sin(t * 2.4 + 1.7));
    if (hex.map) hex.map.offset.set((t * 0.015) % 1, (t * 0.11) % 1);
  };

  ASCENT_MAP_DATA.buyBarrierSpans.forEach((span) => {
    const axis = span.axis ?? 'z';
    const h = span.height;
    const curtainMat = sideMatByTeam[span.side];
    const railMat = railMats[span.side];

    if (axis === 'x') {
      const cx = span.x ?? 0;
      const zMin = Math.min(span.z0 ?? 0, span.z1 ?? 0);
      const zMax = Math.max(span.z0 ?? 0, span.z1 ?? 0);
      const w = Math.max(0.2, zMax - zMin - 0.06);
      const cz = (zMin + zMax) * 0.5;

      const geo = new THREE.PlaneGeometry(w, h);
      const uv = geo.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, (uv.getX(i) * w) / uvRepeatM, (uv.getY(i) * h) / uvRepeatM);
      }
      uv.needsUpdate = true;

      const curtain = new THREE.Mesh(geo, curtainMat);
      curtain.rotation.y = Math.PI / 2;
      curtain.position.set(cx, span.baseY + h * 0.5, cz);
      curtain.renderOrder = 7;
      curtain.onBeforeRender = animateBarriers;
      group.add(curtain);

      const floorBar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, w), railMat);
      floorBar.position.set(cx, span.baseY + 0.042, cz);
      group.add(floorBar);

      const topBar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, w), railMat);
      topBar.position.set(cx, span.baseY + h - 0.025, cz);
      group.add(topBar);

      for (const postZ of [zMin + 0.05, zMax - 0.05]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.11, h, 0.08), railMat);
        post.position.set(cx, span.baseY + h * 0.5, postZ);
        group.add(post);
      }
      return;
    }

    const cz = span.z ?? 0;
    const xMin = Math.min(span.x0 ?? 0, span.x1 ?? 0);
    const xMax = Math.max(span.x0 ?? 0, span.x1 ?? 0);
    const w = Math.max(0.2, xMax - xMin - 0.06);
    const cx = (xMin + xMax) * 0.5;

    const geo = new THREE.PlaneGeometry(w, h);
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getX(i) * w) / uvRepeatM, (uv.getY(i) * h) / uvRepeatM);
    }
    uv.needsUpdate = true;

    const curtain = new THREE.Mesh(geo, curtainMat);
    curtain.position.set(cx, span.baseY + h * 0.5, cz);
    curtain.renderOrder = 7;
    curtain.onBeforeRender = animateBarriers;
    group.add(curtain);

    // Emitter floor strip (bottom strictly above 0.016m inlays) & side posts framing each barrier span
    const floorBar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, 0.12), railMat);
    floorBar.position.set(cx, span.baseY + 0.042, cz);
    group.add(floorBar);

    const topBar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, 0.1), railMat);
    topBar.position.set(cx, span.baseY + h - 0.025, cz);
    group.add(topBar);

    for (const postX of [xMin + 0.05, xMax - 0.05]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, h, 0.11), railMat);
      post.position.set(postX, span.baseY + h * 0.5, cz);
      group.add(post);
    }
  });

  return group;
}

export function setArenaBuyBarriersVisible(visible: boolean): void {
  barriersVisible = visible;
  syncDynamicColliders();
  if (!arenaRoot) return;
  if (!barrierGroup) {
    barrierGroup = buildBuyBarriers();
    arenaRoot.add(barrierGroup);
  }
  barrierGroup.visible = visible;
}

// ---------------------------------------------------------------------------
// Clean Disposal & Scene Construction
// ---------------------------------------------------------------------------

function disposeObjectTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const ownedTextures = new Set<THREE.Texture>();

  const collectMat = (mat: THREE.Material) => {
    materials.add(mat);
    for (const val of Object.values(mat)) {
      if (val instanceof THREE.Texture && val.userData?.ownedByArenaScene) {
        ownedTextures.add(val);
      }
    }
  };

  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
      geometries.add(obj.geometry);
      if (Array.isArray(obj.material)) {
        for (const m of obj.material) collectMat(m);
      } else if (obj.material) {
        collectMat(obj.material);
      }
    } else if (obj instanceof THREE.Sprite) {
      collectMat(obj.material);
    } else if (obj instanceof THREE.DirectionalLight) {
      obj.shadow.dispose();
    }
  });

  for (const g of geometries) g.dispose();
  for (const t of ownedTextures) t.dispose();
  for (const m of materials) m.dispose();
  root.removeFromParent();
}

function clearDoorSceneRefs(): void {
  for (const d of doorStates) {
    d.glbPanel = null;
    d.glbPanelMats = [];
    d.glbSwitchMats = [];
    d.fallbackPanel = null;
    d.fallbackPanelMat = null;
    d.fallbackSwitchMat = null;
  }
}

/**
 * Builds the complete sunlit Venetian "Ascent" 3D S&D arena (`84m x 92m`),
 * mounting `/models/ascent_map.glb` via `loadOptionalGlbAsset`, configuring
 * real-time directional PCF shadows, interactive Blast Doors, holographic
 * Bomb Site markers, Spike Pedestal beam, and Buy-Phase setup curtains.
 */
export function buildArenaScene(scene: THREE.Scene, _legacyGrid?: string[]): void {
  clearDebrisShards();
  clearDoorSceneRefs();

  if (arenaRoot) {
    disposeObjectTree(arenaRoot);
    arenaRoot = null;
    barrierGroup = null;
    shatterGroup = null;
  }

  scene.background = new THREE.Color(COLOR_SKY_BG);
  scene.fog = new THREE.Fog(COLOR_SKY_BG, 108, 255);

  const root = new THREE.Group();
  root.name = 'chroma-ascent-glb-root';

  // Warm Mediterranean sunlit key light + Adriatic sky hemisphere + north bounce fill
  const hemiLight = new THREE.HemisphereLight(0xf3f7ff, 0x6e6456, 1.08);
  root.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xfff1d6, 1.82);
  sunLight.position.set(30, 52, 24);
  sunLight.target.position.set(0, 0, -6);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  const shadowCam = sunLight.shadow.camera;
  shadowCam.left = -52;
  shadowCam.right = 52;
  shadowCam.top = 52;
  shadowCam.bottom = -52;
  shadowCam.near = 4;
  shadowCam.far = 138;
  shadowCam.updateProjectionMatrix();
  sunLight.shadow.bias = -0.00035;
  sunLight.shadow.normalBias = 0.02;
  root.add(sunLight);
  root.add(sunLight.target);

  const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.44);
  fillLight.position.set(-24, 24, -28);
  root.add(fillLight);

  const fallbackGroup = buildProceduralFallbackGroup();
  root.add(fallbackGroup);

  shatterGroup = new THREE.Group();
  shatterGroup.name = 'blast-door-shatter-shards';
  root.add(shatterGroup);

  buildSiteHologramsAndPedestalBeam(root);

  barrierGroup = buildBuyBarriers();
  barrierGroup.visible = barriersVisible;
  root.add(barrierGroup);

  scene.add(root);
  arenaRoot = root;

  // Asynchronously mount `/models/ascent_map.glb` & bind interactive Blast Door nodes
  loadOptionalGlbAsset('/models/ascent_map.glb', (gltfRoot) => {
    if (arenaRoot !== root) {
      disposeObjectTree(gltfRoot);
      return;
    }
    gltfRoot.name = 'ascent-blender-glb-scene';
    root.add(gltfRoot);
    bindLoadedAscentGlb(gltfRoot, fallbackGroup);
  });
}

export function rebuildArenaScene(scene: THREE.Scene, _legacyGrid?: string[]): void {
  buildArenaScene(scene, _legacyGrid);
}
