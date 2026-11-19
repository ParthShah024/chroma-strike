/**
 * Shared TypeScript contracts for Chroma Strike.
 *
 * Why keep all core interfaces and constants in one strict contract file?
 * 1. Parallel module development: Physics, Arena, Combat, and Main Loop can be
 *    built independently and verified at compile time with zero runtime surprises.
 * 2. Multiplayer readiness: When scaling to client-server netcode, `InputState`
 *    becomes the exact input packet sent from client to server every tick, while
 *    `PlayerState`, `WeaponState`, and `TargetDummy` form the authoritative snapshot
 *    replicated back to clients for prediction and reconciliation.
 * 3. Engine decoupling: Plain data structs (`Vec3`, `AABB`) keep simulation logic
 *    free of Three.js scene objects so physics and raycasting can run headlessly
 *    on a Node/Edge authoritative server without a WebGL context.
 */

export type AgentColorId = 'red' | 'blue' | 'green' | 'violet' | 'gold';

export const AGENT_ORDER: readonly AgentColorId[] = ['red', 'blue', 'green', 'violet', 'gold'];

export type AiDifficulty = 'casual' | 'tactical' | 'pro';

export interface AgentPalette {
  id: AgentColorId;
  name: string;
  role: string;
  hex: number;
  css: string;
}

export const AGENT_PALETTES: Record<AgentColorId, AgentPalette> = {
  red: {
    id: 'red',
    name: 'Blaze (Red)',
    role: 'Duelist',
    hex: 0xff3b5c,
    css: '#ff3b5c',
  },
  blue: {
    id: 'blue',
    name: 'Mist (Blue)',
    role: 'Controller',
    hex: 0x00d2ff,
    css: '#00d2ff',
  },
  green: {
    id: 'green',
    name: 'Pulse (Green)',
    role: 'Initiator',
    hex: 0x2ecc71,
    css: '#2ecc71',
  },
  violet: {
    id: 'violet',
    name: 'Umbra (Violet)',
    role: 'Controller',
    hex: 0xa855f7,
    css: '#a855f7',
  },
  gold: {
    id: 'gold',
    name: 'Volt (Gold)',
    role: 'Duelist',
    hex: 0xfacc15,
    css: '#facc15',
  },
};

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AABB {
  min: Vec3;
  max: Vec3;
  color?: number;
  tag?: 'floor' | 'wall' | 'cover' | 'door';
  doorId?: string;
}

export interface InputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  walk: boolean;
  jump: boolean;
  fire: boolean;
  /** True only on the single frame the trigger was pulled (used to gate semi-auto weapons). */
  fireJustPressed?: boolean;
  /** True when aiming down sights / scoping. */
  ads?: boolean;
  reload: boolean;
  interact?: boolean;
  dropSpike?: boolean;
  yaw: number;
  pitch: number;
}

export interface PlayerState {
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  health: number;
  maxHealth: number;
  armor?: number;
  maxArmor?: number;
  colorId: AgentColorId;
}

export interface RaycastHit {
  distance: number;
  point: Vec3;
  normal: Vec3;
}

export interface WeaponState {
  ammo: number;
  maxAmmo: number;
  fireTimer: number;
  reloading: boolean;
  reloadTimer: number;
  recoilAccumulator: number;
  currentSpread: number;
}

export interface TargetDummy {
  id: string;
  basePosition: Vec3;
  position: Vec3;
  colorId: AgentColorId;
  health: number;
  maxHealth: number;
  armor?: number;
  maxArmor?: number;
  alive: boolean;
  respawnTimer: number;
  strafeSpeed: number;
  strafeRange: number;
  strafePhase: number;
  /** Remaining seconds of Cryo Field movement slow (0 = normal speed). */
  slowTimer: number;
  /** Remaining seconds of Pop-Flash blindness (0 = clear vision). */
  blindTimer: number;
  /** Remaining seconds of Singularity Fragile amplification (0 = normal damage). */
  vulnerableTimer?: number;
  /** Remaining seconds of Relay Shock concuss disorientation (0 = clear). */
  concussTimer?: number;
  /** Remaining seconds of Volt Power-Slide low-profile stance. */
  slideTimer?: number;
}

export interface ShotResult {
  fired: boolean;
  hitPoint: Vec3 | null;
  hitType: 'none' | 'wall' | 'body' | 'head';
  damageDealt: number;
  killedTarget: boolean;
  hitDoorId?: string;
  doorDamageDealt?: number;
}

// ============================================================================
// Chapter 2: Ability Registry, Simulation State & Frame Modifier Contracts
// ============================================================================
//
// Architectural Notes for Scaling:
// 1. Registry vs. Runtime State Separation:
//    `AbilitySpec` is immutable static metadata (display name, keybind, base
//    cooldown) that lives in a lookup table (`AGENT_ABILITIES`). By contrast,
//    `AbilityProjectile`, `ActiveZone`, and `AbilityHudSlotState` are mutable
//    per-match / per-tick runtime state. Separating immutable definitions from
//    live state makes balance tuning trivial, avoids duplicating strings across
//    every spawned entity, and keeps network snapshots compact (only IDs and
//    timers need replication, never descriptions).
// 2. Modifier Structs (`MovementModifiers`, `AbilityFrameFeedback`):
//    Rather than letting the ability system mutate `weapon` or `player`
//    internals directly in hidden side effects, `AbilitySystem.update()`
//    returns a declarative `AbilityFrameFeedback` struct each tick. Physics
//    consumes `movement`, Weaponry consumes `fireRateMultiplier`, Target AI
//    consumes `activeSmokes`, and the HUD/Camera consume `flashAlpha`,
//    `dashAlpha`, `insideSmokeFactor`, and `qHud`/`eHud`. This keeps module
//    dependencies acyclic (DAG) and deterministic.

export type AbilitySlot = 'q' | 'e' | 'x';

export type AbilityAudioEvent =
  | 'dash'
  | 'throw'
  | 'fire_ignite'
  | 'smoke_bloom'
  | 'slow_shatter'
  | 'flash_warn'
  | 'flash_pop'
  | 'beacon_deploy'
  | 'void_cast'
  | 'void_bloom'
  | 'vortex_pull'
  | 'overdrive_on'
  | 'power_slide'
  | 'relay_bounce'
  | 'relay_zap'
  | 'ult_blaze'
  | 'ult_mist'
  | 'ult_pulse'
  | 'ult_umbra'
  | 'ult_volt';

/** Immutable static specification for one agent ability slot. */
export interface AbilitySpec {
  slot: AbilitySlot;
  keyLabel: 'Q' | 'E' | 'X';
  name: string;
  shortTag: string;
  cooldownSec: number;
  maxCharges?: number;
  ultPointsRequired?: number;
  description: string;
}

/**
 * Per-frame movement overrides emitted by the ability system and consumed
 * by `updatePlayerMovement` without coupling physics to Three.js or abilities.
 */
export interface MovementModifiers {
  dashActive: boolean;
  dashVelocity: Vec3;
  speedMultiplier: number;
  suppressJump?: boolean;
  externalVelocity?: Vec3;
  slideActive?: boolean;
}

export type ProjectileKind =
  | 'fire_orb'
  | 'smoke_orb'
  | 'slow_orb'
  | 'flash_orb'
  | 'void_orb'
  | 'vortex_orb'
  | 'relay_bolt';

/** Live thrown orb simulated via ballistic gravity and AABB raycast bounces. */
export interface AbilityProjectile {
  id: string;
  kind: ProjectileKind;
  colorId: AgentColorId;
  position: Vec3;
  velocity: Vec3;
  gravity: number;
  restitution: number;
  age: number;
  maxLifetime: number;
  detonateOnFloor: boolean;
}

export type ZoneKind = 'fire' | 'smoke' | 'slow' | 'beacon' | 'void_smoke' | 'vortex' | 'relay_shock';

/** Persistent area-of-effect volume active in the arena for a bounded duration. */
export interface ActiveZone {
  id: string;
  kind: ZoneKind;
  colorId: AgentColorId;
  center: Vec3;
  radius: number;
  remainingSec: number;
  totalDurationSec: number;
}

/** Lightweight spherical smoke volume passed to target LoS / nameplate occlusion. */
export interface SmokeSphere {
  center: Vec3;
  radius: number;
}

/** Read-only HUD projection for a single [Q] or [E] ability slot. */
export interface AbilityHudSlotState {
  name: string;
  shortTag: string;
  cooldownRemaining: number;
  cooldownTotal: number;
  ready: boolean;
  charges?: number;
  maxCharges?: number;
  activeTimer?: number;
}

/**
 * Complete per-frame output from `AbilitySystem.update()`.
 * Acts as the clean boundary between ability simulation and physics, combat,
 * camera FOV warp, and DOM HUD rendering.
 */
export interface AbilityFrameFeedback {
  movement: MovementModifiers;
  fireRateMultiplier: number;
  recoilMultiplier: number;
  moveSpreadMultiplier: number;
  eyeHeightOffset: number;
  audioEvents: AbilityAudioEvent[];
  activeSmokes: SmokeSphere[];
  insideSmokeFactor: number;
  flashAlpha: number;
  dashAlpha: number;
  overdriveAlpha: number;
  concussAlpha: number;
  stimActive: boolean;
  slideActive: boolean;
  qHud: AbilityHudSlotState;
  eHud: AbilityHudSlotState;
  xHud?: AbilityHudSlotState;
  ultRevealActive?: boolean;
}

// ============================================================================
// Chapter 3: Arsenal, 3v3 Combatants, Crosshair Customization & Round Loop
// ============================================================================
//
// Architectural Notes for Chapter 3:
// 1. Unified `Combatant` Contract:
//    Notice `Combatant extends TargetDummy`. Because every 3v3 fighter (human
//    player, allied bots, and enemy bots) shares the exact same `position`,
//    `health`, `alive`, `slowTimer`, and `blindTimer` fields as `TargetDummy`,
//    the existing hitscan raycaster (`WeaponSystem`) and AoE ability zones
//    (`AbilitySystem`) operate uniformly on both players and AI bots via the
//    `TargetsManager` view adapter — with zero duplicated collision code.
// 2. Round State Machine Projection (`MatchHudState`):
//    `roundManager.ts` owns the authoritative `buy -> combat -> round_end -> match_over`
//    state machine and projects a clean, read-only `MatchHudState` snapshot each
//    tick so the DOM HUD never mutates match scores or timers directly.

export type WeaponId = 'pistol' | 'smg' | 'ar' | 'sniper';

export type TeamId = 'ally' | 'enemy';

export type RoundPhase = 'buy' | 'combat' | 'round_end' | 'match_over';

/** Immutable weapon balance & optical specification for one arsenal slot. */
export interface WeaponSpec {
  id: WeaponId;
  slotNumber: 1 | 2 | 3 | 4;
  name: string;
  shortTag: string;
  automatic: boolean;
  fireIntervalSec: number;
  reloadDurationSec: number;
  maxAmmo: number;
  headDamage: number;
  bodyDamage: number;
  falloffStartM: number;
  falloffEndM: number;
  minFalloffMult: number;
  baseSpreadRad: number;
  scopedSpreadRad: number;
  moveSpreadRad: number;
  airSpreadRad: number;
  recoilPerShot: number;
  moveSpeedMult: number;
  adsFovDeg: number | null;
  tracerWidthScale: number;
  cost: number;
  killReward: number;
}

/**
 * Live 3v3 fighter state extending `TargetDummy` so hitboxes, status timers,
 * and damage application work identically for the human player and AI bots.
 */
export interface Combatant extends TargetDummy {
  team: TeamId;
  isPlayer: boolean;
  /** True when this slot is currently driven by a connected remote human player. */
  isRemoteHuman?: boolean;
  remotePlayerId?: string;
  remoteName?: string;
  yaw: number;
  pitch: number;
  velocity: Vec3;
  grounded: boolean;
  weaponId: WeaponId;
  armor?: number;
  maxArmor?: number;
  credits?: number;
  shieldTier?: ShieldTier;
  ultPoints?: number;
  ultActiveTimer?: number;
}

/** Persistent user-customizable crosshair configuration saved to localStorage. */
export interface CrosshairSettings {
  colorMode: 'agent' | 'cyan' | 'green' | 'white' | 'yellow' | 'pink';
  centerDot: boolean;
  dotSizePx: number;
  lineLengthPx: number;
  lineThicknessPx: number;
  baseGapPx: number;
  outline: boolean;
  dynamicSpread: boolean;
}

/** Transient elimination event displayed in the top-right kill feed. */
export interface KillFeedEntry {
  id: number;
  killerName: string;
  killerTeam: TeamId;
  killerColor: AgentColorId;
  victimName: string;
  victimTeam: TeamId;
  victimColor: AgentColorId;
  weaponTag: string;
  headshot: boolean;
  age: number;
}

/** Read-only per-frame projection of match score, phase timer, team rosters, and banners. */
export interface MatchHudState {
  phase: RoundPhase;
  roundNumber: number;
  phaseTimerSec: number;
  allyScore: number;
  enemyScore: number;
  allyStates: Array<{ colorId: AgentColorId; alive: boolean; isPlayer: boolean; hp: number }>;
  enemyStates: Array<{ colorId: AgentColorId; alive: boolean; hp: number }>;
  bannerTitle: string | null;
  bannerSubtitle: string | null;
  canTakeoverBot: boolean;
  killFeed: KillFeedEntry[];
  lastDamageAngleRad?: number | null;
  lastDamageSeq?: number;
  difficulty?: AiDifficulty;
  playerSide?: TacticalSide;
  halftimeSwapped?: boolean;
  credits?: number;
  nextRoundMinCredits?: number;
  lossStreak?: number;
  armor?: number;
  maxArmor?: number;
  shieldTier?: ShieldTier;
  canRefundWeapon?: boolean;
  refundableWeaponCost?: number;
  allyEconomy?: Array<{
    id: string;
    colorId: AgentColorId;
    credits: number;
    weaponId: WeaponId;
    armor: number;
    hasSpike: boolean;
  }>;
  spike?: SpikeHudState;
  minimapEnemies?: MinimapContact[];
  ultPoints?: number;
  maxUltPoints?: number;
  doors?: ArenaDoorHudState[];
  nearbyDoorPrompt?: { doorId: string; label: string; action: 'CLOSE' | 'OPEN' } | null;
  winTarget?: number;
  swapInterval?: number;
}

// ============================================================================
// Chapter 4: Search & Destroy (Spike) & Tactical Economy Contracts
// ============================================================================

export type TacticalSide = 'attacker' | 'defender';
export type BombSiteId = 'A' | 'B';
export type ShieldTier = 'none' | 'light' | 'heavy';
export type SpikeStatus = 'carried' | 'dropped' | 'planted' | 'defused' | 'detonated';

export interface BombSiteZone {
  site: BombSiteId;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  center: Vec3;
}

export interface SpikeHudState {
  status: SpikeStatus;
  carrierId: string | null;
  playerHasSpike: boolean;
  plantedSite: BombSiteId | null;
  position: Vec3;
  timerSec: number;
  plantProgress: number;
  defuseProgress: number;
  halfwayCheckpoint: boolean;
  canPlantNow: BombSiteId | null;
  canDefuseNow: boolean;
}

export interface MinimapContact {
  x: number;
  z: number;
  colorId: AgentColorId;
}

// ============================================================================
// Chapter 8: Interactive Breakable / Toggleable Arena Doors
// ============================================================================

export type ArenaDoorStatus = 'open' | 'closed' | 'broken';

export interface ArenaDoorHudState {
  id: string;
  label: string;
  status: ArenaDoorStatus;
  hp: number;
  maxHp: number;
  center: Vec3;
  switchPos: Vec3;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

// ============================================================================
// Chapter 9: Persistent Settings, 6-Player Lobby & Netcode Contracts
// ============================================================================

export type LobbyPhase = 'lobby' | 'agent_select' | 'playing';

export interface LobbyPlayerSlot {
  id: string;
  name: string;
  side: TacticalSide;
  slotIndex: 0 | 1 | 2;
  agentColor: AgentColorId;
  lockedIn: boolean;
  isHost: boolean;
}

export interface RemotePlayerNetState {
  playerId: string;
  name: string;
  side: TacticalSide;
  slotIndex: 0 | 1 | 2;
  agentColor: AgentColorId;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  armor: number;
  alive: boolean;
  weaponId: WeaponId;
  firing?: boolean;
  sliding?: boolean;
  ultActive?: boolean;
  timestampMs: number;
}

export interface GameSettings {
  mouseSensitivity: number;
  adsSensitivityMult: number;
  invertY: boolean;
  fovDeg: number;
  shadowsEnabled: boolean;
  minimapRotate: boolean;
  minimapSize: 'compact' | 'standard' | 'large';
  showFps: boolean;
  masterVolume: number;
  muted: boolean;
  difficulty: AiDifficulty;
  defaultSide: TacticalSide;
  winTarget: 10 | 6;
}
