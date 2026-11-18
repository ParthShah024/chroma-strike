import * as THREE from 'three';
import {
  AABB,
  AGENT_ORDER,
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
  createElectricRelayMaterial,
  createFireZoneMaterial,
  createFlameWallMaterial,
  createSingularityMaterial,
  createSmokeDomeMaterial,
  createVoidSmokeMaterial,
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
  notifyKill(killerColor: AgentColorId, isPlayer: boolean): void;
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

// Violet — Umbra (Shadow Smoker / Controller)
const VOID_MAX_CHARGES = 2;
const VOID_RECHARGE_SEC = 14.0;
const VOID_RECAST_LOCK_SEC = 0.35;
const VOID_REBLOOM_MIN_AGE_SEC = 0.08;
const VOID_ORB_SPEED = 32.0;
const VOID_ORB_GRAVITY = 0.0;
const VOID_ORB_MAX_LIFETIME = 0.50;
const VOID_SMOKE_RADIUS = 3.6;
const VOID_SMOKE_DURATION_SEC = 6.5;
const VOID_SMOKE_FLOOR_Y_OFFSET = 1.35;

const VORTEX_ORB_SPEED = 22.0;
const VORTEX_ORB_GRAVITY = 16.0;
const VORTEX_ORB_RESTITUTION = 0.50;
const VORTEX_ORB_UPWARD_LOB = 0.10;
const VORTEX_RADIUS = 4.0;
const VORTEX_DURATION_SEC = 3.2;
const VORTEX_PULL_MAX_SPEED_MPS = 3.2;
const VORTEX_PULL_ACCEL_MPS2 = 9.5;
const VORTEX_SPEED_MULT = 0.65;
const VORTEX_FRAGILE_SEC = 0.35;
const VORTEX_PARTICLE_COUNT = 32;

// Gold — Volt (Neon-Style Electric Duelist)
const OVERDRIVE_DURATION_SEC = 4.5;
const OVERDRIVE_SPEED_MULT = 1.45;
const SLIDE_DURATION_SEC = 0.55;
const SLIDE_PEAK_SPEED_MPS = 14.2;
const SLIDE_END_SPEED_MPS = 7.8;
const SLIDE_LOCKOUT_SEC = 2.2;
const SLIDE_SPRINT_THRESHOLD_MPS = 5.0;
const SLIDE_EYE_HEIGHT_OFFSET = -0.68;
const SLIDE_RECOIL_MULT = 0.72;

const RELAY_BOLT_SPEED = 34.0;
const RELAY_BOLT_GRAVITY = 2.5;
const RELAY_BOLT_RESTITUTION = 0.92;
const RELAY_BOLT_MAX_LIFETIME = 0.85;
const RELAY_SHOCK_RADIUS = 3.2;
const RELAY_SHOCK_DURATION_SEC = 0.75;
const RELAY_SHOCK_ARM_SEC = 0.38;
const RELAY_SHOCK_DAMAGE = 22.0;
const RELAY_CONCUSS_DURATION_SEC = 2.0;
const CONCUSS_SPEED_MULT = 0.60;
const CONCUSS_FIRE_RATE_MULT = 0.68;
const CONCUSS_MOVE_SPREAD_MULT = 1.45;

const PROJECTILE_SPAWN_FORWARD_OFFSET = 0.28;
const PROJECTILE_SPAWN_VERTICAL_OFFSET = -0.06;
const ZONE_VERTICAL_TOLERANCE_M = 1.8;

// Signature [X] Ultimate Constants (All 5 Agents)
// Red (Blaze) [X] — Inferno Overdrive
const BLAZE_ULT_DURATION_SEC = 8.0;
const BLAZE_ULT_FIRE_RATE_MULT = 1.35;
const BLAZE_ULT_SPEED_MULT = 1.2;
const BLAZE_ULT_RECOIL_MULT = 0.65;

// Blue (Mist) [X] — Glacial Whiteout
const MIST_ULT_PROJ_SPEED = 30.0;
const MIST_ULT_PROJ_GRAVITY = 12.0;
const MIST_ULT_PROJ_RESTITUTION = 0.45;
const MIST_ULT_CRYO_RADIUS = 8.5;
const MIST_ULT_SMOKE_RADIUS = 4.8;
const MIST_ULT_DURATION_SEC = 7.5;
const MIST_ULT_PLAYER_SPEED_MULT = 0.25; // 75% target slow
const MIST_ULT_SLOW_REFRESH_SEC = 0.55;

// Green (Pulse) [X] — Orbital Recon
const PULSE_ULT_DURATION_SEC = 6.5;
const PULSE_ULT_WAVE_TIMES: readonly number[] = [0.0, 2.2, 4.4];
const PULSE_ULT_WAVE_DURATION_SEC = 1.9;
const PULSE_ULT_WAVE_MAX_RADIUS = 56.0;
const PULSE_ULT_TEAM_SPEED_MULT = 1.15;

// Violet (Umbra) [X] — Eclipse Curtain
const UMBRA_ULT_DURATION_SEC = 9.0;
const UMBRA_ULT_RADIUS = 3.6;
const UMBRA_ULT_DISTANCES: readonly number[] = [4, 9, 14, 19, 24];
const UMBRA_ULT_CLAMP_X = 35.0;
const UMBRA_ULT_CLAMP_Z = 39.0;

// Gold (Volt) [X] — Thunderstorm
const VOLT_ULT_DURATION_SEC = 7.5;
const VOLT_ULT_SPEED_MULT = 1.5;
const VOLT_ULT_SLIDE_LOCKOUT_SEC = 0.6;
const VOLT_ULT_ZAP_RADIUS_M = 8.5;
const VOLT_ULT_ZAP_INTERVAL_SEC = 0.55;
const VOLT_ULT_ZAP_DAMAGE = 12.0;
const VOLT_ULT_ZAP_CONCUSS_SEC = 0.8;
const VOLT_ULT_ARC_DURATION_SEC = 0.24;

// ---------------------------------------------------------------------------
// Internal Visual + Simulation Record Interfaces
// ---------------------------------------------------------------------------

interface ProjectileEntry {
  data: AbilityProjectile;
  team: TeamId;
  ownerTeam?: TeamId;
  casterId?: string;
  isPlayerCast?: boolean;
  isMistUlt?: boolean;
  bounces: number;
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
  singularityMat?: THREE.ShaderMaterial;
  relayMat?: THREE.ShaderMaterial;
  lightningGroup?: THREE.Group;
  lightningMat?: THREE.LineBasicMaterial;
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
  ownerTeam?: TeamId;
  casterId?: string;
  discharged?: boolean;
  isBlizzard?: boolean;
  visual: ZoneVisualHandles;
}

interface BotDashEntry {
  combatant: Combatant;
  timer: number;
  dir: Vec3;
}

interface BotSlideEntry {
  combatant: Combatant;
  slideTimer: number;
  overdriveTimer: number;
  dir: Vec3;
}

interface BotVoidChargeState {
  charges: number;
  rechargeTimer: number;
  recastLock: number;
}

interface ActivePulseUlt {
  team: TeamId;
  origin: Vec3;
  elapsed: number;
  remaining: number;
  wavesSpawned: number;
}

interface BotBlazeUltEntry {
  combatant: Combatant;
  timer: number;
}

interface BotVoltUltEntry {
  combatant: Combatant;
  timer: number;
  zapTimer: number;
}

interface TransientBurst {
  kind:
    | 'dash_tunnel'
    | 'smoke_shockwave'
    | 'flash_burst'
    | 'slide_sparks'
    | 'sonar_wave'
    | 'lightning_arc'
    | 'ult_ring';
  group: THREE.Group;
  materials: THREE.Material[];
  age: number;
  duration: number;
  maxScale?: number;
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

/**
 * Steps a `ParticleStream` inward along an accretion spiral for Umbra's Singularity Vortex.
 */
function updateInwardVortexParticles(
  stream: ParticleStream,
  elapsed: number,
  opacity: number
): void {
  const { positions, radii, angles, speeds, phases, count } = stream;
  for (let i = 0; i < count; i++) {
    const life = (phases[i] + elapsed * speeds[i]) % 1;
    const theta = angles[i] + life * 5.4 + elapsed * 2.4;
    const r = Math.max(0.1, radii[i] * (1.0 - life * 0.92));
    const idx = i * 3;
    positions[idx] = Math.cos(theta) * r;
    positions[idx + 1] = 0.05 + Math.sin(life * Math.PI) * 0.55;
    positions[idx + 2] = Math.sin(theta) * r;
  }
  const posAttr = stream.geometry.getAttribute('position') as THREE.BufferAttribute;
  posAttr.needsUpdate = true;
  stream.material.opacity = opacity;
}

/**
 * Projects a wall or mid-air projectile impact point vertically down onto the
 * nearest floor/platform collider below so ground AoE discs never float in mid-air.
 */
function projectPointToFloor(
  pos: Vec3,
  normal: Vec3 | null,
  colliders: AABB[]
): Vec3 {
  const nx = normal ? normal.x * 0.12 : 0;
  const nz = normal ? normal.z * 0.12 : 0;
  const rayOrigin: Vec3 = {
    x: pos.x + nx,
    y: pos.y + (normal && normal.y > 0.5 ? 0.08 : 0.12),
    z: pos.z + nz,
  };
  const downDir: Vec3 = { x: 0, y: -1, z: 0 };
  let bestDist = 10.0;
  let floorY = 0;

  for (const box of colliders) {
    const hit = raycastAABB(rayOrigin, downDir, box, bestDist);
    if (hit && hit.distance < bestDist && hit.normal.y >= 0.5) {
      bestDist = hit.distance;
      floorY = hit.point.y;
    }
  }

  return {
    x: pos.x + (normal ? normal.x * 0.05 : 0),
    y: floorY,
    z: pos.z + (normal ? normal.z * 0.05 : 0),
  };
}

// ---------------------------------------------------------------------------
// Ability System Factory
// ---------------------------------------------------------------------------

/**
 * Creates the Chroma Strike Ability System managing all 5 agents (10 abilities)
 * with custom GLSL shaders, pooled `Float32Array` particle emitters, cubic
 * ease-out dash & power-slide physics, hollow opaque smoke seam-masking, and audio cues.
 */
export function createAbilitySystem(scene: THREE.Scene): AbilitySystem {
  let nextEntityId = 1;
  let zoneSeq = 0;

  // Independent per-agent cooldown pools across all 5 roster agents.
  const cooldowns: Record<AgentColorId, Record<AbilitySlot, number>> = {
    red: { q: 0, e: 0, x: 0 },
    blue: { q: 0, e: 0, x: 0 },
    green: { q: 0, e: 0, x: 0 },
    violet: { q: 0, e: 0, x: 0 },
    gold: { q: 0, e: 0, x: 0 },
  };
  const botCooldowns = new Map<string, Record<AbilitySlot, number>>();
  const botDashes = new Map<string, BotDashEntry>();
  const botSlides = new Map<string, BotSlideEntry>();
  const botVoidStates = new Map<string, BotVoidChargeState>();
  const botBlazeUlts = new Map<string, BotBlazeUltEntry>();
  const botVoltUlts = new Map<string, BotVoltUltEntry>();
  const activePulseUlts: ActivePulseUlt[] = [];

  function getOrInitBotCooldowns(botId: string): Record<AbilitySlot, number> {
    let cd = botCooldowns.get(botId);
    if (!cd) {
      cd = { q: 0, e: 0, x: 0 };
      botCooldowns.set(botId, cd);
    }
    return cd;
  }

  function getOrInitBotVoidState(botId: string): BotVoidChargeState {
    let st = botVoidStates.get(botId);
    if (!st) {
      st = { charges: VOID_MAX_CHARGES, rechargeTimer: 0, recastLock: 0 };
      botVoidStates.set(botId, st);
    }
    return st;
  }

  const projectiles: ProjectileEntry[] = [];
  const zones: ZoneEntry[] = [];
  const bursts: TransientBurst[] = [];
  const pendingAudioEvents: AbilityAudioEvent[] = [];

  // Cached player team & combatant ID for friendly-fire / self-hazard filtering
  let playerTeam: TeamId = 'ally';
  let playerCasterId = 'player';

  // Active Red Q dash state
  let dashTimer = 0;
  let dashDir: Vec3 = { x: 0, y: 0, z: -1 };

  // Active Green Q player blind state
  let playerFlashTimer = 0;

  // Active Violet Q (Void Shroud) 2-charge pool
  let voidCharges = VOID_MAX_CHARGES;
  let voidRechargeTimer = 0;
  let voidRecastLockTimer = 0;

  // Active Gold Q (Overdrive + Electric Power Slide) & Concuss state
  let overdriveTimer = 0;
  let slideTimer = 0;
  let slideLockoutTimer = 0;
  let slideDir: Vec3 = { x: 0, y: 0, z: -1 };
  let walkArmedForSlide = true;
  let smoothEyeHeightOffset = 0;
  let playerConcussTimer = 0;

  // Active Signature [X] Ultimate Timers (Player)
  let blazeUltTimer = 0;
  let mistUltTimer = 0;
  let pulseUltTimer = 0;
  let umbraUltTimer = 0;
  let voltUltTimer = 0;
  let voltUltZapTimer = 0;

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

  function createSmokeShockwaveVisual(origin: Vec3, ringColorHex = 0x7ae9ff): TransientBurst {
    const group = new THREE.Group();
    group.position.set(origin.x, origin.y + 0.05, origin.z);

    const ringGeo = new THREE.RingGeometry(0.75, 1.0, 44);
    ringGeo.rotateX(-Math.PI * 0.5);
    const ringMat = new THREE.MeshBasicMaterial({
      color: ringColorHex,
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

  function createSlideSparksVisual(origin: Vec3, dir: Vec3): TransientBurst {
    const group = new THREE.Group();
    group.position.set(origin.x, origin.y, origin.z);
    group.rotation.y = Math.atan2(dir.x, dir.z);

    const goldMat = new THREE.MeshBasicMaterial({
      color: AGENT_PALETTES.gold.hex,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    const whiteGoldMat = new THREE.MeshBasicMaterial({
      color: 0xfef08a,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });

    for (let i = 0; i < 12; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const lateral = side * (0.42 + (i % 3) * 0.18);
      const yPos = 0.14 + (i % 4) * 0.22;
      const forwardDist = 0.6 + (i / 11) * 4.2;
      const streakLen = 0.65 + (i % 3) * 0.28;
      const boxGeo = new THREE.BoxGeometry(0.032, 0.032, streakLen);
      const mesh = new THREE.Mesh(boxGeo, i % 2 === 0 ? goldMat : whiteGoldMat);
      mesh.position.set(lateral, yPos, forwardDist);
      group.add(mesh);
    }

    scene.add(group);
    return {
      kind: 'slide_sparks',
      group,
      materials: [goldMat, whiteGoldMat],
      age: 0,
      duration: 0.42,
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
    const coreColor =
      kind === 'flash_orb'
        ? 0xd9ffe8
        : kind === 'void_orb'
          ? 0x12051f
          : kind === 'vortex_orb'
            ? 0x07010f
            : kind === 'relay_bolt'
              ? 0xfef08a
              : hex;

    const coreGeo =
      kind === 'relay_bolt'
        ? new THREE.OctahedronGeometry(0.15, 1)
        : new THREE.SphereGeometry(0.14, 14, 12);
    const coreMat = new THREE.MeshBasicMaterial({ color: coreColor });
    group.add(new THREE.Mesh(coreGeo, coreMat));

    const shellGeo = new THREE.SphereGeometry(0.21, 12, 10);
    const shellMat = new THREE.MeshBasicMaterial({
      color: hex,
      wireframe: true,
      transparent: true,
      opacity: 0.78,
    });
    group.add(new THREE.Mesh(shellGeo, shellMat));

    if (kind === 'flash_orb' || kind === 'void_orb' || kind === 'relay_bolt') {
      const auraColor =
        kind === 'flash_orb' ? 0x7effb2 : kind === 'void_orb' ? 0xc084fc : 0xfde047;
      const auraGeo = new THREE.SphereGeometry(0.28, 16, 12);
      const auraMat = new THREE.MeshBasicMaterial({
        color: auraColor,
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

    if (kind === 'smoke' || kind === 'void_smoke') {
      // 100% opaque Z-buffered DoubleSide shader sphere (true Valorant hollow smoke)
      const sphereGeo = new THREE.SphereGeometry(radius, 36, 24);
      const smokeMat =
        kind === 'void_smoke'
          ? createVoidSmokeMaterial(hex)
          : createSmokeDomeMaterial(hex);
      const sphereMesh = new THREE.Mesh(sphereGeo, smokeMat);
      group.add(sphereMesh);

      group.scale.setScalar(0.12);
      scene.add(group);
      return {
        group,
        smokeMat,
      };
    }

    // Per-zone Y-stagger prevents overlapping AoE floor discs from Z-fighting each other.
    const yStagger = (zoneSeq++ % 8) * 0.0015;

    if (kind === 'fire') {
      const discGeo = new THREE.CircleGeometry(radius, 44);
      discGeo.rotateX(-Math.PI * 0.5);
      const fireDiscMat = createFireZoneMaterial();
      const discMesh = new THREE.Mesh(discGeo, fireDiscMat);
      discMesh.position.y = 0.03 + yStagger;
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
      discMesh.position.y = 0.025 + yStagger;
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
      rimMesh.position.y = 0.045 + yStagger;
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

    if (kind === 'vortex') {
      const discGeo = new THREE.CircleGeometry(radius, 48);
      discGeo.rotateX(-Math.PI * 0.5);
      const singularityMat = createSingularityMaterial();
      const discMesh = new THREE.Mesh(discGeo, singularityMat);
      discMesh.position.y = 0.028 + yStagger;
      group.add(discMesh);

      const rimGeo = new THREE.TorusGeometry(radius, 0.045, 8, 48);
      rimGeo.rotateX(Math.PI * 0.5);
      const rimMat = new THREE.MeshBasicMaterial({
        color: 0xc084fc,
        transparent: true,
        opacity: 0.74,
        depthWrite: false,
      });
      const rimMesh = new THREE.Mesh(rimGeo, rimMat);
      rimMesh.position.y = 0.042 + yStagger;
      group.add(rimMesh);

      const coreGeo = new THREE.SphereGeometry(0.24, 16, 12);
      const coreMat = new THREE.MeshBasicMaterial({
        color: 0x090212,
        transparent: true,
        opacity: 0.96,
      });
      const coreMesh = new THREE.Mesh(coreGeo, coreMat);
      coreMesh.position.y = 0.24;
      group.add(coreMesh);

      const particles = createParticleStream(
        VORTEX_PARTICLE_COUNT,
        radius * 0.96,
        0xd8b4fe,
        0.14,
        0.65,
        1.25
      );
      group.add(particles.points);

      scene.add(group);
      return {
        group,
        singularityMat,
        rimMat,
        coreMesh,
        coreMat,
        particles,
      };
    }

    if (kind === 'relay_shock') {
      const discGeo = new THREE.CircleGeometry(radius, 44);
      discGeo.rotateX(-Math.PI * 0.5);
      const relayMat = createElectricRelayMaterial();
      relayMat.uniforms.uIntensity.value = 0.6;
      const discMesh = new THREE.Mesh(discGeo, relayMat);
      discMesh.position.y = 0.032 + yStagger;
      group.add(discMesh);

      const rimGeo = new THREE.TorusGeometry(radius, 0.042, 8, 48);
      rimGeo.rotateX(Math.PI * 0.5);
      const rimMat = new THREE.MeshBasicMaterial({
        color: AGENT_PALETTES.gold.hex,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
      });
      const rimMesh = new THREE.Mesh(rimGeo, rimMat);
      rimMesh.position.y = 0.044 + yStagger;
      group.add(rimMesh);

      // Jagged 3D lightning THREE.Line bolts overhead (revealed on discharge at 0.38s)
      const lightningGroup = new THREE.Group();
      const lightningMat = new THREE.LineBasicMaterial({
        color: 0xfef08a,
        transparent: true,
        opacity: 0.95,
      });

      for (let b = 0; b < 5; b++) {
        const baseAngle = (b / 5) * Math.PI * 2;
        const pts: THREE.Vector3[] = [];
        const segs = 6;
        for (let s = 0; s <= segs; s++) {
          const frac = s / segs;
          const y = 2.45 * (1 - frac) + 0.05;
          const r = radius * (0.14 + frac * 0.66);
          const jag =
            s === 0 || s === segs
              ? 0
              : ((s % 2 === 0 ? 1 : -1) * 0.32 + Math.sin(b * 2.1 + s * 1.7) * 0.18);
          const ang = baseAngle + jag * 0.55;
          const radJitter = r + jag * 0.25;
          pts.push(new THREE.Vector3(Math.cos(ang) * radJitter, y, Math.sin(ang) * radJitter));
        }
        const boltGeo = new THREE.BufferGeometry().setFromPoints(pts);
        lightningGroup.add(new THREE.Line(boltGeo, lightningMat));
      }
      lightningGroup.visible = false;
      group.add(lightningGroup);

      scene.add(group);
      return {
        group,
        relayMat,
        rimMat,
        lightningGroup,
        lightningMat,
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
    rimMesh.position.y = 0.04 + yStagger;
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
      sonarMesh.position.y = 0.05 + yStagger;
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

  /**
   * Dramatic ground-level activation ring for signature [X] Ultimates.
   */
  function createUltActivationRingVisual(
    origin: Vec3,
    colorHex: number,
    maxScale = 6.2
  ): TransientBurst {
    const group = new THREE.Group();
    group.position.set(origin.x, origin.y + 0.08, origin.z);

    const ringGeo = new THREE.RingGeometry(0.78, 1.0, 48);
    ringGeo.rotateX(-Math.PI * 0.5);
    const ringMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    group.add(new THREE.Mesh(ringGeo, ringMat));

    const wallGeo = new THREE.CylinderGeometry(1.0, 1.0, 0.85, 48, 1, true);
    const wallMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.34,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const wallMesh = new THREE.Mesh(wallGeo, wallMat);
    wallMesh.position.y = 0.42;
    group.add(wallMesh);

    group.scale.setScalar(0.45);
    scene.add(group);
    return {
      kind: 'ult_ring',
      group,
      materials: [ringMat, wallMat],
      age: 0,
      duration: 0.65,
      maxScale,
    };
  }

  /**
   * Green (Pulse) [X] Orbital Recon — massive arena-wide emerald 3D sonar shockwave
   * expanding from `origin` to `PULSE_ULT_WAVE_MAX_RADIUS` (~56m) across the compound.
   */
  function createOrbitalSonarWaveVisual(origin: Vec3): TransientBurst {
    const group = new THREE.Group();
    group.position.set(origin.x, origin.y + 0.14, origin.z);

    const ringGeo = new THREE.RingGeometry(0.92, 1.0, 64);
    ringGeo.rotateX(-Math.PI * 0.5);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x34f59a,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    group.add(new THREE.Mesh(ringGeo, ringMat));

    const wallGeo = new THREE.CylinderGeometry(1.0, 1.0, 2.6, 64, 1, true);
    const wallMat = new THREE.MeshBasicMaterial({
      color: 0x2ecc71,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const wallMesh = new THREE.Mesh(wallGeo, wallMat);
    wallMesh.position.y = 1.3;
    group.add(wallMesh);

    group.scale.set(0.6, 1.0, 0.6);
    scene.add(group);
    return {
      kind: 'sonar_wave',
      group,
      materials: [ringMat, wallMat],
      age: 0,
      duration: PULSE_ULT_WAVE_DURATION_SEC,
      maxScale: PULSE_ULT_WAVE_MAX_RADIUS,
    };
  }

  /**
   * Gold (Volt) [X] Thunderstorm — visible jagged 3D chain-lightning arc
   * connecting `from` to `to` with a bright impact spark.
   */
  function createChainLightningArcVisual(from: Vec3, to: Vec3): TransientBurst {
    const group = new THREE.Group();

    const mainMat = new THREE.LineBasicMaterial({
      color: 0xfef08a,
      transparent: true,
      opacity: 0.98,
    });
    const outerMat = new THREE.LineBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.82,
    });

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.max(0.01, Math.hypot(dx, dy, dz));
    // Perpendicular basis for jagged displacement
    const invLen = 1 / len;
    const nx = dx * invLen;
    const ny = dy * invLen;
    const nz = dz * invLen;
    const refX = Math.abs(ny) < 0.9 ? 0 : 1;
    const refY = Math.abs(ny) < 0.9 ? 1 : 0;
    const refZ = 0;
    let px = ny * refZ - nz * refY;
    let py = nz * refX - nx * refZ;
    let pz = nx * refY - ny * refX;
    const pLen = Math.hypot(px, py, pz) || 1;
    px /= pLen;
    py /= pLen;
    pz /= pLen;
    const qx = ny * pz - nz * py;
    const qy = nz * px - nx * pz;
    const qz = nx * py - ny * px;

    const segs = 9;
    for (let strand = 0; strand < 2; strand++) {
      const pts: THREE.Vector3[] = [];
      const amp = strand === 0 ? 0.24 : 0.38;
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        let x = from.x + dx * t;
        let y = from.y + dy * t;
        let z = from.z + dz * t;
        if (s > 0 && s < segs) {
          const j1 = (Math.random() * 2 - 1) * amp;
          const j2 = (Math.random() * 2 - 1) * amp;
          x += px * j1 + qx * j2;
          y += py * j1 + qy * j2;
          z += pz * j1 + qz * j2;
        }
        pts.push(new THREE.Vector3(x, y, z));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      group.add(new THREE.Line(geo, strand === 0 ? mainMat : outerMat));
    }

    const sparkGeo = new THREE.OctahedronGeometry(0.26, 0);
    const sparkMat = new THREE.MeshBasicMaterial({
      color: 0xfef9c3,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sparkMesh = new THREE.Mesh(sparkGeo, sparkMat);
    sparkMesh.position.set(to.x, to.y, to.z);
    group.add(sparkMesh);

    scene.add(group);
    return {
      kind: 'lightning_arc',
      group,
      materials: [mainMat, outerMat, sparkMat],
      age: 0,
      duration: VOLT_ULT_ARC_DURATION_SEC,
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
    durationSec: number,
    casterId?: string,
    isBlizzard = false
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
    zones.push({
      data,
      team,
      ownerTeam: team,
      casterId,
      discharged: false,
      isBlizzard,
      visual,
    });
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
    upwardLob: number,
    casterId?: string,
    isPlayerCast = false,
    eyeOffsetY = 0,
    isMistUlt = false
  ): void {
    const eye: Vec3 = {
      x: originPos.x,
      y: originPos.y + EYE_HEIGHT + eyeOffsetY,
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
    if (isMistUlt) {
      group.scale.setScalar(1.45);
    }
    projectiles.push({
      data,
      team,
      ownerTeam: team,
      casterId,
      isPlayerCast,
      isMistUlt,
      bounces: 0,
      group,
      auraMesh,
      auraMat,
      warned: false,
    });
  }

  function bloomVoidOrb(
    entry: ProjectileEntry,
    hitHorizontalFloor: boolean,
    audioSink: AbilityAudioEvent[]
  ): void {
    const pos = entry.data.position;
    const centerY = hitHorizontalFloor ? pos.y + VOID_SMOKE_FLOOR_Y_OFFSET : pos.y;
    spawnZone(
      'void_smoke',
      'violet',
      entry.ownerTeam ?? entry.team,
      { x: pos.x, y: centerY, z: pos.z },
      VOID_SMOKE_RADIUS,
      VOID_SMOKE_DURATION_SEC,
      entry.casterId
    );
    bursts.push(createSmokeShockwaveVisual(pos, 0xc084fc));
    audioSink.push('void_bloom');
  }

  function triggerPlayerPowerSlide(
    player: PlayerState,
    input: InputState,
    audioSink: AbilityAudioEvent[]
  ): void {
    const hSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    if (hSpeed > 2.0) {
      slideDir = {
        x: player.velocity.x / hSpeed,
        y: 0,
        z: player.velocity.z / hSpeed,
      };
    } else {
      slideDir = computeDashDirection(input);
    }
    slideTimer = SLIDE_DURATION_SEC;
    slideLockoutTimer = voltUltTimer > 0 ? VOLT_ULT_SLIDE_LOCKOUT_SEC : SLIDE_LOCKOUT_SEC;
    bursts.push(createSlideSparksVisual(player.position, slideDir));
    audioSink.push('power_slide');
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
      y: player.position.y + EYE_HEIGHT + smoothEyeHeightOffset,
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
    const ownerTeam = entry.ownerTeam ?? entry.team;
    switch (proj.kind) {
      case 'fire_orb':
        spawnZone(
          'fire',
          'red',
          ownerTeam,
          proj.position,
          FIRE_ZONE_RADIUS,
          FIRE_ZONE_DURATION_SEC,
          entry.casterId
        );
        audioEvents.push('fire_ignite');
        break;
      case 'smoke_orb':
        spawnZone(
          'smoke',
          'blue',
          ownerTeam,
          {
            x: proj.position.x,
            y: proj.position.y + SMOKE_CENTER_Y_OFFSET,
            z: proj.position.z,
          },
          SMOKE_RADIUS,
          SMOKE_DURATION_SEC,
          entry.casterId
        );
        bursts.push(createSmokeShockwaveVisual(proj.position));
        audioEvents.push('smoke_bloom');
        break;
      case 'slow_orb':
        if (entry.isMistUlt) {
          const floorCenter = projectPointToFloor(proj.position, null, colliders);
          // Massive 8.5m Cryo Blizzard Field (75% slow + jump suppression)
          spawnZone(
            'slow',
            'blue',
            ownerTeam,
            floorCenter,
            MIST_ULT_CRYO_RADIUS,
            MIST_ULT_DURATION_SEC,
            entry.casterId,
            true
          );
          // Inner 4.8m Opaque Frost Smoke Dome blocking LoS for 7.5s
          spawnZone(
            'smoke',
            'blue',
            ownerTeam,
            {
              x: floorCenter.x,
              y: floorCenter.y + SMOKE_CENTER_Y_OFFSET,
              z: floorCenter.z,
            },
            MIST_ULT_SMOKE_RADIUS,
            MIST_ULT_DURATION_SEC,
            entry.casterId
          );
          bursts.push(createUltActivationRingVisual(floorCenter, 0x7ae9ff, MIST_ULT_CRYO_RADIUS));
          audioEvents.push('slow_shatter', 'smoke_bloom');
        } else {
          spawnZone(
            'slow',
            'blue',
            ownerTeam,
            proj.position,
            SLOW_ZONE_RADIUS,
            SLOW_ZONE_DURATION_SEC,
            entry.casterId
          );
          audioEvents.push('slow_shatter');
        }
        break;
      case 'flash_orb':
        detonateFlash(
          proj.position,
          ownerTeam,
          player,
          input,
          colliders,
          targetsMgr,
          allCombatants
        );
        audioEvents.push('flash_pop');
        break;
      case 'void_orb':
        bloomVoidOrb(entry, false, audioEvents);
        break;
      case 'vortex_orb': {
        const floorCenter = projectPointToFloor(proj.position, null, colliders);
        spawnZone(
          'vortex',
          'violet',
          ownerTeam,
          floorCenter,
          VORTEX_RADIUS,
          VORTEX_DURATION_SEC,
          entry.casterId
        );
        audioEvents.push('vortex_pull');
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public `cast`, `castForBot`, `notifyKill`, `resetRound`, and `update`
  // -------------------------------------------------------------------------

  /**
   * Projects Violet (Umbra) [X] Eclipse Curtain: 5 overlapping 3.6m-radius
   * opaque `void_smoke` spheres (~26m continuous shadow wall) forward along
   * the horizontal aim vector (`d = 4, 9, 14, 19, 24m`), clamped inside arena bounds.
   */
  function spawnEclipseCurtain(
    origin: Vec3,
    yaw: number,
    team: TeamId,
    casterId?: string
  ): void {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const baseY = Math.max(0, origin.y) + VOID_SMOKE_FLOOR_Y_OFFSET;

    for (let idx = 0; idx < UMBRA_ULT_DISTANCES.length; idx++) {
      const d = UMBRA_ULT_DISTANCES[idx];
      const cx = clamp(origin.x + fx * d, -UMBRA_ULT_CLAMP_X, UMBRA_ULT_CLAMP_X);
      const cz = clamp(origin.z + fz * d, -UMBRA_ULT_CLAMP_Z, UMBRA_ULT_CLAMP_Z);
      spawnZone(
        'void_smoke',
        'violet',
        team,
        { x: cx, y: baseY, z: cz },
        UMBRA_ULT_RADIUS,
        UMBRA_ULT_DURATION_SEC,
        casterId
      );
      if (idx === 0 || idx === 2 || idx === 4) {
        bursts.push(createSmokeShockwaveVisual({ x: cx, y: Math.max(0, origin.y), z: cz }, 0xc084fc));
      }
    }
  }

  function cast(slot: AbilitySlot, player: PlayerState, input: InputState): boolean {
    const colorId = player.colorId;

    // Signature [X] Ultimates (all 5 Agents)
    if (slot === 'x') {
      if (colorId === 'red') {
        blazeUltTimer = BLAZE_ULT_DURATION_SEC;
        cooldowns.red.q = 0; // Immediate Crimson Dash refresh
        bursts.push(createUltActivationRingVisual(player.position, AGENT_PALETTES.red.hex, 5.5));
        pendingAudioEvents.push('ult_blaze');
        return true;
      }

      if (colorId === 'blue') {
        mistUltTimer = MIST_ULT_DURATION_SEC;
        spawnProjectileFromOrigin(
          'slow_orb',
          'blue',
          playerTeam,
          player.position,
          input.yaw,
          input.pitch,
          MIST_ULT_PROJ_SPEED,
          MIST_ULT_PROJ_GRAVITY,
          MIST_ULT_PROJ_RESTITUTION,
          3.5,
          true,
          0.08,
          playerCasterId,
          true,
          smoothEyeHeightOffset,
          true
        );
        pendingAudioEvents.push('ult_mist');
        return true;
      }

      if (colorId === 'green') {
        activePulseUlts.push({
          team: playerTeam,
          origin: { ...player.position },
          elapsed: 0,
          remaining: PULSE_ULT_DURATION_SEC,
          wavesSpawned: 0,
        });
        pulseUltTimer = Math.max(pulseUltTimer, PULSE_ULT_DURATION_SEC);
        pendingAudioEvents.push('ult_pulse');
        return true;
      }

      if (colorId === 'violet') {
        umbraUltTimer = UMBRA_ULT_DURATION_SEC;
        spawnEclipseCurtain(player.position, input.yaw, playerTeam, playerCasterId);
        pendingAudioEvents.push('ult_umbra');
        return true;
      }

      if (colorId === 'gold') {
        voltUltTimer = VOLT_ULT_DURATION_SEC;
        voltUltZapTimer = 0.12;
        slideLockoutTimer = 0;
        walkArmedForSlide = !input.walk;
        bursts.push(createUltActivationRingVisual(player.position, AGENT_PALETTES.gold.hex, 8.5));
        pendingAudioEvents.push('ult_volt');
        return true;
      }

      return false;
    }

    // Special Case 1: Umbra (violet) [Q] Void Shroud (2 charges + mid-air re-tap bloom)
    if (colorId === 'violet' && slot === 'q') {
      const inFlightIdx = projectiles.findIndex(
        (p) => p.isPlayerCast && p.data.kind === 'void_orb'
      );
      if (inFlightIdx !== -1) {
        const activeOrb = projectiles[inFlightIdx];
        if (activeOrb.data.age > VOID_REBLOOM_MIN_AGE_SEC) {
          bloomVoidOrb(activeOrb, false, pendingAudioEvents);
          disposeObject3D(scene, activeOrb.group);
          projectiles.splice(inFlightIdx, 1);
          voidRecastLockTimer = VOID_RECAST_LOCK_SEC;
          return true;
        }
        return false;
      }

      if (voidCharges <= 0 || voidRecastLockTimer > 0) {
        return false;
      }

      voidCharges -= 1;
      if (voidRechargeTimer <= 0) {
        voidRechargeTimer = VOID_RECHARGE_SEC;
      }
      voidRecastLockTimer = VOID_RECAST_LOCK_SEC;

      spawnProjectileFromOrigin(
        'void_orb',
        'violet',
        playerTeam,
        player.position,
        input.yaw,
        input.pitch,
        VOID_ORB_SPEED,
        VOID_ORB_GRAVITY,
        0.0,
        VOID_ORB_MAX_LIFETIME,
        true,
        0.0,
        playerCasterId,
        true,
        smoothEyeHeightOffset
      );
      pendingAudioEvents.push('void_cast');
      return true;
    }

    // Special Case 2: Volt (gold) [Q] Overdrive + Electric Power Slide (also rapid-slides during Thunderstorm!)
    if (colorId === 'gold' && slot === 'q') {
      if (overdriveTimer > 0 || voltUltTimer > 0) {
        if (player.grounded && slideTimer <= 0 && slideLockoutTimer <= 0) {
          triggerPlayerPowerSlide(player, input, pendingAudioEvents);
          return true;
        }
        return false;
      }

      if (cooldowns.gold.q > 0) {
        return false;
      }

      cooldowns.gold.q = AGENT_ABILITIES.gold.q.cooldownSec;
      overdriveTimer = OVERDRIVE_DURATION_SEC;
      slideLockoutTimer = 0;
      walkArmedForSlide = !input.walk;
      pendingAudioEvents.push('overdrive_on');

      const horizSpeed = Math.hypot(player.velocity.x, player.velocity.z);
      if (player.grounded && horizSpeed >= SLIDE_SPRINT_THRESHOLD_MPS) {
        triggerPlayerPowerSlide(player, input, pendingAudioEvents);
      }
      return true;
    }

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
        playerTeam,
        player.position,
        input.yaw,
        input.pitch,
        FIRE_ORB_SPEED,
        FIRE_ORB_GRAVITY,
        FIRE_ORB_RESTITUTION,
        4.0,
        true,
        FIRE_ORB_UPWARD_LOB,
        playerCasterId,
        true,
        smoothEyeHeightOffset
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    if (colorId === 'blue' && slot === 'q') {
      spawnProjectileFromOrigin(
        'smoke_orb',
        'blue',
        playerTeam,
        player.position,
        input.yaw,
        input.pitch,
        SMOKE_ORB_SPEED,
        SMOKE_ORB_GRAVITY,
        SMOKE_ORB_RESTITUTION,
        4.0,
        true,
        SMOKE_ORB_UPWARD_LOB,
        playerCasterId,
        true,
        smoothEyeHeightOffset
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    if (colorId === 'blue' && slot === 'e') {
      spawnProjectileFromOrigin(
        'slow_orb',
        'blue',
        playerTeam,
        player.position,
        input.yaw,
        input.pitch,
        SLOW_ORB_SPEED,
        SLOW_ORB_GRAVITY,
        SLOW_ORB_RESTITUTION,
        4.0,
        true,
        SLOW_ORB_UPWARD_LOB,
        playerCasterId,
        true,
        smoothEyeHeightOffset
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    if (colorId === 'green' && slot === 'q') {
      spawnProjectileFromOrigin(
        'flash_orb',
        'green',
        playerTeam,
        player.position,
        input.yaw,
        input.pitch,
        FLASH_ORB_SPEED,
        FLASH_ORB_GRAVITY,
        FLASH_ORB_RESTITUTION,
        FLASH_FUSE_SEC,
        false,
        0.0,
        playerCasterId,
        true,
        smoothEyeHeightOffset
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    if (colorId === 'green' && slot === 'e') {
      spawnZone(
        'beacon',
        'green',
        playerTeam,
        { x: player.position.x, y: player.position.y, z: player.position.z },
        BEACON_RADIUS,
        BEACON_DURATION_SEC,
        playerCasterId
      );
      pendingAudioEvents.push('beacon_deploy');
      return true;
    }

    if (colorId === 'violet' && slot === 'e') {
      spawnProjectileFromOrigin(
        'vortex_orb',
        'violet',
        playerTeam,
        player.position,
        input.yaw,
        input.pitch,
        VORTEX_ORB_SPEED,
        VORTEX_ORB_GRAVITY,
        VORTEX_ORB_RESTITUTION,
        4.0,
        true,
        VORTEX_ORB_UPWARD_LOB,
        playerCasterId,
        true,
        smoothEyeHeightOffset
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    if (colorId === 'gold' && slot === 'e') {
      spawnProjectileFromOrigin(
        'relay_bolt',
        'gold',
        playerTeam,
        player.position,
        input.yaw,
        input.pitch,
        RELAY_BOLT_SPEED,
        RELAY_BOLT_GRAVITY,
        RELAY_BOLT_RESTITUTION,
        RELAY_BOLT_MAX_LIFETIME,
        false,
        0.0,
        playerCasterId,
        true,
        smoothEyeHeightOffset
      );
      pendingAudioEvents.push('throw');
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

    // Signature [X] Ultimates for AI Bots (all 5 Agents)
    if (slot === 'x') {
      if (bot.colorId === 'red') {
        botBlazeUlts.set(bot.id, {
          combatant: bot,
          timer: BLAZE_ULT_DURATION_SEC,
        });
        getOrInitBotCooldowns(bot.id).q = 0; // Immediate Dash refresh
        bursts.push(createUltActivationRingVisual(bot.position, AGENT_PALETTES.red.hex, 5.5));
        pendingAudioEvents.push('ult_blaze');
        return true;
      }

      if (bot.colorId === 'blue') {
        spawnProjectileFromOrigin(
          'slow_orb',
          'blue',
          bot.team,
          bot.position,
          aimYaw,
          aimPitch,
          MIST_ULT_PROJ_SPEED,
          MIST_ULT_PROJ_GRAVITY,
          MIST_ULT_PROJ_RESTITUTION,
          3.5,
          true,
          0.08,
          bot.id,
          false,
          0,
          true
        );
        pendingAudioEvents.push('ult_mist');
        return true;
      }

      if (bot.colorId === 'green') {
        activePulseUlts.push({
          team: bot.team,
          origin: { ...bot.position },
          elapsed: 0,
          remaining: PULSE_ULT_DURATION_SEC,
          wavesSpawned: 0,
        });
        if (bot.team === playerTeam) {
          pulseUltTimer = Math.max(pulseUltTimer, PULSE_ULT_DURATION_SEC);
        }
        pendingAudioEvents.push('ult_pulse');
        return true;
      }

      if (bot.colorId === 'violet') {
        spawnEclipseCurtain(bot.position, aimYaw, bot.team, bot.id);
        pendingAudioEvents.push('ult_umbra');
        return true;
      }

      if (bot.colorId === 'gold') {
        botVoltUlts.set(bot.id, {
          combatant: bot,
          timer: VOLT_ULT_DURATION_SEC,
          zapTimer: 0.15,
        });
        bursts.push(createUltActivationRingVisual(bot.position, AGENT_PALETTES.gold.hex, 8.5));
        pendingAudioEvents.push('ult_volt');
        return true;
      }

      return false;
    }

    if (bot.colorId === 'violet' && slot === 'q') {
      const vState = getOrInitBotVoidState(bot.id);
      if (vState.charges <= 0 || vState.recastLock > 0) {
        return false;
      }
      vState.charges -= 1;
      if (vState.rechargeTimer <= 0) {
        vState.rechargeTimer = VOID_RECHARGE_SEC;
      }
      vState.recastLock = 0.65;

      spawnProjectileFromOrigin(
        'void_orb',
        'violet',
        bot.team,
        bot.position,
        aimYaw,
        aimPitch,
        VOID_ORB_SPEED,
        VOID_ORB_GRAVITY,
        0.0,
        VOID_ORB_MAX_LIFETIME,
        true,
        0.0,
        bot.id
      );
      pendingAudioEvents.push('void_cast');
      return true;
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
        FIRE_ORB_UPWARD_LOB,
        bot.id
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
        SMOKE_ORB_UPWARD_LOB,
        bot.id
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
        SLOW_ORB_UPWARD_LOB,
        bot.id
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
        0.0,
        bot.id
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
        BEACON_DURATION_SEC,
        bot.id
      );
      pendingAudioEvents.push('beacon_deploy');
      return true;
    }

    if (bot.colorId === 'violet' && slot === 'e') {
      spawnProjectileFromOrigin(
        'vortex_orb',
        'violet',
        bot.team,
        bot.position,
        aimYaw,
        aimPitch,
        VORTEX_ORB_SPEED,
        VORTEX_ORB_GRAVITY,
        VORTEX_ORB_RESTITUTION,
        4.0,
        true,
        VORTEX_ORB_UPWARD_LOB,
        bot.id
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    if (bot.colorId === 'gold' && slot === 'q') {
      const dir: Vec3 = { x: -Math.sin(aimYaw), y: 0, z: -Math.cos(aimYaw) };
      bot.slideTimer = SLIDE_DURATION_SEC;
      bot.velocity.x = dir.x * SLIDE_PEAK_SPEED_MPS;
      bot.velocity.z = dir.z * SLIDE_PEAK_SPEED_MPS;
      botSlides.set(bot.id, {
        combatant: bot,
        slideTimer: SLIDE_DURATION_SEC,
        overdriveTimer: OVERDRIVE_DURATION_SEC,
        dir,
      });
      bursts.push(createSlideSparksVisual(bot.position, dir));
      pendingAudioEvents.push('overdrive_on', 'power_slide');
      return true;
    }

    if (bot.colorId === 'gold' && slot === 'e') {
      spawnProjectileFromOrigin(
        'relay_bolt',
        'gold',
        bot.team,
        bot.position,
        aimYaw,
        aimPitch,
        RELAY_BOLT_SPEED,
        RELAY_BOLT_GRAVITY,
        RELAY_BOLT_RESTITUTION,
        RELAY_BOLT_MAX_LIFETIME,
        false,
        0.02,
        bot.id
      );
      pendingAudioEvents.push('throw');
      return true;
    }

    return false;
  }

  function notifyKill(killerColor: AgentColorId, isPlayer: boolean): void {
    if (killerColor !== 'red') return;
    if (isPlayer) {
      if (blazeUltTimer > 0) {
        cooldowns.red.q = 0; // Inferno Overdrive kill refreshes Crimson Dash!
      }
    } else {
      for (const [botId, entry] of botBlazeUlts.entries()) {
        if (entry.timer > 0 && entry.combatant.alive) {
          getOrInitBotCooldowns(botId).q = 0;
        }
      }
    }
  }

  function runVoltThunderstormZap(
    casterPos: Vec3,
    casterTeam: TeamId,
    casterId: string,
    colliders: AABB[],
    targetsMgr: TargetsManager,
    audioEvents: AbilityAudioEvent[],
    allCombatants?: Combatant[]
  ): void {
    const casterChest: Vec3 = {
      x: casterPos.x,
      y: casterPos.y + 1.25,
      z: casterPos.z,
    };
    let zappedAny = false;

    if (allCombatants) {
      for (const c of allCombatants) {
        if (!c.alive || c.team === casterTeam || c.id === casterId) continue;
        const targetChest: Vec3 = {
          x: c.position.x,
          y: c.position.y + 1.2,
          z: c.position.z,
        };
        const dist = Math.hypot(
          targetChest.x - casterChest.x,
          targetChest.y - casterChest.y,
          targetChest.z - casterChest.z
        );
        if (dist <= VOLT_ULT_ZAP_RADIUS_M && hasLineOfSight(casterChest, targetChest, colliders)) {
          targetsMgr.applyDamage(c.id, VOLT_ULT_ZAP_DAMAGE, false);
          c.concussTimer = Math.max(c.concussTimer ?? 0, VOLT_ULT_ZAP_CONCUSS_SEC);
          if (c.isPlayer) {
            playerConcussTimer = Math.max(playerConcussTimer, VOLT_ULT_ZAP_CONCUSS_SEC);
          }
          bursts.push(createChainLightningArcVisual(casterChest, targetChest));
          zappedAny = true;
        }
      }
    } else if (casterTeam === 'ally') {
      for (const target of targetsMgr.targets) {
        if (!target.alive) continue;
        const targetChest: Vec3 = {
          x: target.position.x,
          y: target.position.y + 1.2,
          z: target.position.z,
        };
        const dist = Math.hypot(
          targetChest.x - casterChest.x,
          targetChest.y - casterChest.y,
          targetChest.z - casterChest.z
        );
        if (dist <= VOLT_ULT_ZAP_RADIUS_M && hasLineOfSight(casterChest, targetChest, colliders)) {
          targetsMgr.applyDamage(target.id, VOLT_ULT_ZAP_DAMAGE, false);
          target.concussTimer = Math.max(target.concussTimer ?? 0, VOLT_ULT_ZAP_CONCUSS_SEC);
          bursts.push(createChainLightningArcVisual(casterChest, targetChest));
          zappedAny = true;
        }
      }
    }

    if (zappedAny) {
      audioEvents.push('relay_zap');
    }
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
    zoneSeq = 0;
    dashTimer = 0;
    playerFlashTimer = 0;
    voidCharges = VOID_MAX_CHARGES;
    voidRechargeTimer = 0;
    voidRecastLockTimer = 0;
    overdriveTimer = 0;
    slideTimer = 0;
    slideLockoutTimer = 0;
    walkArmedForSlide = true;
    smoothEyeHeightOffset = 0;
    playerConcussTimer = 0;

    blazeUltTimer = 0;
    mistUltTimer = 0;
    pulseUltTimer = 0;
    umbraUltTimer = 0;
    voltUltTimer = 0;
    voltUltZapTimer = 0;
    activePulseUlts.length = 0;

    botDashes.clear();
    botSlides.clear();
    botVoidStates.clear();
    botBlazeUlts.clear();
    botVoltUlts.clear();

    for (const color of AGENT_ORDER) {
      cooldowns[color].q = 0;
      cooldowns[color].e = 0;
      cooldowns[color].x = 0;
    }
    for (const cd of botCooldowns.values()) {
      cd.q = 0;
      cd.e = 0;
      cd.x = 0;
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

    const pc = allCombatants?.find((c) => c.isPlayer);
    if (pc) {
      playerTeam = pc.team;
      playerCasterId = pc.id;
    } else {
      playerTeam = 'ally';
      playerCasterId = 'player';
    }

    // 1. Tick all 5 agent cooldowns & multi-charge timers independently.
    for (const color of AGENT_ORDER) {
      cooldowns[color].q = Math.max(0, cooldowns[color].q - stepDt);
      cooldowns[color].e = Math.max(0, cooldowns[color].e - stepDt);
      cooldowns[color].x = Math.max(0, cooldowns[color].x - stepDt);
    }

    voidRecastLockTimer = Math.max(0, voidRecastLockTimer - stepDt);
    if (voidCharges < VOID_MAX_CHARGES) {
      voidRechargeTimer -= stepDt;
      if (voidRechargeTimer <= 0) {
        voidCharges += 1;
        voidRechargeTimer = voidCharges < VOID_MAX_CHARGES ? VOID_RECHARGE_SEC : 0;
      }
    } else {
      voidRechargeTimer = 0;
    }
    cooldowns.violet.q = voidCharges > 0 ? voidRecastLockTimer : voidRechargeTimer;

    for (const cd of botCooldowns.values()) {
      cd.q = Math.max(0, cd.q - stepDt);
      cd.e = Math.max(0, cd.e - stepDt);
      cd.x = Math.max(0, cd.x - stepDt);
    }
    for (const vState of botVoidStates.values()) {
      vState.recastLock = Math.max(0, vState.recastLock - stepDt);
      if (vState.charges < VOID_MAX_CHARGES) {
        vState.rechargeTimer -= stepDt;
        if (vState.rechargeTimer <= 0) {
          vState.charges += 1;
          vState.rechargeTimer = vState.charges < VOID_MAX_CHARGES ? VOID_RECHARGE_SEC : 0;
        }
      } else {
        vState.rechargeTimer = 0;
      }
    }

    // Tick active AI bot Blaze & Volt Ultimates
    for (const [botId, entry] of botBlazeUlts.entries()) {
      if (!entry.combatant.alive || entry.timer <= 0) {
        botBlazeUlts.delete(botId);
        continue;
      }
      entry.timer = Math.max(0, entry.timer - stepDt);
      if (entry.timer <= 0) {
        botBlazeUlts.delete(botId);
      }
    }

    for (const [botId, entry] of botVoltUlts.entries()) {
      if (!entry.combatant.alive || entry.timer <= 0) {
        botVoltUlts.delete(botId);
        continue;
      }
      entry.timer = Math.max(0, entry.timer - stepDt);
      entry.zapTimer -= stepDt;
      if (entry.zapTimer <= 0) {
        entry.zapTimer = VOLT_ULT_ZAP_INTERVAL_SEC;
        runVoltThunderstormZap(
          entry.combatant.position,
          entry.combatant.team,
          entry.combatant.id,
          colliders,
          targetsMgr,
          audioEvents,
          allCombatants
        );
      }
      if (entry.timer <= 0) {
        botVoltUlts.delete(botId);
      }
    }

    // Tick active Pulse [X] Orbital Recon waves (3 arena-wide emerald sonar waves at t = 0s, 2.2s, 4.4s)
    let teamPulseRemain = 0;
    for (let i = activePulseUlts.length - 1; i >= 0; i--) {
      const pu = activePulseUlts[i];
      while (
        pu.wavesSpawned < PULSE_ULT_WAVE_TIMES.length &&
        pu.elapsed >= PULSE_ULT_WAVE_TIMES[pu.wavesSpawned]
      ) {
        bursts.push(createOrbitalSonarWaveVisual(pu.origin));
        if (pu.wavesSpawned > 0) {
          audioEvents.push('ult_pulse');
        }
        pu.wavesSpawned += 1;
      }
      pu.elapsed += stepDt;
      pu.remaining -= stepDt;
      if (pu.remaining <= 0) {
        activePulseUlts.splice(i, 1);
      } else if (pu.team === playerTeam) {
        teamPulseRemain = Math.max(teamPulseRemain, pu.remaining);
      }
    }
    pulseUltTimer = teamPulseRemain;

    mistUltTimer = Math.max(0, mistUltTimer - stepDt);
    umbraUltTimer = Math.max(0, umbraUltTimer - stepDt);

    if (!allCombatants) {
      for (const target of targetsMgr.targets) {
        if (target.vulnerableTimer) {
          target.vulnerableTimer = Math.max(0, target.vulnerableTimer - stepDt);
        }
        if (target.concussTimer) {
          target.concussTimer = Math.max(0, target.concussTimer - stepDt);
        }
      }
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

    // Tick active AI bot Volt Power-Slide & Overdrive impulses
    for (const [botId, slide] of botSlides.entries()) {
      if (!slide.combatant.alive || (slide.slideTimer <= 0 && slide.overdriveTimer <= 0)) {
        if (slide.combatant) slide.combatant.slideTimer = 0;
        botSlides.delete(botId);
        continue;
      }
      if (slide.slideTimer > 0) {
        const remainFrac = clamp(slide.slideTimer / SLIDE_DURATION_SEC, 0, 1);
        const speed =
          SLIDE_END_SPEED_MPS +
          (SLIDE_PEAK_SPEED_MPS - SLIDE_END_SPEED_MPS) * Math.pow(remainFrac, 3.0);
        slide.combatant.velocity.x = slide.dir.x * speed;
        slide.combatant.velocity.z = slide.dir.z * speed;
        slide.slideTimer = Math.max(0, slide.slideTimer - stepDt);
        slide.combatant.slideTimer = slide.slideTimer;
      }
      slide.overdriveTimer = Math.max(0, slide.overdriveTimer - stepDt);
      if (slide.slideTimer <= 0 && slide.overdriveTimer <= 0) {
        botSlides.delete(botId);
      }
    }

    // 2. Tick Crimson Dash, Blaze Ult & Volt Overdrive / Electric Power Slide / Thunderstorm
    if (player.colorId !== 'red' || player.health <= 0) {
      dashTimer = 0;
      blazeUltTimer = 0;
    }
    if (player.colorId !== 'gold' || player.health <= 0) {
      overdriveTimer = 0;
      slideTimer = 0;
      slideLockoutTimer = 0;
      voltUltTimer = 0;
      voltUltZapTimer = 0;
    }

    slideLockoutTimer = Math.max(0, slideLockoutTimer - stepDt);

    if (overdriveTimer > 0 || voltUltTimer > 0) {
      if (!input.walk) {
        walkArmedForSlide = true;
      } else if (
        walkArmedForSlide &&
        player.grounded &&
        slideTimer <= 0 &&
        slideLockoutTimer <= 0
      ) {
        triggerPlayerPowerSlide(player, input, audioEvents);
        walkArmedForSlide = false;
      }
    }

    const crimsonDashActive = dashTimer > 0;
    const slideActive = slideTimer > 0;
    let dashAlpha = 0;
    let overdriveAlpha = 0;
    let dashVelocity: Vec3 = { x: 0, y: 0, z: 0 };

    if (crimsonDashActive) {
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
    } else if (slideActive) {
      const elapsedSlide = SLIDE_DURATION_SEC - slideTimer;
      const remainFrac = clamp(1 - elapsedSlide / SLIDE_DURATION_SEC, 0, 1);
      const slideSpeed =
        SLIDE_END_SPEED_MPS +
        (SLIDE_PEAK_SPEED_MPS - SLIDE_END_SPEED_MPS) * Math.pow(remainFrac, 3.0);
      dashVelocity = {
        x: slideDir.x * slideSpeed,
        y: player.grounded ? -2.5 : player.velocity.y - 21.0 * stepDt,
        z: slideDir.z * slideSpeed,
      };
      slideTimer = Math.max(0, slideTimer - stepDt);
    }

    if (pc) {
      pc.slideTimer = slideActive ? Math.max(slideTimer, 0.001) : 0;
    }

    const targetEyeOffset = slideActive ? SLIDE_EYE_HEIGHT_OFFSET : 0;
    smoothEyeHeightOffset +=
      (targetEyeOffset - smoothEyeHeightOffset) * (1 - Math.exp(-20 * stepDt));
    if (!slideActive && Math.abs(smoothEyeHeightOffset) < 0.002) {
      smoothEyeHeightOffset = 0;
    }

    const movement: MovementModifiers = {
      dashActive: crimsonDashActive || slideActive,
      dashVelocity,
      speedMultiplier: 1.0,
      suppressJump: false,
      slideActive,
    };

    if (voltUltTimer > 0) {
      movement.speedMultiplier *= VOLT_ULT_SPEED_MULT;
      overdriveAlpha = Math.max(
        overdriveAlpha,
        clamp(voltUltTimer / 0.5, 0, 1) * (slideActive ? 1.0 : 0.85)
      );
      voltUltTimer = Math.max(0, voltUltTimer - stepDt);
      voltUltZapTimer -= stepDt;
      if (voltUltZapTimer <= 0) {
        voltUltZapTimer = VOLT_ULT_ZAP_INTERVAL_SEC;
        runVoltThunderstormZap(
          player.position,
          playerTeam,
          playerCasterId,
          colliders,
          targetsMgr,
          audioEvents,
          allCombatants
        );
      }
      if (overdriveTimer > 0) {
        overdriveTimer = Math.max(0, overdriveTimer - stepDt);
      }
    } else if (overdriveTimer > 0) {
      movement.speedMultiplier *= OVERDRIVE_SPEED_MULT;
      overdriveAlpha = clamp(overdriveTimer / 0.5, 0, 1) * (slideActive ? 1.0 : 0.65);
      overdriveTimer = Math.max(0, overdriveTimer - stepDt);
    }

    const blazeUltActive = blazeUltTimer > 0;
    if (blazeUltActive) {
      movement.speedMultiplier *= BLAZE_ULT_SPEED_MULT;
      dashAlpha = Math.max(dashAlpha, 0.36 * clamp(blazeUltTimer / 0.6, 0, 1));
      blazeUltTimer = Math.max(0, blazeUltTimer - stepDt);
    }

    if (pulseUltTimer > 0) {
      movement.speedMultiplier *= PULSE_ULT_TEAM_SPEED_MULT;
    }

    // 3. Step active projectiles with swept ray-AABB bounce physics
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const entry = projectiles[i];
      const { hit, hitHorizontalSurface } = stepProjectile(entry.data, colliders, stepDt);
      entry.group.position.set(
        entry.data.position.x,
        entry.data.position.y,
        entry.data.position.z
      );
      entry.group.rotation.y += stepDt * 6.0;
      entry.group.rotation.x += stepDt * 4.0;

      // Volt [E] Relay Bolt: Bounce #1 spawns Shock Zone #1; Impact #2 (or maxLifetime) spawns Shock Zone #2
      if (entry.data.kind === 'relay_bolt') {
        const ownerTeam = entry.ownerTeam ?? entry.team;
        if (hit !== null) {
          const shockCenter = projectPointToFloor(hit.point, hit.normal, colliders);
          if (entry.bounces === 0) {
            entry.bounces = 1;
            audioEvents.push('relay_bounce');
            spawnZone(
              'relay_shock',
              'gold',
              ownerTeam,
              shockCenter,
              RELAY_SHOCK_RADIUS,
              RELAY_SHOCK_DURATION_SEC,
              entry.casterId
            );
            if (entry.data.age >= entry.data.maxLifetime) {
              disposeObject3D(scene, entry.group);
              projectiles.splice(i, 1);
            }
          } else {
            spawnZone(
              'relay_shock',
              'gold',
              ownerTeam,
              shockCenter,
              RELAY_SHOCK_RADIUS,
              RELAY_SHOCK_DURATION_SEC,
              entry.casterId
            );
            disposeObject3D(scene, entry.group);
            projectiles.splice(i, 1);
          }
        } else if (entry.data.age >= entry.data.maxLifetime) {
          const shockCenter = projectPointToFloor(entry.data.position, null, colliders);
          spawnZone(
            'relay_shock',
            'gold',
            ownerTeam,
            shockCenter,
            RELAY_SHOCK_RADIUS,
            RELAY_SHOCK_DURATION_SEC,
            entry.casterId
          );
          disposeObject3D(scene, entry.group);
          projectiles.splice(i, 1);
        }
        continue;
      }

      // Umbra [Q] Void Shroud: auto-blooms on any wall/floor impact or at maxLifetime (0.50s ~16m)
      if (entry.data.kind === 'void_orb') {
        if (hit !== null || entry.data.age >= entry.data.maxLifetime) {
          bloomVoidOrb(entry, Boolean(hit && hit.normal.y >= 0.5), audioEvents);
          disposeObject3D(scene, entry.group);
          projectiles.splice(i, 1);
        }
        continue;
      }

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
    let moveSpreadMultiplier = 1.0;
    let stimActive = pulseUltTimer > 0;
    let playerInSlow = false;
    let playerInBlizzard = false;
    let playerInBeacon = false;
    let playerInVortex = false;
    let playerExtVelX = 0;
    let playerExtVelZ = 0;

    const playerEye: Vec3 = {
      x: player.position.x,
      y: player.position.y + EYE_HEIGHT + smoothEyeHeightOffset,
      z: player.position.z,
    };

    for (let i = zones.length - 1; i >= 0; i--) {
      const entry = zones[i];
      const zone = entry.data;
      const ownerTeam = entry.ownerTeam ?? entry.team;
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
              if (c.team !== ownerTeam) {
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
      } else if (zone.kind === 'smoke' || zone.kind === 'void_smoke') {
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

        // Hollow-Smoke Seam-Masking (shared identically by Mist Smoke & Umbra Void Shroud):
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
        const slowRefreshSec = entry.isBlizzard
          ? MIST_ULT_SLOW_REFRESH_SEC
          : SLOW_TARGET_STATUS_REFRESH_SEC;
        if (allCombatants) {
          for (const c of allCombatants) {
            if (!c.alive) continue;
            // Glacial Whiteout spares caster's own allies from the harsh 75% blizzard slow
            if (entry.isBlizzard && c.team === ownerTeam) continue;
            const dx = c.position.x - zone.center.x;
            const dz = c.position.z - zone.center.z;
            if (
              dx * dx + dz * dz <= rSq &&
              Math.abs(c.position.y - zone.center.y) <= ZONE_VERTICAL_TOLERANCE_M
            ) {
              targetsMgr.applyStatus(c.id, 'slow', slowRefreshSec);
              if (c.isPlayer) {
                if (entry.isBlizzard) {
                  playerInBlizzard = true;
                } else {
                  playerInSlow = true;
                }
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
              targetsMgr.applyStatus(target.id, 'slow', slowRefreshSec);
            }
          }

          if (!entry.isBlizzard) {
            const pdx = player.position.x - zone.center.x;
            const pdz = player.position.z - zone.center.z;
            if (
              pdx * pdx + pdz * pdz <= rSq &&
              Math.abs(player.position.y - zone.center.y) <= ZONE_VERTICAL_TOLERANCE_M
            ) {
              playerInSlow = true;
            }
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
            if (!c.alive || c.team !== ownerTeam) continue;
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
      } else if (zone.kind === 'vortex') {
        const fade =
          clamp(zone.remainingSec / 0.45, 0, 1) * clamp(elapsed / 0.16, 0.25, 1.0);
        if (entry.visual.singularityMat) {
          entry.visual.singularityMat.uniforms.uTime.value = elapsed;
          entry.visual.singularityMat.uniforms.uFade.value = fade;
        }
        if (entry.visual.rimMat) {
          entry.visual.rimMat.opacity = 0.74 * fade;
        }
        if (entry.visual.coreMesh && entry.visual.coreMat) {
          const pulse = 0.92 + 0.14 * Math.sin(elapsed * 7.0);
          entry.visual.coreMesh.scale.setScalar(pulse);
          entry.visual.coreMat.opacity = 0.96 * fade;
        }
        if (entry.visual.particles) {
          updateInwardVortexParticles(entry.visual.particles, elapsed, 0.92 * fade);
        }

        if (allCombatants) {
          for (const c of allCombatants) {
            if (!c.alive || c.team === ownerTeam || c.id === entry.casterId) continue;
            const dx = zone.center.x - c.position.x;
            const dz = zone.center.z - c.position.z;
            const dist = Math.hypot(dx, dz);
            if (
              dist <= zone.radius &&
              Math.abs(c.position.y - zone.center.y) <= ZONE_VERTICAL_TOLERANCE_M
            ) {
              c.vulnerableTimer = Math.max(c.vulnerableTimer ?? 0, VORTEX_FRAGILE_SEC);
              if (c.isPlayer) {
                playerInVortex = true;
                if (dist > 0.15) {
                  const ramp = Math.min(1, dist / 0.6);
                  const pullSpeed = VORTEX_PULL_MAX_SPEED_MPS * ramp;
                  playerExtVelX += (dx / dist) * pullSpeed;
                  playerExtVelZ += (dz / dist) * pullSpeed;
                }
              } else {
                targetsMgr.applyStatus(c.id, 'slow', 0.25);
                if (dist > 0.15) {
                  const nx = dx / dist;
                  const nz = dz / dist;
                  const ramp = Math.min(1, dist / 0.6);
                  const targetPull = VORTEX_PULL_MAX_SPEED_MPS * ramp;
                  const inwardComp = c.velocity.x * nx + c.velocity.z * nz;
                  const accelDelta = Math.min(
                    Math.max(0, targetPull * 1.18 - inwardComp),
                    (VORTEX_PULL_ACCEL_MPS2 + 26.0) * stepDt
                  );
                  c.velocity.x = c.velocity.x * 0.85 + nx * accelDelta;
                  c.velocity.z = c.velocity.z * 0.85 + nz * accelDelta;
                }
              }
            }
          }
        } else if (ownerTeam === 'ally') {
          for (const target of targetsMgr.targets) {
            if (!target.alive) continue;
            const dx = zone.center.x - target.position.x;
            const dz = zone.center.z - target.position.z;
            const dist = Math.hypot(dx, dz);
            if (
              dist <= zone.radius &&
              Math.abs(target.position.y - zone.center.y) <= ZONE_VERTICAL_TOLERANCE_M
            ) {
              target.vulnerableTimer = Math.max(
                target.vulnerableTimer ?? 0,
                VORTEX_FRAGILE_SEC
              );
              targetsMgr.applyStatus(target.id, 'slow', 0.25);
              if (dist > 0.15) {
                const ramp = Math.min(1, dist / 0.6);
                const pullStep = VORTEX_PULL_MAX_SPEED_MPS * ramp * stepDt;
                target.position.x += (dx / dist) * pullStep;
                target.position.z += (dz / dist) * pullStep;
              }
            }
          }
        }
      } else if (zone.kind === 'relay_shock') {
        if (elapsed < RELAY_SHOCK_ARM_SEC) {
          const armFrac = clamp(elapsed / RELAY_SHOCK_ARM_SEC, 0, 1);
          if (entry.visual.relayMat) {
            entry.visual.relayMat.uniforms.uTime.value = elapsed;
            entry.visual.relayMat.uniforms.uIntensity.value = 0.6;
            entry.visual.relayMat.uniforms.uFade.value = 1.0;
          }
          if (entry.visual.rimMat) {
            entry.visual.rimMat.opacity = 0.55 + 0.35 * armFrac;
          }
        } else {
          if (!entry.discharged) {
            entry.discharged = true;
            audioEvents.push('relay_zap');
            if (entry.visual.lightningGroup) {
              entry.visual.lightningGroup.visible = true;
            }

            const rSq = zone.radius * zone.radius;
            if (allCombatants) {
              for (const c of allCombatants) {
                if (!c.alive || c.team === ownerTeam || c.id === entry.casterId) continue;
                const dx = c.position.x - zone.center.x;
                const dz = c.position.z - zone.center.z;
                if (
                  dx * dx + dz * dz <= rSq &&
                  Math.abs(c.position.y - zone.center.y) <= ZONE_VERTICAL_TOLERANCE_M
                ) {
                  targetsMgr.applyDamage(c.id, RELAY_SHOCK_DAMAGE, false);
                  c.concussTimer = Math.max(
                    c.concussTimer ?? 0,
                    RELAY_CONCUSS_DURATION_SEC
                  );
                  if (c.isPlayer) {
                    playerConcussTimer = Math.max(
                      playerConcussTimer,
                      RELAY_CONCUSS_DURATION_SEC
                    );
                  }
                }
              }
            } else if (ownerTeam === 'ally') {
              for (const target of targetsMgr.targets) {
                if (!target.alive) continue;
                const dx = target.position.x - zone.center.x;
                const dz = target.position.z - zone.center.z;
                if (
                  dx * dx + dz * dz <= rSq &&
                  Math.abs(target.position.y - zone.center.y) <= ZONE_VERTICAL_TOLERANCE_M
                ) {
                  targetsMgr.applyDamage(target.id, RELAY_SHOCK_DAMAGE, false);
                  target.concussTimer = Math.max(
                    target.concussTimer ?? 0,
                    RELAY_CONCUSS_DURATION_SEC
                  );
                  targetsMgr.applyStatus(target.id, 'slow', RELAY_CONCUSS_DURATION_SEC);
                }
              }
            }
          }

          const postFade = clamp(
            zone.remainingSec / (RELAY_SHOCK_DURATION_SEC - RELAY_SHOCK_ARM_SEC),
            0,
            1
          );
          if (entry.visual.relayMat) {
            entry.visual.relayMat.uniforms.uTime.value = elapsed;
            entry.visual.relayMat.uniforms.uIntensity.value = 2.2;
            entry.visual.relayMat.uniforms.uFade.value = postFade;
          }
          if (entry.visual.rimMat) {
            entry.visual.rimMat.opacity = 0.95 * postFade;
          }
          if (entry.visual.lightningGroup && entry.visual.lightningMat) {
            entry.visual.lightningGroup.rotation.y = Math.floor(elapsed * 24) * 1.9;
            entry.visual.lightningMat.opacity = 0.95 * postFade;
          }
        }
      }
    }

    if (playerInBlizzard) {
      movement.speedMultiplier *= MIST_ULT_PLAYER_SPEED_MULT;
      movement.suppressJump = true;
    } else if (playerInSlow) {
      movement.speedMultiplier *= SLOW_PLAYER_SPEED_MULT;
      movement.suppressJump = true;
    }

    if (playerInVortex) {
      movement.speedMultiplier *= VORTEX_SPEED_MULT;
      movement.suppressJump = true;
      const extMag = Math.hypot(playerExtVelX, playerExtVelZ);
      if (extMag > VORTEX_PULL_MAX_SPEED_MPS) {
        const scale = VORTEX_PULL_MAX_SPEED_MPS / extMag;
        playerExtVelX *= scale;
        playerExtVelZ *= scale;
      }
      movement.externalVelocity = {
        x: playerExtVelX,
        y: 0,
        z: playerExtVelZ,
      };
    }

    if (playerInBeacon) {
      if (!allCombatants) {
        player.health = Math.min(player.maxHealth, player.health + BEACON_HEAL_PER_SEC * stepDt);
      }
      stimActive = true;
      movement.speedMultiplier *= BEACON_SPEED_MULT;
      fireRateMultiplier *= BEACON_FIRE_RATE_MULT;
      recoilMultiplier *= BEACON_RECOIL_MULT;
    }

    if (blazeUltActive) {
      fireRateMultiplier *= BLAZE_ULT_FIRE_RATE_MULT;
      recoilMultiplier *= BLAZE_ULT_RECOIL_MULT;
    }

    if (slideActive) {
      moveSpreadMultiplier = 0;
      recoilMultiplier *= SLIDE_RECOIL_MULT;
    }

    playerConcussTimer = Math.max(0, playerConcussTimer - stepDt);
    const activePlayerConcuss = Math.max(playerConcussTimer, pc?.concussTimer ?? 0);
    if (pc && activePlayerConcuss > 0) {
      pc.concussTimer = activePlayerConcuss;
    }

    let concussAlpha = 0;
    if (activePlayerConcuss > 0 && player.health > 0) {
      movement.speedMultiplier *= CONCUSS_SPEED_MULT;
      fireRateMultiplier *= CONCUSS_FIRE_RATE_MULT;
      moveSpreadMultiplier *= CONCUSS_MOVE_SPREAD_MULT;
      concussAlpha = clamp(activePlayerConcuss / 0.6, 0, 1) * 0.85;
    }

    // 5. Update transient bursts (dash wind tunnel, smoke shockwave, slide sparks, flash starbursts, ult FX)
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
      } else if (burst.kind === 'slide_sparks') {
        const stretch = 1.0 + t * 0.75;
        burst.group.scale.set(1.0 + t * 0.12, 1.0, stretch);
        (burst.materials[0] as THREE.MeshBasicMaterial).opacity = 0.92 * (1 - t);
        (burst.materials[1] as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - t);
      } else if (burst.kind === 'smoke_shockwave') {
        const easeOut = 1 - Math.pow(1 - t, 3);
        burst.group.scale.setScalar(0.35 + easeOut * 4.45);
        (burst.materials[0] as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t);
      } else if (burst.kind === 'ult_ring') {
        const easeOut = 1 - Math.pow(1 - t, 2.5);
        const targetR = burst.maxScale ?? 6.2;
        const r = 0.45 + easeOut * (targetR - 0.45);
        burst.group.scale.set(r, 1.0 + t * 0.5, r);
        (burst.materials[0] as THREE.MeshBasicMaterial).opacity = 0.92 * (1 - t);
        (burst.materials[1] as THREE.MeshBasicMaterial).opacity = 0.34 * (1 - t);
      } else if (burst.kind === 'sonar_wave') {
        const easeOut = 1 - Math.pow(1 - t, 1.8);
        const targetR = burst.maxScale ?? PULSE_ULT_WAVE_MAX_RADIUS;
        const r = 0.6 + easeOut * (targetR - 0.6);
        burst.group.scale.set(r, 1.0, r);
        const fade = Math.pow(1 - t, 1.25);
        (burst.materials[0] as THREE.MeshBasicMaterial).opacity = 0.9 * fade;
        (burst.materials[1] as THREE.MeshBasicMaterial).opacity = 0.28 * fade;
      } else if (burst.kind === 'lightning_arc') {
        const fade = 1 - t;
        (burst.materials[0] as THREE.LineBasicMaterial).opacity = 0.98 * fade;
        (burst.materials[1] as THREE.LineBasicMaterial).opacity = 0.82 * fade;
        (burst.materials[2] as THREE.MeshBasicMaterial).opacity = 0.95 * fade;
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
    const xSpec = AGENT_ABILITIES[player.colorId].x;
    const qCd = cooldowns[player.colorId].q;
    const eCd = cooldowns[player.colorId].e;

    let qHud: AbilityHudSlotState;
    if (player.colorId === 'violet') {
      const hasBloomableVoidOrb = projectiles.some(
        (p) =>
          p.isPlayerCast &&
          p.data.kind === 'void_orb' &&
          p.data.age > VOID_REBLOOM_MIN_AGE_SEC
      );
      const canCastVoid =
        hasBloomableVoidOrb || (voidCharges > 0 && voidRecastLockTimer <= 0);
      const qRemain = hasBloomableVoidOrb
        ? 0
        : voidCharges > 0
          ? voidRecastLockTimer
          : voidRechargeTimer;

      qHud = {
        name: qSpec.name,
        shortTag: qSpec.shortTag,
        cooldownRemaining: qRemain,
        cooldownTotal: qSpec.cooldownSec,
        ready: canCastVoid,
        charges: voidCharges,
        maxCharges: VOID_MAX_CHARGES,
      };
    } else if (player.colorId === 'gold') {
      const canSlideNow =
        (overdriveTimer > 0 || voltUltTimer > 0) &&
        player.grounded &&
        slideTimer <= 0 &&
        slideLockoutTimer <= 0;
      const activeSprint = Math.max(overdriveTimer, voltUltTimer);
      qHud = {
        name: qSpec.name,
        shortTag: qSpec.shortTag,
        cooldownRemaining: activeSprint > 0 ? 0 : qCd,
        cooldownTotal: qSpec.cooldownSec,
        ready: activeSprint > 0 ? canSlideNow : qCd <= 0,
        activeTimer: activeSprint > 0 ? activeSprint : undefined,
      };
    } else {
      qHud = {
        name: qSpec.name,
        shortTag: qSpec.shortTag,
        cooldownRemaining: qCd,
        cooldownTotal: qSpec.cooldownSec,
        ready: qCd <= 0,
      };
    }

    const eHud: AbilityHudSlotState = {
      name: eSpec.name,
      shortTag: eSpec.shortTag,
      cooldownRemaining: eCd,
      cooldownTotal: eSpec.cooldownSec,
      ready: eCd <= 0,
    };

    const playerUltActiveRemain =
      player.colorId === 'red'
        ? blazeUltTimer
        : player.colorId === 'blue'
          ? mistUltTimer
          : player.colorId === 'green'
            ? pulseUltTimer
            : player.colorId === 'violet'
              ? umbraUltTimer
              : voltUltTimer;
    const xReq = xSpec.ultPointsRequired ?? 5;
    const xReady = (pc?.ultPoints ?? 0) >= xReq;
    const xHud: AbilityHudSlotState = {
      name: xSpec.name,
      shortTag: xSpec.shortTag,
      cooldownRemaining: xReady ? 0 : Math.max(0, xReq - (pc?.ultPoints ?? 0)),
      cooldownTotal: xReq,
      ready: xReady,
      activeTimer: playerUltActiveRemain > 0 ? playerUltActiveRemain : undefined,
    };

    return {
      movement,
      fireRateMultiplier,
      recoilMultiplier,
      moveSpreadMultiplier,
      eyeHeightOffset: smoothEyeHeightOffset,
      audioEvents,
      activeSmokes,
      insideSmokeFactor,
      flashAlpha,
      dashAlpha,
      overdriveAlpha,
      concussAlpha,
      stimActive,
      slideActive,
      qHud,
      eHud,
      xHud,
      ultRevealActive: pulseUltTimer > 0,
    };
  }

  return {
    cast,
    castForBot,
    notifyKill,
    resetRound,
    update,
  };
}
