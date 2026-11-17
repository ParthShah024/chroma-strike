import * as THREE from 'three';
import {
  AABB,
  AGENT_PALETTES,
  AbilityAudioEvent,
  AbilityFrameFeedback,
  AbilityHudSlotState,
  AbilityProjectile,
  AbilitySlot,
  ActiveZone,
  AgentColorId,
  Combatant,
  InputState,
  MovementModifiers,
  PlayerState,
  ProjectileKind,
  SmokeSphere,
  TeamId,
  Vec3,
  ZoneKind,
} from '../core/types';
import {
  EYE_HEIGHT,
  RUN_SPEED,
  getLookDirection,
  raycastAABB,
  stepProjectile,
} from '../physics/movement';
import { TargetsManager } from '../combat/targets';
import { AGENT_ABILITIES } from './definitions';
import {
  createCryoFieldMaterial,
  createFireZoneMaterial,
  createFlameWallMaterial,
  createSmokeDomeMaterial,
} from './shaders';

/**
 * Public contract for the Chroma Strike ability orchestrator.
 *
 * The system decouples input-triggered casting (`cast`) from per-frame simulation
 * (`update`) so that movement, target AI, weapon fire-rate/recoil modifiers,
 * procedural WebAudio cues, and HUD overlays all receive a single coherent
 * `AbilityFrameFeedback` snapshot.
 */
export interface AbilitySystem {
  cast(slot: AbilitySlot, player: PlayerState, input: InputState): boolean;
  castForBot(
    slot: AbilitySlot,
    bot: Combatant,
    aimYaw: number,
    aimPitch: number
  ): boolean;
  resetRound(): void;
  update(
    dt: number,
    player: PlayerState,
    input: InputState,
    colliders: AABB[],
    targetsMgr: TargetsManager,
    allCombatants?: Combatant[]
  ): AbilityFrameFeedback;
}

// ---------------------------------------------------------------------------
// Ability Tuning Constants (Metric FPS Scale: 1 unit = 1 meter)
// ---------------------------------------------------------------------------

// Red — Blaze (Duelist)
const DASH_DURATION_SEC = 0.24;
const DASH_PEAK_SPEED_MPS = 30.0;
const DASH_END_SPEED_MPS = RUN_SPEED; // 8.2 m/s seamless handoff into ground sprint
const BOT_DASH_DURATION_SEC = 0.22;
const BOT_DASH_SPEED_MPS = 24.0;
const DASH_TRAIL_DURATION_SEC = 0.34;
const DASH_TUNNEL_STREAK_COUNT = 14;

const FIRE_ORB_SPEED = 19.5;
const FIRE_ORB_GRAVITY = 18.0;
const FIRE_ORB_RESTITUTION = 0.55;
const FIRE_ORB_UPWARD_LOB = 0.14;
const FIRE_ZONE_RADIUS = 3.8;
const FIRE_ZONE_DURATION_SEC = 5.0;
const FIRE_TARGET_DPS = 45.0;
const FIRE_PLAYER_SELF_DPS = 15.0;
const FIRE_ALLY_SELF_DPS = 12.0;
const FIRE_PLAYER_MIN_HP = 10.0;
const FIRE_EMBER_COUNT = 28;

// Blue — Mist (Controller)
const SMOKE_ORB_SPEED = 24.0;
const SMOKE_ORB_GRAVITY = 14.0;
const SMOKE_ORB_RESTITUTION = 0.5;
const SMOKE_ORB_UPWARD_LOB = 0.10;
const SMOKE_RADIUS = 4.2;
const SMOKE_DURATION_SEC = 8.5;
const SMOKE_BLOOM_SEC = 0.2;
const SMOKE_DISSOLVE_SEC = 0.45;
const SMOKE_CENTER_Y_OFFSET = 1.6; // Embeds bottom of 4.2m sphere solidly below y = 0
const SMOKE_SEAM_BAND_M = 0.38;
const SMOKE_INTERIOR_TINT = 0.22;
const SMOKE_SHELL_PEAK_TINT = 0.98;
const SMOKE_SHOCKWAVE_DURATION_SEC = 0.38;

const SLOW_ORB_SPEED = 20.0;
const SLOW_ORB_GRAVITY = 18.0;
const SLOW_ORB_RESTITUTION = 0.5;
const SLOW_ORB_UPWARD_LOB = 0.12;
const SLOW_ZONE_RADIUS = 4.5;
const SLOW_ZONE_DURATION_SEC = 5.5;
const SLOW_TARGET_STATUS_REFRESH_SEC = 0.3;
const SLOW_PLAYER_SPEED_MULT = 0.50;
const SLOW_SPIKE_COUNT = 14;
const SLOW_SPIKE_ERUPT_SEC = 0.18;

// Green — Pulse (Initiator)
const FLASH_ORB_SPEED = 18.5;
const FLASH_ORB_GRAVITY = 12.0;
const FLASH_ORB_RESTITUTION = 0.68;
const FLASH_FUSE_SEC = 0.65;
const FLASH_WARN_SEC = 0.42;
const FLASH_BURST_DURATION_SEC = 0.32;
const FLASH_MAX_RANGE_M = 22.0;
const FLASH_TARGET_BLIND_SEC = 3.2;
const FLASH_PLAYER_LOOK_COS_THRESHOLD = 0.20;
const FLASH_PLAYER_FULL_SEC = 1.45;
const FLASH_PLAYER_GLINT_SEC = 0.20;

const BEACON_RADIUS = 4.2;
const BEACON_DURATION_SEC = 5.0;
const BEACON_HEAL_PER_SEC = 24.0;
const BEACON_SPEED_MULT = 1.25;
const BEACON_FIRE_RATE_MULT = 1.35;
const BEACON_RECOIL_MULT = 0.65;
const BEACON_MOTE_COUNT = 22;

const PROJECTILE_SPAWN_FORWARD_OFFSET = 0.28;
const PROJECTILE_SPAWN_VERTICAL_OFFSET = -0.06;
const ZONE_VERTICAL_TOLERANCE_M = 1.8;

// ---------------------------------------------------------------------------
// Internal Visual + Simulation Record Interfaces
// ---------------------------------------------------------------------------

interface ProjectileEntry {
  data: AbilityProjectile;
  team: TeamId;
  group: THREE.Group;
  auraMesh?: THREE.Mesh;
  auraMat?: THREE.MeshBasicMaterial;
  warned: boolean;
}

interface ParticleStream {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.PointsMaterial;
  positions: Float32Array;
  radii: Float32Array;
  angles: Float32Array;
  speeds: Float32Array;
  phases: Float32Array;
  count: number;
}

interface ZoneVisualHandles {
  group: THREE.Group;
  smokeMat?: THREE.ShaderMaterial;
  fireDiscMat?: THREE.ShaderMaterial;
  flameWallMat?: THREE.ShaderMaterial;
  cryoMat?: THREE.ShaderMaterial;
  spikeGroup?: THREE.Group;
  spikeMat?: THREE.MeshBasicMaterial;
  rimMat?: THREE.MeshBasicMaterial;
  coreMesh?: THREE.Mesh;
  coreMat?: THREE.MeshBasicMaterial;
  wallMat?: THREE.MeshBasicMaterial;
  sonarMeshes?: THREE.Mesh[];
  sonarMats?: THREE.MeshBasicMaterial[];
  particles?: ParticleStream;
}

interface ZoneEntry {
  data: ActiveZone;
  team: TeamId;
  visual: ZoneVisualHandles;
}

interface BotDashEntry {
  combatant: Combatant;
  timer: number;
  dir: Vec3;
}

interface TransientBurst {
  kind: 'dash_tunnel' | 'smoke_shockwave' | 'flash_burst';
  group: THREE.Group;
  materials: THREE.Material[];
  age: number;
  duration: number;
}

// ---------------------------------------------------------------------------
// Pure Vector & Smoothstep Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function dotVec3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalizeVec3(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len <= 1e-6) {
    return { x: 0, y: 0, z: -1 };
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * Hermite smoothstep interpolation (`3t^2 - 2t^3`) over `t in [0, 1]`.
 * Used for `smoothstep` shell masking when the camera eye crosses the opaque
 * Smoke Dome boundary, ensuring C1-continuous opacity transitions with zero pop.
 */
function smoothstep01(t: number): number {
  const u = clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
}

/**
 * Computes the horizontal movement wish direction on the XZ plane from WASD + yaw.
 *
 * Mathematical basis:
 * - Forward unit vector in Three.js YXZ convention: `F = (-sin(yaw), 0, -cos(yaw))`.
 * - Right unit vector (90 deg clockwise on XZ): `R = (cos(yaw), 0, -sin(yaw))`.
 * - Combining `F * forwardInput + R * strafeInput` and normalizing guarantees
 *   unit length `||wish|| = 1` even on diagonals (W+D), falling back to `F` when idle.
 */
function computeDashDirection(input: InputState): Vec3 {
  const fx = -Math.sin(input.yaw);
  const fz = -Math.cos(input.yaw);
  const rx = Math.cos(input.yaw);
  const rz = -Math.sin(input.yaw);

  const forwardInput = (input.forward ? 1 : 0) - (input.backward ? 1 : 0);
  const strafeInput = (input.right ? 1 : 0) - (input.left ? 1 : 0);

  const wx = fx * forwardInput + rx * strafeInput;
  const wz = fz * forwardInput + rz * strafeInput;
  const len = Math.hypot(wx, wz);

  if (len > 1e-6) {
    return { x: wx / len, y: 0, z: wz / len };
  }
  return { x: fx, y: 0, z: fz };
}

/**
 * Checks whether an unobstructed line of sight exists between `from` and `to`
 * against static arena AABB colliders.
 *
 * Shrinking `maxDist` by `0.05m` prevents a flash orb resting within `0.03m`
 * of a wall or floor from falsely occluding itself against that surface.
 */
function hasLineOfSight(from: Vec3, to: Vec3, colliders: AABB[]): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);

  if (dist < 1e-4) {
    return true;
  }

  const dir: Vec3 = { x: dx / dist, y: dy / dist, z: dz / dist };
  const checkDist = Math.max(0, dist - 0.05);

  for (const box of colliders) {
    if (raycastAABB(from, dir, box, checkDist) !== null) {
      return false;
    }
  }
  return true;
}

/**
 * Removes a Three.js object hierarchy from the scene and explicitly disposes every
 * BufferGeometry and Material across Meshes, Lines, and `THREE.Points` buffers
 * so repeated ability casts cause zero GPU memory leaks.
 */
function disposeObject3D(scene: THREE.Scene, root: THREE.Object3D): void {
  scene.remove(root);
  root.traverse((node) => {
    if (
      node instanceof THREE.Mesh ||
      node instanceof THREE.LineSegments ||
      node instanceof THREE.Line ||
      node instanceof THREE.Points
    ) {
      node.geometry.dispose();
      if (Array.isArray(node.material)) {
        for (const mat of node.material) {
          mat.dispose();
        }
      } else if (node.material) {
        node.material.dispose();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Pooled Float32Array Particle Kinematics Helper
// ---------------------------------------------------------------------------

/**
 * Allocates a pooled `THREE.Points` emitter backed by fixed-length `Float32Array`
 * buffers (`positions` + cylindrical kinematics `radii`, `angles`, `speeds`, `phases`).
 *
 * Why typed arrays instead of per-particle JS objects?
 * `BufferAttribute` directly wraps the `Float32Array` for WebGL upload; updating
 * coordinates in place and setting `needsUpdate = true` achieves O(N) particle
 * motion with zero garbage collection pressure per frame.
 */
function createParticleStream(
  count: number,
  maxRadius: number,
  colorHex: number,
  pointSize: number,
  minSpeed: number,
  maxSpeed: number
): ParticleStream {
  const positions = new Float32Array(count * 3);
  const radii = new Float32Array(count);
  const angles = new Float32Array(count);
  const speeds = new Float32Array(count);
  const phases = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Golden-ratio radial distribution avoids clustering near the center
    const u = (i + 0.5) / count;
    radii[i] = maxRadius * (0.18 + 0.78 * Math.sqrt(u));
    angles[i] = i * 2.3999632; // Golden angle in radians (~137.5 deg)
    speeds[i] = minSpeed + ((i * 0.6180339) % 1) * (maxSpeed - minSpeed);
    phases[i] = (i / count) % 1;

    const idx = i * 3;
    positions[idx] = Math.cos(angles[i]) * radii[i];
    positions[idx + 1] = 0.05;
    positions[idx + 2] = Math.sin(angles[i]) * radii[i];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: colorHex,
    size: pointSize,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  return {
    points,
    geometry,
    material,
    positions,
    radii,
    angles,
    speeds,
    phases,
    count,
  };
}

/**
 * Steps a `ParticleStream` in-place along helical cylindrical trajectories:
 *   `x(t) = r * cos(theta_0 + omega * t)`
 *   `y(t) = y_min + frac(phase + speed * t) * height`
 *   `z(t) = r * sin(theta_0 + omega * t)`
 */
function updateParticleStream(
  stream: ParticleStream,
  elapsed: number,
  minY: number,
  height: number,
  swirlRate: number,
  opacity: number
): void {
  const { positions, radii, angles, speeds, phases, count } = stream;
  for (let i = 0; i < count; i++) {
    const life = (phases[i] + elapsed * speeds[i]) % 1;
    const theta = angles[i] + life * swirlRate;
    const r = radii[i] * (1.0 - life * 0.18);
    const idx = i * 3;
    positions[idx] = Math.cos(theta) * r;
    positions[idx + 1] = minY + life * height;
    positions[idx + 2] = Math.sin(theta) * r;
  }
  const posAttr = stream.geometry.getAttribute('position') as THREE.BufferAttribute;
  posAttr.needsUpdate = true;
  stream.material.opacity = opacity;
}

// ---------------------------------------------------------------------------
// Ability System Factory
// ---------------------------------------------------------------------------

/**
 * Creates the upgraded Chapter 2 Ability System managing all 6 agent abilities
 * with custom GLSL shaders, pooled `Float32Array` particle emitters, cubic
 * ease-out dash physics, hollow opaque smoke seam-masking, and audio event cues.
 */
export function createAbilitySystem(scene: THREE.Scene): AbilitySystem {
  let nextEntityId = 1;

  // Independent per-agent cooldown pools so swapping colors preserves cooldown timers.
  const cooldowns: Record<AgentColorId, { q: number; e: number }> = {
    red: { q: 0, e: 0 },
    blue: { q: 0, e: 0 },
    green: { q: 0, e: 0 },
  };
  const botCooldowns = new Map<string, { q: number; e: number }>();
  const botDashes = new Map<string, BotDashEntry>();

  function getOrInitBotCooldowns(botId: string): { q: number; e: number } {
    let cd = botCooldowns.get(botId);
    if (!cd) {
      cd = { q: 0, e: 0 };
      botCooldowns.set(botId, cd);
    }
    return cd;
  }

  const projectiles: ProjectileEntry[] = [];
  const zones: ZoneEntry[] = [];
  const bursts: TransientBurst[] = [];
  const pendingAudioEvents: AbilityAudioEvent[] = [];

  // Active Red Q dash state
  let dashTimer = 0;
  let dashDir: Vec3 = { x: 0, y: 0, z: -1 };

  // Active Green Q player blind state
  let playerFlashTimer = 0;

  // -------------------------------------------------------------------------
  // 3D VFX Builders
  // -------------------------------------------------------------------------

  /**
   * Builds a forward 3D Dash Wind Tunnel ahead of the player (`14` glowing
   * crimson-white streak boxes distributed `0.8m..5.5m` along `dir` around
   * `y + 1.1..1.8` outside the center crosshair) so speed lines visibly whip
   * past the camera during the `0.24s` dash.
   */
  function createDashTunnelVisual(origin: Vec3, dir: Vec3): TransientBurst {
    const group = new THREE.Group();
    group.position.set(origin.x, origin.y, origin.z);
    // Align local +Z with horizontal dashDir so group Z-scaling stretches along the dash axis
    group.rotation.y = Math.atan2(dir.x, dir.z);

    const crimsonMat = new THREE.MeshBasicMaterial({
      color: AGENT_PALETTES.red.hex,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    const whiteStreakMat = new THREE.MeshBasicMaterial({
      color: 0xffd6de,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });

    for (let i = 0; i < DASH_TUNNEL_STREAK_COUNT; i++) {
      const t = i / (DASH_TUNNEL_STREAK_COUNT - 1);
      const forwardDist = 0.8 + t * 4.7; // 0.8m .. 5.5m ahead
      // Golden-angle peripheral ring keeps streaks outside the center crosshair
      const theta = i * 2.3999632;
      const radialOffset = 0.62 + (i % 3) * 0.24;
      const lateral = Math.cos(theta) * radialOffset;
      const yPos = 1.45 + Math.sin(theta) * 0.35; // strictly within y + 1.1 .. 1.8

      const streakLen = 0.75 + (i % 3) * 0.32;
      const boxGeo = new THREE.BoxGeometry(0.036, 0.036, streakLen);
      const mat = i % 2 === 0 ? crimsonMat : whiteStreakMat;
      const mesh = new THREE.Mesh(boxGeo, mat);

      mesh.position.set(lateral, yPos, forwardDist);
      group.add(mesh);
    }

    const ringGeo = new THREE.TorusGeometry(0.68, 0.045, 10, 28);
    const ringMat = new THREE.MeshBasicMaterial({
      color: AGENT_PALETTES.red.hex,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(0, 1.3, 0.6);
    group.add(ring);

    scene.add(group);
    return {
      kind: 'dash_tunnel',
      group,
      materials: [crimsonMat, whiteStreakMat, ringMat],
      age: 0,
      duration: DASH_TRAIL_DURATION_SEC,
    };
  }

  function createSmokeShockwaveVisual(origin: Vec3): TransientBurst {
    const group = new THREE.Group();
    group.position.set(origin.x, origin.y + 0.05, origin.z);

    const ringGeo = new THREE.RingGeometry(0.75, 1.0, 44);
    ringGeo.rotateX(-Math.PI * 0.5);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x7ae9ff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    group.add(new THREE.Mesh(ringGeo, ringMat));
    group.scale.setScalar(0.35);

    scene.add(group);
    return {
      kind: 'smoke_shockwave',
      group,
      materials: [ringMat],
      age: 0,
      duration: SMOKE_SHOCKWAVE_DURATION_SEC,
    };
  }

  function createProjectileVisual(
    kind: ProjectileKind,
    colorId: AgentColorId,
    pos: Vec3
  ): { group: THREE.Group; auraMesh?: THREE.Mesh; auraMat?: THREE.MeshBasicMaterial } {
    const group = new THREE.Group();
    group.position.set(pos.x, pos.y, pos.z);

    const hex = AGENT_PALETTES[colorId].hex;
    const coreGeo = new THREE.SphereGeometry(0.14, 14, 12);
    const coreMat = new THREE.MeshBasicMaterial({
      color: kind === 'flash_orb' ? 0xd9ffe8 : hex,
    });
    group.add(new THREE.Mesh(coreGeo, coreMat));

    const shellGeo = new THREE.SphereGeometry(0.21, 12, 10);
    const shellMat = new THREE.MeshBasicMaterial({
      color: hex,
      wireframe: true,
      transparent: true,
      opacity: 0.72,
    });
    group.add(new THREE.Mesh(shellGeo, shellMat));

    if (kind === 'flash_orb') {
      const auraGeo = new THREE.SphereGeometry(0.28, 16, 12);
      const auraMat = new THREE.MeshBasicMaterial({
        color: 0x7effb2,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const auraMesh = new THREE.Mesh(auraGeo, auraMat);
      group.add(auraMesh);
      scene.add(group);
      return { group, auraMesh, auraMat };
    }

    scene.add(group);
    return { group };
  }

  function createZoneVisual(
    kind: ZoneKind,
    colorId: AgentColorId,
    center: Vec3,
    radius: number
  ): ZoneVisualHandles {
    const group = new THREE.Group();
    group.position.set(center.x, center.y, center.z);
    const hex = AGENT_PALETTES[colorId].hex;

    if (kind === 'smoke') {
      // 100% opaque Z-buffered DoubleSide shader sphere (true Valorant hollow smoke)
      const sphereGeo = new THREE.SphereGeometry(radius, 36, 24);
      const smokeMat = createSmokeDomeMaterial(hex);
      const sphereMesh = new THREE.Mesh(sphereGeo, smokeMat);
      group.add(sphereMesh);

      group.scale.setScalar(0.12);
      scene.add(group);
      return {
        group,
        smokeMat,
      };
    }

    if (kind === 'fire') {
      const discGeo = new THREE.CircleGeometry(radius, 44);
      discGeo.rotateX(-Math.PI * 0.5);
      const fireDiscMat = createFireZoneMaterial();
      const discMesh = new THREE.Mesh(discGeo, fireDiscMat);
      discMesh.position.y = 0.03;
      group.add(discMesh);

      // 0.95m-tall open-ended cylindrical flame crown scrolling upward
      const wallGeo = new THREE.CylinderGeometry(radius, radius * 0.96, 0.95, 48, 1, true);
      const flameWallMat = createFlameWallMaterial();
      const wallMesh = new THREE.Mesh(wallGeo, flameWallMat);
      wallMesh.position.y = 0.475;
      group.add(wallMesh);

      const particles = createParticleStream(
        FIRE_EMBER_COUNT,
        radius * 0.92,
        0xffaa33,
        0.14,
        0.55,
        1.15
      );
      group.add(particles.points);

      scene.add(group);
      return {
        group,
        fireDiscMat,
        flameWallMat,
        particles,
      };
    }

    if (kind === 'slow') {
      const discGeo = new THREE.CircleGeometry(radius, 48);
      discGeo.rotateX(-Math.PI * 0.5);
      const cryoMat = createCryoFieldMaterial();
      const discMesh = new THREE.Mesh(discGeo, cryoMat);
      discMesh.position.y = 0.025;
      group.add(discMesh);

      const rimGeo = new THREE.TorusGeometry(radius, 0.055, 8, 48);
      rimGeo.rotateX(Math.PI * 0.5);
      const rimMat = new THREE.MeshBasicMaterial({
        color: 0xa6f4ff,
        transparent: true,
        opacity: 0.84,
        depthWrite: false,
      });
      const rimMesh = new THREE.Mesh(rimGeo, rimMat);
      rimMesh.position.y = 0.045;
      group.add(rimMesh);

      // 14 angled 3D ice crystal spikes erupting from the floor over 0.18s
      const spikeGroup = new THREE.Group();
      const spikeMat = new THREE.MeshBasicMaterial({
        color: 0xbff7ff,
        transparent: true,
        opacity: 0.86,
      });
      for (let i = 0; i < SLOW_SPIKE_COUNT; i++) {
        const spikeGeo = new THREE.ConeGeometry(0.18, 0.58, 5);
        // Shift cone pivot to its base so scaling Y erupts cleanly from y = 0
        spikeGeo.translate(0, 0.29, 0);
        const spike = new THREE.Mesh(spikeGeo, spikeMat);

        const angle = i * 2.3999632;
        const rFrac = 0.28 + 0.65 * Math.sqrt((i + 0.5) / SLOW_SPIKE_COUNT);
        const dist = radius * rFrac;
        spike.position.set(Math.cos(angle) * dist, 0.02, Math.sin(angle) * dist);
        // Tilt slightly outward like shattered glacial shards
        spike.rotation.y = -angle;
        spike.rotation.z = -(0.18 + (i % 4) * 0.08);
        spike.rotation.x = ((i % 3) - 1) * 0.12;
        spikeGroup.add(spike);
      }
      spikeGroup.scale.set(1, 0.05, 1);
      group.add(spikeGroup);

      scene.add(group);
      return {
        group,
        cryoMat,
        rimMat,
        spikeGroup,
        spikeMat,
      };
    }

    // 'beacon' — Green E (Bio-Stim Beacon)
    const padGeo = new THREE.CylinderGeometry(0.44, 0.54, 0.1, 16);
    const padMat = new THREE.MeshStandardMaterial({
      color: 0x1b262c,
      metalness: 0.65,
      roughness: 0.35,
    });
    const padMesh = new THREE.Mesh(padGeo, padMat);
    padMesh.position.y = 0.05;
    group.add(padMesh);

    const coreGeo = new THREE.OctahedronGeometry(0.28, 0);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0x6bffa8,
      transparent: true,
      opacity: 0.94,
    });
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    coreMesh.position.y = 0.56;
    group.add(coreMesh);

    // 0.55m-tall translucent vertical holographic cylinder wall
    const wallGeo = new THREE.CylinderGeometry(radius, radius, 0.55, 48, 1, true);
    const wallMat = new THREE.MeshBasicMaterial({
      color: hex,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const wallMesh = new THREE.Mesh(wallGeo, wallMat);
    wallMesh.position.y = 0.275;
    group.add(wallMesh);

    const rimGeo = new THREE.TorusGeometry(radius, 0.05, 8, 48);
    rimGeo.rotateX(Math.PI * 0.5);
    const rimMat = new THREE.MeshBasicMaterial({
      color: hex,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    const rimMesh = new THREE.Mesh(rimGeo, rimMat);
    rimMesh.position.y = 0.04;
    group.add(rimMesh);

    // 2 expanding sonar rings phased half a cycle apart
    const sonarMeshes: THREE.Mesh[] = [];
    const sonarMats: THREE.MeshBasicMaterial[] = [];
    for (let i = 0; i < 2; i++) {
      const sonarGeo = new THREE.RingGeometry(0.88, 1.0, 44);
      sonarGeo.rotateX(-Math.PI * 0.5);
      const sonarMat = new THREE.MeshBasicMaterial({
        color: 0x9bffc6,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const sonarMesh = new THREE.Mesh(sonarGeo, sonarMat);
      sonarMesh.position.y = 0.05;
      group.add(sonarMesh);
      sonarMeshes.push(sonarMesh);
      sonarMats.push(sonarMat);
    }

    const particles = createParticleStream(
      BEACON_MOTE_COUNT,
      radius * 0.9,
      0x7effb2,
      0.13,
      0.42,
      0.85
    );
    group.add(particles.points);

    scene.add(group);
    return {
      group,
      coreMesh,
      coreMat,
      wallMat,
      rimMat,
      sonarMeshes,
      sonarMats,
      particles,
    };
  }

  /**
   * Builds an expanding `0.32s` Pop-Flash burst featuring an intense core plus
   * 3 orthogonal intersecting 3D starburst diamond planes (`radius -> 4.2m`)
   * visible around corners even when turned away.
   */
  function createFlashBurstVisual(origin: Vec3): TransientBurst {
    const group = new THREE.Group();
    group.position.set(origin.x, origin.y, origin.z);

    const burstGeo = new THREE.SphereGeometry(0.45, 20, 16);
    const burstMat = new THREE.MeshBasicMaterial({
      color: 0xf2fff7,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    });
    group.add(new THREE.Mesh(burstGeo, burstMat));

    const starburstMat = new THREE.MeshBasicMaterial({
      color: 0x8dffbe,
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    // 3 orthogonal intersecting starburst diamond/ring planes (XY, XZ, YZ)
    const rotations: Array<[number, number, number]> = [
      [0, 0, Math.PI * 0.25],
      [Math.PI * 0.5, 0, Math.PI * 0.25],
      [0, Math.PI * 0.5, Math.PI * 0.25],
    ];

    for (const [rx, ry, rz] of rotations) {
      const diamondGeo = new THREE.RingGeometry(0.18, 1.0, 4);
      const diamond = new THREE.Mesh(diamondGeo, starburstMat);
      diamond.rotation.set(rx, ry, rz);
      group.add(diamond);
    }

    group.scale.setScalar(0.3);
    scene.add(group);
    return {
      kind: 'flash_burst',
      group,
      materials: [burstMat, starburstMat],
      age: 0,
      duration: FLASH_BURST_DURATION_SEC,
    };
  }

  // -------------------------------------------------------------------------
  // Spawners & Detonation Logic
  // -------------------------------------------------------------------------

  function spawnZone(
    kind: ZoneKind,
    colorId: AgentColorId,
    team: TeamId,
    center: Vec3,
    radius: number,
    durationSec: number
  ): void {
    const data: ActiveZone = {
      id: `zone-${nextEntityId++}`,
      kind,
      colorId,
      center: { ...center },
      radius,
      remainingSec: durationSec,
      totalDurationSec: durationSec,
    };
    const visual = createZoneVisual(kind, colorId, data.center, radius);
    zones.push({ data, team, visual });
  }

  function spawnProjectileFromOrigin(
    kind: ProjectileKind,
    colorId: AgentColorId,
    team: TeamId,
    originPos: Vec3,
    yaw: number,
    pitch: number,
    speed: number,
    gravity: number,
    restitution: number,
    maxLifetime: number,
    detonateOnFloor: boolean,
    upwardLob: number
  ): void {
    const eye: Vec3 = {
      x: originPos.x,
      y: originPos.y + EYE_HEIGHT,
      z: originPos.z,
    };
    const rawDir = getLookDirection(yaw, pitch);
    const dir = normalizeVec3({
      x: rawDir.x,
      y: rawDir.y + upwardLob,
      z: rawDir.z,
    });

    const spawnPos: Vec3 = {
      x: eye.x + rawDir.x * PROJECTILE_SPAWN_FORWARD_OFFSET,
      y: eye.y + rawDir.y * PROJECTILE_SPAWN_FORWARD_OFFSET + PROJECTILE_SPAWN_VERTICAL_OFFSET,
      z: eye.z + rawDir.z * PROJECTILE_SPAWN_FORWARD_OFFSET,
    };

    const data: AbilityProjectile = {
      id: `proj-${nextEntityId++}`,
      kind,
      colorId,
      position: spawnPos,
      velocity: {
        x: dir.x * speed,
        y: dir.y * speed,
        z: dir.z * speed,
      },
      gravity,
      restitution,
      age: 0,
      maxLifetime,
      detonateOnFloor,
    };

    const { group, auraMesh, auraMat } = createProjectileVisual(kind, colorId, spawnPos);
    projectiles.push({ data, team, group, auraMesh, auraMat, warned: false });
  }

  /**
   * Resolves Pop-Flash detonation at point `F`:
   * 1. Spawns the 0.32s emerald-white burst + 3 orthogonal starburst planes.
   * 2. Line-of-sight blinds opposing-team non-player combatants (or all targets
   *    when `allCombatants` is omitted) within 22m (`blindTimer = 3.2s`).
   * 3. Line-of-sight tests player eye within 22m and computes view-cone alignment:
   *    `cosTheta = dot(lookDir, normalize(F - eye))`.
   *    - Looking toward the flash (`cosTheta > 0.20`): full `1.45s` blind.
   *    - Turned away (`cosTheta <= 0.20`): `0.20s` peripheral glint.
   */
  function detonateFlash(
    flashPos: Vec3,
    projTeam: TeamId,
    player: PlayerState,
    input: InputState,
    colliders: AABB[],
    targetsMgr: TargetsManager,
    allCombatants?: Combatant[]
  ): void {
    bursts.push(createFlashBurstVisual(flashPos));

    if (allCombatants) {
      for (const c of allCombatants) {
        if (!c.alive || c.isPlayer || c.team === projTeam) continue;
        const headPos: Vec3 = {
          x: c.position.x,
          y: c.position.y + 1.6,
          z: c.position.z,
        };
        const dist = Math.hypot(
          headPos.x - flashPos.x,
          headPos.y - flashPos.y,
          headPos.z - flashPos.z
        );
        if (dist <= FLASH_MAX_RANGE_M && hasLineOfSight(flashPos, headPos, colliders)) {
          targetsMgr.applyStatus(c.id, 'blind', FLASH_TARGET_BLIND_SEC);
        }
      }
    } else {
      for (const target of targetsMgr.targets) {
        if (!target.alive) continue;
        const headPos: Vec3 = {
          x: target.position.x,
          y: target.position.y + 1.6,
          z: target.position.z,
        };
        const dist = Math.hypot(
          headPos.x - flashPos.x,
          headPos.y - flashPos.y,
          headPos.z - flashPos.z
        );
        if (dist <= FLASH_MAX_RANGE_M && hasLineOfSight(flashPos, headPos, colliders)) {
          targetsMgr.applyStatus(target.id, 'blind', FLASH_TARGET_BLIND_SEC);
        }
      }
    }

    const eye: Vec3 = {
      x: player.position.x,
      y: player.position.y + EYE_HEIGHT,
      z: player.position.z,
    };
    const toFlashX = flashPos.x - eye.x;
    const toFlashY = flashPos.y - eye.y;
    const toFlashZ = flashPos.z - eye.z;
    const playerDist = Math.hypot(toFlashX, toFlashY, toFlashZ);

    if (playerDist <= FLASH_MAX_RANGE_M && hasLineOfSight(eye, flashPos, colliders)) {
      const lookDir = getLookDirection(input.yaw, input.pitch);
      const dirToFlash: Vec3 =
        playerDist > 1e-6
          ? {
              x: toFlashX / playerDist,
              y: toFlashY / playerDist,
              z: toFlashZ / playerDist,
            }
          : lookDir;

      const cosTheta = dotVec3(lookDir, dirToFlash);
      if (cosTheta > FLASH_PLAYER_LOOK_COS_THRESHOLD) {
        playerFlashTimer = FLASH_PLAYER_FULL_SEC;
      } else {
        playerFlashTimer = Math.max(playerFlashTimer, FLASH_PLAYER_GLINT_SEC);
      }
    }
  }

  function detonateProjectile(
    entry: ProjectileEntry,
    player: PlayerState,
    input: InputState,
    colliders: AABB[],
    targetsMgr: TargetsManager,
    audioEvents: AbilityAudioEvent[],
    allCombatants?: Combatant[]
  ): void {
    const proj = entry.data;
    switch (proj.kind) {
      case 'fire_orb':
        spawnZone(
          'fire',
          'red',
          entry.team,
          proj.position,
          FIRE_ZONE_RADIUS,
          FIRE_ZONE_DURATION_SEC
        );
        audioEvents.push('fire_ignite');
        break;
      case 'smoke_orb':
        spawnZone(
          'smoke',
          'blue',
          entry.team,
          {
            x: proj.position.x,
            y: proj.position.y + SMOKE_CENTER_Y_OFFSET,
            z: proj.position.z,
          },
          SMOKE_RADIUS,
          SMOKE_DURATION_SEC
        );
        bursts.push(createSmokeShockwaveVisual(proj.position));
        audioEvents.push('smoke_bloom');
        break;
      case 'slow_orb':
        spawnZone(
          'slow',
          'blue',
          entry.team,
          proj.position,
          SLOW_ZONE_RADIUS,
          SLOW_ZONE_DURATION_SEC
        );
        audioEvents.push('slow_shatter');
        break;
      case 'flash_orb':
        detonateFlash(
          proj.position,
          entry.team,
          player,
          input,
          colliders,
          targetsMgr,
          allCombatants
        );
        audioEvents.push('flash_pop');
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Public `cast`, `castForBot`, `resetRound`, and `update`
  // -------------------------------------------------------------------------

  function cast(slot: AbilitySlot, player: PlayerState, input: InputState): boolean {
    const colorId = player.colorId;
    if (cooldowns[colorId][slot] > 0) {
      return false;
    }

    const spec = AGENT_ABILITIES[colorId][slot];
    cooldowns[colorId][slot] = spec.cooldownSec;

    if (colorId === 'red' && slot === 'q') {
      // Crimson Dash: 0.24s cubic ease-out burst from 30.0 m/s -> 8.2 m/s
      dashDir = computeDashDirection(input);
      dashTimer = DASH_DURATION_SEC;
      bursts.push(createDashTunnelVisual(player.position, dashDir));
      pendingAudioEvents.push('dash');
      return true;
    }

    if (colorId === 'red' && slot === 'e') {
      spawnProjectileFromOrigin(
        'fire_orb',
        'red',
        'ally',
        player.position,
        input.yaw,
        input.pitch,
        FIRE_ORB_SPEED,
        FIRE_ORB_GRAVITY,
        FIRE_ORB_RESTITUTION,
        4.0,
        true,
        FIRE_ORB_UPWARD_LOB
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    if (colorId === 'blue' && slot === 'q') {
      spawnProjectileFromOrigin(
        'smoke_orb',
        'blue',
        'ally',
        player.position,
        input.yaw,
        input.pitch,
        SMOKE_ORB_SPEED,
        SMOKE_ORB_GRAVITY,
        SMOKE_ORB_RESTITUTION,
        4.0,
        true,
        SMOKE_ORB_UPWARD_LOB
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    if (colorId === 'blue' && slot === 'e') {
      spawnProjectileFromOrigin(
        'slow_orb',
        'blue',
        'ally',
        player.position,
        input.yaw,
        input.pitch,
        SLOW_ORB_SPEED,
        SLOW_ORB_GRAVITY,
        SLOW_ORB_RESTITUTION,
        4.0,
        true,
        SLOW_ORB_UPWARD_LOB
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    if (colorId === 'green' && slot === 'q') {
      spawnProjectileFromOrigin(
        'flash_orb',
        'green',
        'ally',
        player.position,
        input.yaw,
        input.pitch,
        FLASH_ORB_SPEED,
        FLASH_ORB_GRAVITY,
        FLASH_ORB_RESTITUTION,
        FLASH_FUSE_SEC,
        false,
        0.0
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    if (colorId === 'green' && slot === 'e') {
      spawnZone(
        'beacon',
        'green',
        'ally',
        { x: player.position.x, y: player.position.y, z: player.position.z },
        BEACON_RADIUS,
        BEACON_DURATION_SEC
      );
      pendingAudioEvents.push('beacon_deploy');
      return true;
    }

    return false;
  }

  function castForBot(
    slot: AbilitySlot,
    bot: Combatant,
    aimYaw: number,
    aimPitch: number
  ): boolean {
    if (!bot.alive) {
      return false;
    }

    const cd = getOrInitBotCooldowns(bot.id);
    if (cd[slot] > 0) {
      return false;
    }

    const spec = AGENT_ABILITIES[bot.colorId][slot];
    cd[slot] = spec.cooldownSec;

    if (bot.colorId === 'red' && slot === 'q') {
      const horizSpeed = Math.hypot(bot.velocity.x, bot.velocity.z);
      const dir: Vec3 =
        horizSpeed > 0.5
          ? { x: bot.velocity.x / horizSpeed, y: 0, z: bot.velocity.z / horizSpeed }
          : { x: -Math.sin(aimYaw), y: 0, z: -Math.cos(aimYaw) };

      bot.velocity.x = dir.x * BOT_DASH_SPEED_MPS;
      bot.velocity.z = dir.z * BOT_DASH_SPEED_MPS;
      botDashes.set(bot.id, {
        combatant: bot,
        timer: BOT_DASH_DURATION_SEC,
        dir,
      });
      bursts.push(createDashTunnelVisual(bot.position, dir));
      pendingAudioEvents.push('dash');
      return true;
    }

    if (bot.colorId === 'red' && slot === 'e') {
      spawnProjectileFromOrigin(
        'fire_orb',
        'red',
        bot.team,
        bot.position,
        aimYaw,
        aimPitch,
        FIRE_ORB_SPEED,
        FIRE_ORB_GRAVITY,
        FIRE_ORB_RESTITUTION,
        4.0,
        true,
        FIRE_ORB_UPWARD_LOB
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    if (bot.colorId === 'blue' && slot === 'q') {
      spawnProjectileFromOrigin(
        'smoke_orb',
        'blue',
        bot.team,
        bot.position,
        aimYaw,
        aimPitch,
        SMOKE_ORB_SPEED,
        SMOKE_ORB_GRAVITY,
        SMOKE_ORB_RESTITUTION,
        4.0,
        true,
        SMOKE_ORB_UPWARD_LOB
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    if (bot.colorId === 'blue' && slot === 'e') {
      spawnProjectileFromOrigin(
        'slow_orb',
        'blue',
        bot.team,
        bot.position,
        aimYaw,
        aimPitch,
        SLOW_ORB_SPEED,
        SLOW_ORB_GRAVITY,
        SLOW_ORB_RESTITUTION,
        4.0,
        true,
        SLOW_ORB_UPWARD_LOB
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    if (bot.colorId === 'green' && slot === 'q') {
      spawnProjectileFromOrigin(
        'flash_orb',
        'green',
        bot.team,
        bot.position,
        aimYaw,
        aimPitch,
        FLASH_ORB_SPEED,
        FLASH_ORB_GRAVITY,
        FLASH_ORB_RESTITUTION,
        FLASH_FUSE_SEC,
        false,
        0.0
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    if (bot.colorId === 'green' && slot === 'e') {
      spawnZone(
        'beacon',
        'green',
        bot.team,
        { x: bot.position.x, y: bot.position.y, z: bot.position.z },
        BEACON_RADIUS,
        BEACON_DURATION_SEC
      );
      pendingAudioEvents.push('beacon_deploy');
      return true;
    }

    return false;
  }

  function resetRound(): void {
    for (const entry of projectiles) {
      disposeObject3D(scene, entry.group);
    }
    projectiles.length = 0;

    for (const entry of zones) {
      disposeObject3D(scene, entry.visual.group);
    }
    zones.length = 0;

    for (const burst of bursts) {
      disposeObject3D(scene, burst.group);
    }
    bursts.length = 0;

    pendingAudioEvents.length = 0;
    dashTimer = 0;
    playerFlashTimer = 0;
    botDashes.clear();

    for (const color of ['red', 'blue', 'green'] as const) {
      cooldowns[color].q = 0;
      cooldowns[color].e = 0;
    }
    for (const cd of botCooldowns.values()) {
      cd.q = 0;
      cd.e = 0;
    }
  }

  function update(
    dt: number,
    player: PlayerState,
    input: InputState,
    colliders: AABB[],
    targetsMgr: TargetsManager,
    allCombatants?: Combatant[]
  ): AbilityFrameFeedback {
    const stepDt = Math.max(0, dt);
    const audioEvents = pendingAudioEvents.splice(0, pendingAudioEvents.length);

    // 1. Tick all agent cooldowns independently (both player and AI bots).
    for (const color of ['red', 'blue', 'green'] as const) {
      cooldowns[color].q = Math.max(0, cooldowns[color].q - stepDt);
      cooldowns[color].e = Math.max(0, cooldowns[color].e - stepDt);
    }
    for (const cd of botCooldowns.values()) {
      cd.q = Math.max(0, cd.q - stepDt);
      cd.e = Math.max(0, cd.e - stepDt);
    }

    // Tick active AI bot Crimson Dash horizontal velocity impulses (0.22s)
    for (const [botId, dash] of botDashes.entries()) {
      if (!dash.combatant.alive || dash.timer <= 0) {
        botDashes.delete(botId);
        continue;
      }
      const remainFrac = clamp(dash.timer / BOT_DASH_DURATION_SEC, 0, 1);
      const speed =
        DASH_END_SPEED_MPS +
        (BOT_DASH_SPEED_MPS - DASH_END_SPEED_MPS) * Math.pow(remainFrac, 2.0);
      dash.combatant.velocity.x = dash.dir.x * speed;
      dash.combatant.velocity.z = dash.dir.z * speed;
      dash.timer = Math.max(0, dash.timer - stepDt);
      if (dash.timer <= 0) {
        botDashes.delete(botId);
      }
    }

    // 2. Tick Crimson Dash with Cubic Ease-Out Velocity Curve:
    //    v(t) = v_run + (v_peak - v_run) * (1 - t / T)^2.2
    //    This delivers an immediate 30 m/s snap out of cover and decelerates smoothly
    //    into 8.2 m/s sprint speed at t = 0.24s (~5.2m total covered with momentum).
    const dashActive = dashTimer > 0;
    let dashAlpha = 0;
    let dashVelocity: Vec3 = { x: 0, y: 0, z: 0 };

    if (dashActive) {
      const elapsed = DASH_DURATION_SEC - dashTimer;
      const remainFrac = clamp(1 - elapsed / DASH_DURATION_SEC, 0, 1);
      const speed =
        DASH_END_SPEED_MPS +
        (DASH_PEAK_SPEED_MPS - DASH_END_SPEED_MPS) * Math.pow(remainFrac, 2.2);
      dashVelocity = {
        x: dashDir.x * speed,
        y: 0,
        z: dashDir.z * speed,
      };
      dashAlpha = remainFrac;
      dashTimer = Math.max(0, dashTimer - stepDt);
    }

    const movement: MovementModifiers = {
      dashActive,
      dashVelocity,
      speedMultiplier: 1.0,
      suppressJump: false,
    };

    // 3. Step active projectiles with swept ray-AABB bounce physics
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const entry = projectiles[i];
      const { hitHorizontalSurface } = stepProjectile(entry.data, colliders, stepDt);
      entry.group.position.set(
        entry.data.position.x,
        entry.data.position.y,
        entry.data.position.z
      );
      entry.group.rotation.y += stepDt * 6.0;
      entry.group.rotation.x += stepDt * 4.0;

      // Pop-Flash warning telegraph: scale outer aura & chime once at age >= 0.42s
      if (entry.data.kind === 'flash_orb') {
        const fuseFrac = clamp(entry.data.age / FLASH_FUSE_SEC, 0, 1);
        if (entry.auraMesh && entry.auraMat) {
          const auraScale = 1.0 + fuseFrac * 1.9;
          entry.auraMesh.scale.setScalar(auraScale);
          entry.auraMat.opacity = 0.35 + fuseFrac * 0.55;
        }
        if (entry.data.age >= FLASH_WARN_SEC && !entry.warned) {
          entry.warned = true;
          audioEvents.push('flash_warn');
        }
      }

      const shouldDetonate =
        (entry.data.detonateOnFloor && hitHorizontalSurface) ||
        entry.data.age >= entry.data.maxLifetime;

      if (shouldDetonate) {
        detonateProjectile(
          entry,
          player,
          input,
          colliders,
          targetsMgr,
          audioEvents,
          allCombatants
        );
        disposeObject3D(scene, entry.group);
        projectiles.splice(i, 1);
      }
    }

    // 4. Tick active zones, update GLSL uniforms & particle buffers, apply AoE effects
    const activeSmokes: SmokeSphere[] = [];
    let insideSmokeFactor = 0;
    let fireRateMultiplier = 1.0;
    let recoilMultiplier = 1.0;
    let stimActive = false;
    let playerInSlow = false;
    let playerInBeacon = false;

    const playerEye: Vec3 = {
      x: player.position.x,
      y: player.position.y + EYE_HEIGHT,
      z: player.position.z,
    };

    for (let i = zones.length - 1; i >= 0; i--) {
      const entry = zones[i];
      const zone = entry.data;
      zone.remainingSec -= stepDt;

      if (zone.remainingSec <= 0) {
        disposeObject3D(scene, entry.visual.group);
        zones.splice(i, 1);
        continue;
      }

      const elapsed = zone.totalDurationSec - zone.remainingSec;

      if (zone.kind === 'fire') {
        const fade = clamp(zone.remainingSec / 0.45, 0, 1);
        if (entry.visual.fireDiscMat) {
          entry.visual.fireDiscMat.uniforms.uTime.value = elapsed;
          entry.visual.fireDiscMat.uniforms.uOpacity.value = fade;
        }
        if (entry.visual.flameWallMat) {
          entry.visual.flameWallMat.uniforms.uTime.value = elapsed;
          entry.visual.flameWallMat.uniforms.uOpacity.value = fade;
        }
        if (entry.visual.particles) {
          updateParticleStream(entry.visual.particles, elapsed, 0.04, 1.66, 2.8, 0.92 * fade);
        }

        const rSq = zone.radius * zone.radius;
        if (allCombatants) {
          for (const c of allCombatants) {
            if (!c.alive) continue;
            const dx = c.position.x - zone.center.x;
            const dz = c.position.z - zone.center.z;
            if (
              dx * dx + dz * dz <= rSq &&
              Math.abs(c.position.y - zone.center.y) <= ZONE_VERTICAL_TOLERANCE_M
            ) {
              if (c.team !== entry.team) {
                targetsMgr.applyDamage(c.id, FIRE_TARGET_DPS * stepDt, false);
              } else if (c.isPlayer) {
                const avail = Math.max(0, c.health - FIRE_PLAYER_MIN_HP);
                const dmg = Math.min(avail, FIRE_ALLY_SELF_DPS * stepDt);
                if (dmg > 0) {
                  targetsMgr.applyDamage(c.id, dmg, false);
                }
              } else {
                targetsMgr.applyDamage(c.id, FIRE_ALLY_SELF_DPS * stepDt, false);
              }
            }
          }
        } else {
          // 45 DPS lethal target burn
          for (const target of targetsMgr.targets) {
            if (!target.alive) continue;
            const dx = target.position.x - zone.center.x;
            const dz = target.position.z - zone.center.z;
            if (
              dx * dx + dz * dz <= rSq &&
              Math.abs(target.position.y - zone.center.y) <= ZONE_VERTICAL_TOLERANCE_M
            ) {
              targetsMgr.applyDamage(target.id, FIRE_TARGET_DPS * stepDt, false);
            }
          }

          // Gentle self-scorch on player (clamped at 10 HP minimum)
          const pdx = player.position.x - zone.center.x;
          const pdz = player.position.z - zone.center.z;
          if (
            pdx * pdx + pdz * pdz <= rSq &&
            Math.abs(player.position.y - zone.center.y) <= ZONE_VERTICAL_TOLERANCE_M
          ) {
            player.health = Math.max(
              FIRE_PLAYER_MIN_HP,
              player.health - FIRE_PLAYER_SELF_DPS * stepDt
            );
          }
        }
      } else if (zone.kind === 'smoke') {
        const bloomScale = clamp(elapsed / SMOKE_BLOOM_SEC, 0.12, 1.0);
        entry.visual.group.scale.setScalar(bloomScale);

        if (entry.visual.smokeMat) {
          entry.visual.smokeMat.uniforms.uTime.value = elapsed;
          entry.visual.smokeMat.uniforms.uDissolve.value =
            zone.remainingSec < SMOKE_DISSOLVE_SEC
              ? clamp(zone.remainingSec / SMOKE_DISSOLVE_SEC, 0, 1)
              : 1.0;
        }

        const effectiveRadius = zone.radius * bloomScale;
        activeSmokes.push({
          center: { ...zone.center },
          radius: effectiveRadius,
        });

        // Hollow-Smoke Seam-Masking:
        // Peaks at 0.98 right as playerEye crosses the opaque shell polygon boundary
        // (eliminating near-plane clipping seams), then smoothsteps down to 0.22
        // clear atmospheric tint inside the hollow interior.
        const d = Math.hypot(
          playerEye.x - zone.center.x,
          playerEye.y - zone.center.y,
          playerEye.z - zone.center.z
        );

        let factor = 0;
        if (d >= effectiveRadius + SMOKE_SEAM_BAND_M) {
          factor = 0;
        } else if (d >= effectiveRadius) {
          const s = smoothstep01((effectiveRadius + SMOKE_SEAM_BAND_M - d) / SMOKE_SEAM_BAND_M);
          factor = SMOKE_SHELL_PEAK_TINT * s;
        } else if (d >= effectiveRadius - SMOKE_SEAM_BAND_M) {
          const s = smoothstep01((effectiveRadius - d) / SMOKE_SEAM_BAND_M);
          factor =
            SMOKE_SHELL_PEAK_TINT + (SMOKE_INTERIOR_TINT - SMOKE_SHELL_PEAK_TINT) * s;
        } else {
          factor = SMOKE_INTERIOR_TINT;
        }
        insideSmokeFactor = Math.max(insideSmokeFactor, factor);
      } else if (zone.kind === 'slow') {
        const fade = clamp(zone.remainingSec / 0.45, 0, 1);
        if (entry.visual.cryoMat) {
          entry.visual.cryoMat.uniforms.uTime.value = elapsed;
          entry.visual.cryoMat.uniforms.uOpacity.value = fade;
        }
        if (entry.visual.rimMat) {
          entry.visual.rimMat.opacity = 0.84 * fade;
        }
        if (entry.visual.spikeGroup && entry.visual.spikeMat) {
          const eruptT = clamp(elapsed / SLOW_SPIKE_ERUPT_SEC, 0, 1);
          const eruptEase = 1 - Math.pow(1 - eruptT, 3);
          entry.visual.spikeGroup.scale.set(1, 0.05 + 0.95 * eruptEase, 1);
          entry.visual.spikeMat.opacity = 0.86 * fade;
        }

        const rSq = zone.radius * zone.radius;
        if (allCombatants) {
          for (const c of allCombatants) {
            if (!c.alive) continue;
            const dx = c.position.x - zone.center.x;
            const dz = c.position.z - zone.center.z;
            if (
              dx * dx + dz * dz <= rSq &&
              Math.abs(c.position.y - zone.center.y) <= ZONE_VERTICAL_TOLERANCE_M
            ) {
              targetsMgr.applyStatus(c.id, 'slow', SLOW_TARGET_STATUS_REFRESH_SEC);
              if (c.isPlayer) {
                playerInSlow = true;
              }
            }
          }
        } else {
          for (const target of targetsMgr.targets) {
            if (!target.alive) continue;
            const dx = target.position.x - zone.center.x;
            const dz = target.position.z - zone.center.z;
            if (
              dx * dx + dz * dz <= rSq &&
              Math.abs(target.position.y - zone.center.y) <= ZONE_VERTICAL_TOLERANCE_M
            ) {
              targetsMgr.applyStatus(target.id, 'slow', SLOW_TARGET_STATUS_REFRESH_SEC);
            }
          }

          const pdx = player.position.x - zone.center.x;
          const pdz = player.position.z - zone.center.z;
          if (
            pdx * pdx + pdz * pdz <= rSq &&
            Math.abs(player.position.y - zone.center.y) <= ZONE_VERTICAL_TOLERANCE_M
          ) {
            playerInSlow = true;
          }
        }
      } else if (zone.kind === 'beacon') {
        const fade = clamp(zone.remainingSec / 0.45, 0, 1);
        if (entry.visual.coreMesh && entry.visual.coreMat) {
          entry.visual.coreMesh.rotation.y += stepDt * 2.8;
          entry.visual.coreMesh.position.y = 0.56 + 0.08 * Math.sin(elapsed * 4.5);
          entry.visual.coreMat.opacity = 0.94 * fade;
        }
        if (entry.visual.wallMat) {
          entry.visual.wallMat.opacity = (0.18 + 0.06 * Math.sin(elapsed * 5.0)) * fade;
        }
        if (entry.visual.rimMat) {
          entry.visual.rimMat.opacity = 0.72 * fade;
        }
        if (entry.visual.sonarMeshes && entry.visual.sonarMats) {
          for (let s = 0; s < entry.visual.sonarMeshes.length; s++) {
            const wave = ((elapsed + s * 0.55) % 1.1) / 1.1;
            const ringScale = 0.25 + wave * (zone.radius - 0.25);
            entry.visual.sonarMeshes[s].scale.setScalar(ringScale);
            entry.visual.sonarMats[s].opacity = (1.0 - wave) * 0.6 * fade;
          }
        }
        if (entry.visual.particles) {
          updateParticleStream(entry.visual.particles, elapsed, 0.1, 2.0, 1.4, 0.88 * fade);
        }

        const rSq = zone.radius * zone.radius;
        if (allCombatants) {
          for (const c of allCombatants) {
            if (!c.alive || c.team !== entry.team) continue;
            const dx = c.position.x - zone.center.x;
            const dz = c.position.z - zone.center.z;
            if (
              dx * dx + dz * dz <= rSq &&
              Math.abs(c.position.y - zone.center.y) <= ZONE_VERTICAL_TOLERANCE_M
            ) {
              c.health = Math.min(c.maxHealth, c.health + BEACON_HEAL_PER_SEC * stepDt);
              if (c.isPlayer) {
                playerInBeacon = true;
              }
            }
          }
        } else {
          const pdx = player.position.x - zone.center.x;
          const pdz = player.position.z - zone.center.z;
          if (
            pdx * pdx + pdz * pdz <= rSq &&
            Math.abs(player.position.y - zone.center.y) <= ZONE_VERTICAL_TOLERANCE_M
          ) {
            playerInBeacon = true;
          }
        }
      }
    }

    if (playerInSlow) {
      movement.speedMultiplier *= SLOW_PLAYER_SPEED_MULT;
      movement.suppressJump = true;
    }

    if (playerInBeacon) {
      if (!allCombatants) {
        player.health = Math.min(player.maxHealth, player.health + BEACON_HEAL_PER_SEC * stepDt);
      }
      stimActive = true;
      movement.speedMultiplier *= BEACON_SPEED_MULT;
      fireRateMultiplier = BEACON_FIRE_RATE_MULT;
      recoilMultiplier = BEACON_RECOIL_MULT;
    }

    // 5. Update transient bursts (dash wind tunnel, smoke shockwave, flash starbursts)
    for (let i = bursts.length - 1; i >= 0; i--) {
      const burst = bursts[i];
      burst.age += stepDt;
      if (burst.age >= burst.duration) {
        disposeObject3D(scene, burst.group);
        bursts.splice(i, 1);
        continue;
      }

      const t = clamp(burst.age / burst.duration, 0, 1);
      if (burst.kind === 'dash_tunnel') {
        const stretch = 1.0 + t * 0.65;
        burst.group.scale.set(1.0 + t * 0.15, 1.0 + t * 0.15, stretch);
        (burst.materials[0] as THREE.MeshBasicMaterial).opacity = 0.92 * (1 - t);
        (burst.materials[1] as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - t);
        (burst.materials[2] as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t);
      } else if (burst.kind === 'smoke_shockwave') {
        const easeOut = 1 - Math.pow(1 - t, 3);
        burst.group.scale.setScalar(0.35 + easeOut * 4.45);
        (burst.materials[0] as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t);
      } else {
        // Pop-Flash detonation expands 3 orthogonal starbursts to 4.2m over 0.32s
        const easeOut = 1 - Math.pow(1 - t, 2.2);
        burst.group.scale.setScalar(0.3 + easeOut * 3.9);
        (burst.materials[0] as THREE.MeshBasicMaterial).opacity = 0.96 * (1 - t);
        (burst.materials[1] as THREE.MeshBasicMaterial).opacity = 0.88 * (1 - t);
      }
    }

    // 6. Tick player flashbang blind timer & compute screen-space flash alpha
    let flashAlpha = 0;
    if (playerFlashTimer > 0) {
      flashAlpha = clamp(playerFlashTimer / 0.45, 0, 1);
      playerFlashTimer = Math.max(0, playerFlashTimer - stepDt);
    }

    // 7. Build HUD slot descriptors for the active agent palette
    const qSpec = AGENT_ABILITIES[player.colorId].q;
    const eSpec = AGENT_ABILITIES[player.colorId].e;
    const qCd = cooldowns[player.colorId].q;
    const eCd = cooldowns[player.colorId].e;

    const qHud: AbilityHudSlotState = {
      name: qSpec.name,
      shortTag: qSpec.shortTag,
      cooldownRemaining: qCd,
      cooldownTotal: qSpec.cooldownSec,
      ready: qCd <= 0,
    };

    const eHud: AbilityHudSlotState = {
      name: eSpec.name,
      shortTag: eSpec.shortTag,
      cooldownRemaining: eCd,
      cooldownTotal: eSpec.cooldownSec,
      ready: eCd <= 0,
    };

    return {
      movement,
      fireRateMultiplier,
      recoilMultiplier,
      activeSmokes,
      insideSmokeFactor,
      flashAlpha,
      dashAlpha,
      stimActive,
      audioEvents,
      qHud,
      eHud,
    };
  }

  return {
    cast,
    castForBot,
    resetRound,
    update,
  };
}
