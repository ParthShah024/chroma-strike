import {
  AABB,
  AGENT_PALETTES,
  AiDifficulty,
  Combatant,
  InputState,
  MovementModifiers,
  PlayerState,
  RaycastHit,
  SmokeSphere,
  Vec3,
} from '../core/types';
import {
  RUN_SPEED,
  getHorizontalSpeed,
  getLookDirection,
  raycastAABB,
  raycastSphere,
  updatePlayerMovement,
} from '../physics/movement';
import { ArenaWaypoint, getArenaWaypoints } from '../arena/map';
import { WEAPON_SPECS, computeWeaponDamage } from '../combat/arsenal';
import { AbilitySystem } from '../abilities/system';
import { WeaponSystem } from '../combat/weapons';
import { SoundEngine } from '../audio/sfx';

/**
 * ============================================================================
 * Tactical AI Brain: Finite State Machines (FSM), Shortest-Arc Aiming,
 * Multi-Gate Perception, and Waypoint Graph Navigation
 * ============================================================================
 *
 * 1. **Finite State Machine (FSM)**:
 *    Each bot transitions deterministically between four high-level states:
 *      - `'advance'`     : Traverse the tactical lane waypoint graph toward
 *                          opposing territory or last-known enemy contact.
 *      - `'engage'`      : Enemy perceived through all perception gates; wait
 *                          the human-like `0.24s` reaction delay, counter-strafe
 *                          into stationary accuracy windows, cast abilities, and
 *                          fire controlled hitscan bursts.
 *      - `'evade_cover'` : Health dropped below threshold (`< 45 HP`) or weapon
 *                          is reloading under threat; fall back toward rear
 *                          cover waypoints while keeping sights raised.
 *      - `'blinded'`     : `bot.blindTimer > 0` (hit by Green's Pop-Flash);
 *                          all target tracking and accurate fire are suppressed
 *                          until blindness decays to zero.
 *
 * 2. **Multi-Gate Perception**:
 *    A bot NEVER cheats with omniscient coordinates. An opposing combatant `e`
 *    is visible if and only if ALL THREE gates pass:
 *      - Gate A (Status): `bot.blindTimer <= 0`.
 *      - Gate B (Geometry LoS): `raycastAABB` from bot eye (`y + 1.6m`) to
 *        enemy chest (`y + 1.2m`) hits NO static `ARENA_COLLIDERS` box.
 *      - Gate C (Volumetric Smoke): `raycastSphere` against EVERY active
 *        `SmokeSphere` returns `null`. Because `raycastSphere` returns the exit
 *        root `t2` when the origin lies inside a sphere, Blue's Smoke Dome
 *        blocks AI vision from outside, through the dome, AND looking out!
 *
 * 3. **Shortest-Arc Angle Wrapping (`atan2(sin, cos)`)**:
 *    Naive Euler subtraction `targetYaw - currentYaw` wraps poorly across the
 *    `±PI` discontinuity (e.g., turning from `+3.0` to `-3.0` rad would spin
 *    `6.0 rad` the long way around instead of `0.28 rad`). Computing:
 *      `delta = Math.atan2(Math.sin(targetYaw - bot.yaw), Math.cos(targetYaw - bot.yaw))`
 *    projects the angular error onto the unit circle and recovers the exact
 *    signed shortest arc in `[-PI, +PI]`, clamped to `6.5 rad/s` slew speed.
 */

export type BotFsmState = 'advance' | 'engage' | 'evade_cover' | 'blinded';

export interface BotDamageCallback {
  (
    attacker: Combatant,
    victim: Combatant,
    damage: number,
    isHeadshot: boolean,
    weaponTag: string
  ): void;
}

export interface BotFireCallback {
  (bot: Combatant): void;
}

// ---------------------------------------------------------------------------
// Dynamic Tactical Waypoint Graph (Derived Live from ../arena/map)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-Bot Tuning Constants
// ---------------------------------------------------------------------------

const BOT_EYE_HEIGHT = 1.6;
const ENEMY_CHEST_HEIGHT = 1.2;

/**
 * Casual-friendly difficulty ladder. 'casual' (default) is tuned so a new
 * player can win duels: slow reaction, lazy aim slew, chest-height aim and wide
 * angular error. 'pro' snaps to the head with near-laser accuracy.
 */
interface DifficultyProfile {
  reactionSec: number;
  slewRadPerSec: number;
  aimHeightM: number;
  aimErrorRad: number;
  /** Multiplies burst length (forgiving bursts for casual). */
  burstLenScale: number;
  /** Multiplies the pause between bursts. */
  burstCooldownScale: number;
  /** Multiplies the delay between shots inside a burst. */
  fireIntervalScale: number;
}

const DIFFICULTY_PROFILES: Record<AiDifficulty, DifficultyProfile> = {
  casual: {
    reactionSec: 0.45,
    slewRadPerSec: 3.8,
    aimHeightM: 1.08,
    aimErrorRad: 0.048,
    burstLenScale: 0.7,
    burstCooldownScale: 1.6,
    fireIntervalScale: 1.15,
  },
  tactical: {
    reactionSec: 0.3,
    slewRadPerSec: 5.4,
    aimHeightM: 1.26,
    aimErrorRad: 0.026,
    burstLenScale: 1.0,
    burstCooldownScale: 1.0,
    fireIntervalScale: 1.0,
  },
  pro: {
    reactionSec: 0.2,
    slewRadPerSec: 7.2,
    aimHeightM: 1.44,
    aimErrorRad: 0.012,
    burstLenScale: 1.0,
    burstCooldownScale: 0.8,
    fireIntervalScale: 0.96,
  },
};

const CONCUSS_SPEED_MULT = 0.6;
const CONCUSS_FIRE_RATE_MULT = 0.68;
const CONCUSS_SPREAD_SLEW_PENALTY = 1.45;
const SLIDE_SPEED_MULT = 1.45;
const SLIDE_HITBOX_DROP_M = 0.5;

function slideDrop(c: Combatant): number {
  return (c.slideTimer ?? 0) > 0 ? SLIDE_HITBOX_DROP_M : 0;
}
const BOT_BODY_HALF_WIDTH = 0.38;
const BOT_BODY_HEIGHT = 1.38;
const BOT_HEAD_HALF_WIDTH = 0.22;
const BOT_HEAD_HEIGHT = 0.44;
const BOT_MAX_RAY_DIST = 160;
const BOT_EVADE_HP_THRESHOLD = 45;
const BOT_RECOVERY_HP_THRESHOLD = 68;

interface BotMemory {
  fsm: BotFsmState;
  route: string[];
  goalId: string | null;
  laneBias: 'west' | 'mid' | 'east';
  reactionTimer: number;
  timeSinceSeen: number;
  lastSeenPos: Vec3 | null;
  strafeDir: number;
  strafeTimer: number;
  evadeTimer: number;
  ammo: number;
  fireTimer: number;
  reloading: boolean;
  reloadTimer: number;
  recoilAccum: number;
  burstShotsLeft: number;
  burstCooldown: number;
  abilityCheckTimer: number;
}

// ---------------------------------------------------------------------------
// Geometry & Pathfinding Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function wrapAngleRad(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function findNearestWaypointId(pos: Vec3, waypoints: ArenaWaypoint[]): string | null {
  if (waypoints.length === 0) return null;
  let bestId = waypoints[0].id;
  let bestDistSq = Infinity;
  for (const wp of waypoints) {
    const dx = wp.pos.x - pos.x;
    const dz = wp.pos.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestDistSq) {
      bestDistSq = d2;
      bestId = wp.id;
    }
  }
  return bestId;
}

function findClosestWaypointInSubset(
  candidates: ArenaWaypoint[],
  targetX: number,
  targetZ: number
): string | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestDistSq = Infinity;
  for (const wp of candidates) {
    const dx = wp.pos.x - targetX;
    const dz = wp.pos.z - targetZ;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestDistSq) {
      bestDistSq = d2;
      best = wp;
    }
  }
  return best.id;
}

/**
 * Unweighted BFS shortest path on the dynamically generated Killhouse waypoint graph.
 * Runs in < 0.02ms on ~150 walkable tiles and adapts instantly to custom maps.
 */
function findShortestPath(
  startId: string,
  goalId: string,
  waypointById: Map<string, ArenaWaypoint>
): string[] {
  if (startId === goalId) return [goalId];

  const queue: string[] = [startId];
  const parent = new Map<string, string | null>();
  parent.set(startId, null);

  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++];
    if (curr === goalId) break;
    const node = waypointById.get(curr);
    if (!node) continue;

    for (const nextId of node.neighbors) {
      if (!parent.has(nextId)) {
        parent.set(nextId, curr);
        queue.push(nextId);
      }
    }
  }

  if (!parent.has(goalId)) {
    return [goalId];
  }

  const path: string[] = [];
  let trace: string | null = goalId;
  while (trace !== null) {
    path.push(trace);
    trace = parent.get(trace) ?? null;
  }
  path.reverse();
  return path;
}

function chooseTacticalGoal(
  bot: Combatant,
  mem: BotMemory,
  waypoints: ArenaWaypoint[]
): string | null {
  if (waypoints.length === 0) return null;

  if (mem.lastSeenPos && mem.timeSinceSeen < 6.0) {
    return findNearestWaypointId(mem.lastSeenPos, waypoints);
  }

  const isAlly = bot.team === 'ally';

  if (mem.laneBias === 'mid') {
    // Prefer Mid Watchtower / center Killhouse nodes (|z| < 3)
    const midNodes = waypoints.filter((wp) => Math.abs(wp.pos.z) < 3);
    if (midNodes.length > 0) {
      return findClosestWaypointInSubset(midNodes, 0, 0);
    }
  }

  // Opposing-half nodes: z < -8 for allies pushing North, z > 8 for enemies pushing South
  const opposingHalf = waypoints.filter((wp) =>
    isAlly ? wp.pos.z < -8 : wp.pos.z > 8
  );
  const pool = opposingHalf.length > 0 ? opposingHalf : waypoints;
  const targetZ = isAlly ? -12 : 12;
  const targetX = mem.laneBias === 'west' ? -9 : mem.laneBias === 'east' ? 9 : 0;

  return findClosestWaypointInSubset(pool, targetX, targetZ);
}

function chooseCoverGoal(bot: Combatant, waypoints: ArenaWaypoint[]): string | null {
  if (waypoints.length === 0) return null;

  const isAlly = bot.team === 'ally';
  const friendlyHalf = waypoints.filter((wp) =>
    isAlly ? wp.pos.z > 8 : wp.pos.z < -8
  );
  const pool = friendlyHalf.length > 0 ? friendlyHalf : waypoints;
  return findClosestWaypointInSubset(pool, 0, isAlly ? 13 : -13);
}

/**
 * Computes yaw/pitch facing from `origin` toward `target` matching Three.js's
 * `'YXZ'` convention (`forward = (-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch))`).
 */
function computeAimAngles(origin: Vec3, target: Vec3): { yaw: number; pitch: number; dist: number } {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-5) {
    return { yaw: 0, pitch: 0, dist: 0 };
  }
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.asin(clamp(dy / dist, -0.98, 0.98));
  return { yaw, pitch, dist };
}

/**
 * Multi-Gate Perception Check:
 *   Gate A: `bot.blindTimer <= 0` (flashbangs completely sever target detection)
 *   Gate B: No static `ARENA_COLLIDERS` wall blocks eye-to-chest raycast
 *   Gate C: No active `SmokeSphere` intersects the ray via `raycastSphere`
 */
function canBotPerceiveEnemy(
  bot: Combatant,
  enemy: Combatant,
  colliders: AABB[],
  activeSmokes: SmokeSphere[]
): boolean {
  if (!bot.alive || !enemy.alive) return false;
  // Gate A: Flashbang blind check
  if (bot.blindTimer > 0) return false;

  const eye: Vec3 = {
    x: bot.position.x,
    y: bot.position.y + BOT_EYE_HEIGHT,
    z: bot.position.z,
  };
  const chest: Vec3 = {
    x: enemy.position.x,
    y: enemy.position.y + ENEMY_CHEST_HEIGHT - slideDrop(enemy),
    z: enemy.position.z,
  };

  const dx = chest.x - eye.x;
  const dy = chest.y - eye.y;
  const dz = chest.z - eye.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-4) return true;

  const dir: Vec3 = { x: dx / dist, y: dy / dist, z: dz / dist };
  const wallMaxDist = Math.max(0, dist - 0.05);

  // Gate B: Static arena wall/cover AABB occlusion
  for (const box of colliders) {
    if (raycastAABB(eye, dir, box, wallMaxDist) !== null) {
      return false;
    }
  }

  // Gate C: Volumetric Smoke Sphere occlusion (blocks outside->in, through, & in->out)
  for (const smoke of activeSmokes) {
    if (raycastSphere(eye, dir, smoke.center, smoke.radius, dist) !== null) {
      return false;
    }
  }

  return true;
}

function getCombatantHitboxes(c: Combatant): { head: AABB; body: AABB } {
  const { x, y, z } = c.position;
  // Power-Sliding drops the whole upper hitbox stack by 0.5m so it ducks under 1.28m cover.
  const drop = slideDrop(c);
  return {
    body: {
      min: { x: x - BOT_BODY_HALF_WIDTH, y, z: z - BOT_BODY_HALF_WIDTH },
      max: { x: x + BOT_BODY_HALF_WIDTH, y: y + BOT_BODY_HEIGHT - drop, z: z + BOT_BODY_HALF_WIDTH },
    },
    head: {
      min: { x: x - BOT_HEAD_HALF_WIDTH, y: y + BOT_BODY_HEIGHT - drop, z: z - BOT_HEAD_HALF_WIDTH },
      max: {
        x: x + BOT_HEAD_HALF_WIDTH,
        y: y + BOT_BODY_HEIGHT + BOT_HEAD_HEIGHT - drop,
        z: z + BOT_HEAD_HALF_WIDTH,
      },
    },
  };
}

function applyBotSpread(dir: Vec3, spreadRad: number): Vec3 {
  if (spreadRad <= 1e-6) return dir;
  const upRef: Vec3 = Math.abs(dir.y) < 0.99 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const cx = dir.y * upRef.z - dir.z * upRef.y;
  const cy = dir.z * upRef.x - dir.x * upRef.z;
  const cz = dir.x * upRef.y - dir.y * upRef.x;
  const cLen = Math.hypot(cx, cy, cz) || 1;
  const rx = cx / cLen;
  const ry = cy / cLen;
  const rz = cz / cLen;

  const ux = ry * dir.z - rz * dir.y;
  const uy = rz * dir.x - rx * dir.z;
  const uz = rx * dir.y - ry * dir.x;

  const angle = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.random()) * Math.tan(spreadRad);
  const ox = Math.cos(angle) * radius;
  const oy = Math.sin(angle) * radius;

  const vx = dir.x + rx * ox + ux * oy;
  const vy = dir.y + ry * ox + uy * oy;
  const vz = dir.z + rz * ox + uz * oy;
  const len = Math.hypot(vx, vy, vz) || 1;
  return { x: vx / len, y: vy / len, z: vz / len };
}

// ---------------------------------------------------------------------------
// BotBrain Controller Interface
// ---------------------------------------------------------------------------

export interface BotBrainSystem {
  setDifficulty(diff: AiDifficulty): void;
  getDifficulty(): AiDifficulty;
  resetRound(combatants: Combatant[]): void;
  update(
    dt: number,
    combatants: Combatant[],
    colliders: AABB[],
    activeSmokes: SmokeSphere[],
    cameraPos: Vec3,
    isCombatActive: boolean,
    abilities: AbilitySystem,
    weaponSystem: WeaponSystem,
    sfx: SoundEngine,
    onDamage: BotDamageCallback,
    onFire: BotFireCallback
  ): void;
}

/**
 * Instantiates the AI Brain controller managing FSM states, navigation routes,
 * weapon burst state, and ability casting for every non-player `Combatant`.
 */
export function createBotBrainSystem(): BotBrainSystem {
  const memories = new Map<string, BotMemory>();
  let difficulty: AiDifficulty = 'casual';

  function setDifficulty(diff: AiDifficulty): void {
    if (diff in DIFFICULTY_PROFILES) difficulty = diff;
  }

  function getDifficulty(): AiDifficulty {
    return difficulty;
  }

  function getOrCreateMemory(bot: Combatant): BotMemory {
    let mem = memories.get(bot.id);
    if (!mem) {
      const laneBias: BotMemory['laneBias'] =
        bot.colorId === 'red' || bot.colorId === 'gold'
          ? 'west'
          : bot.colorId === 'blue' || bot.colorId === 'violet'
            ? 'mid'
            : 'east';
      mem = {
        fsm: 'advance',
        route: [],
        goalId: null,
        laneBias,
        reactionTimer: 0,
        timeSinceSeen: 99,
        lastSeenPos: null,
        strafeDir: bot.team === 'ally' ? 1 : -1,
        strafeTimer: 0.45,
        evadeTimer: 0,
        ammo: WEAPON_SPECS[bot.weaponId].maxAmmo,
        fireTimer: 0,
        reloading: false,
        reloadTimer: 0,
        recoilAccum: 0,
        burstShotsLeft: 0,
        burstCooldown: 0,
        abilityCheckTimer: 0.35 + Math.random() * 0.4,
      };
      memories.set(bot.id, mem);
    }
    return mem;
  }

  function resetRound(combatants: Combatant[]): void {
    memories.clear();
    for (const c of combatants) {
      getOrCreateMemory(c);
    }
  }

  function stepSingleBot(
    bot: Combatant,
    allCombatants: Combatant[],
    colliders: AABB[],
    activeSmokes: SmokeSphere[],
    cameraPos: Vec3,
    isCombatActive: boolean,
    dt: number,
    abilities: AbilitySystem,
    weaponSystem: WeaponSystem,
    sfx: SoundEngine,
    onDamage: BotDamageCallback,
    onFire: BotFireCallback
  ): void {
    const mem = getOrCreateMemory(bot);
    const spec = WEAPON_SPECS[bot.weaponId];
    const prof = DIFFICULTY_PROFILES[difficulty];
    const concussed = (bot.concussTimer ?? 0) > 0;
    const sliding = (bot.slideTimer ?? 0) > 0;
    const slewPenalty = concussed ? CONCUSS_SPREAD_SLEW_PENALTY : 1.0;

    // Clamp ammo if weapon upgraded between rounds
    if (mem.ammo > spec.maxAmmo) {
      mem.ammo = spec.maxAmmo;
    }

    // Tick weapon & status timers
    mem.fireTimer = Math.max(0, mem.fireTimer - dt);
    mem.burstCooldown = Math.max(0, mem.burstCooldown - dt);
    mem.recoilAccum = Math.max(0, mem.recoilAccum - dt * 2.6);
    mem.abilityCheckTimer = Math.max(0, mem.abilityCheckTimer - dt);

    if (mem.reloading) {
      mem.reloadTimer -= dt;
      if (mem.reloadTimer <= 0) {
        mem.reloading = false;
        mem.reloadTimer = 0;
        mem.ammo = spec.maxAmmo;
        mem.recoilAccum = 0;
      }
    } else if (mem.ammo <= 0) {
      mem.reloading = true;
      mem.reloadTimer = spec.reloadDurationSec;
    }

    // Build physics adapter so bots share the exact same AABB sweep, gravity, and slow physics
    const botPhysics: PlayerState = {
      position: bot.position,
      velocity: bot.velocity,
      grounded: bot.grounded,
      health: bot.health,
      maxHealth: bot.maxHealth,
      colorId: bot.colorId,
    };

    const modifiers: MovementModifiers = {
      dashActive: false,
      dashVelocity: { x: 0, y: 0, z: 0 },
      speedMultiplier:
        spec.moveSpeedMult *
        (bot.slowTimer > 0 ? 0.5 : 1.0) *
        (concussed ? CONCUSS_SPEED_MULT : 1.0) *
        (sliding ? SLIDE_SPEED_MULT : 1.0),
      suppressJump: bot.slowTimer > 0,
    };

    // During Buy Phase (or if somehow stepped while frozen), stay planted in spawn
    if (!isCombatActive) {
      const idleInput: InputState = {
        forward: false,
        backward: false,
        left: false,
        right: false,
        walk: false,
        jump: false,
        fire: false,
        reload: false,
        yaw: bot.yaw,
        pitch: 0,
      };
      updatePlayerMovement(botPhysics, idleInput, colliders, dt, modifiers);
      bot.grounded = botPhysics.grounded;
      return;
    }

    // 1. Multi-Gate Perception Scan: find closest perceived opposing combatant
    let spottedTarget: Combatant | null = null;
    let spottedDist = Infinity;

    if (bot.blindTimer <= 0) {
      for (const other of allCombatants) {
        if (other.team === bot.team || !other.alive) continue;
        if (canBotPerceiveEnemy(bot, other, colliders, activeSmokes)) {
          const d = Math.hypot(
            other.position.x - bot.position.x,
            other.position.y - bot.position.y,
            other.position.z - bot.position.z
          );
          if (d < spottedDist) {
            spottedDist = d;
            spottedTarget = other;
          }
        }
      }
    }

    if (spottedTarget) {
      mem.reactionTimer += dt;
      mem.timeSinceSeen = 0;
      mem.lastSeenPos = { ...spottedTarget.position };
    } else {
      mem.timeSinceSeen += dt;
      if (mem.timeSinceSeen > 0.35) {
        mem.reactionTimer = 0;
        mem.burstShotsLeft = 0;
      }
    }

    // 2. FSM State Transitions
    if (bot.blindTimer > 0) {
      mem.fsm = 'blinded';
    } else if (
      (bot.health < BOT_EVADE_HP_THRESHOLD || mem.reloading) &&
      spottedTarget !== null
    ) {
      if (mem.fsm !== 'evade_cover') {
        mem.evadeTimer = 1.35;
        mem.route = [];
      }
      mem.fsm = 'evade_cover';
    } else if (mem.fsm === 'evade_cover') {
      mem.evadeTimer -= dt;
      if (bot.health >= BOT_RECOVERY_HP_THRESHOLD || (mem.evadeTimer <= 0 && !mem.reloading)) {
        mem.fsm = spottedTarget ? 'engage' : 'advance';
        mem.route = [];
      }
    } else if (spottedTarget !== null) {
      mem.fsm = 'engage';
    } else {
      mem.fsm = 'advance';
    }

    // 3. Tactical Ability Casting (role-driven)
    if (mem.fsm !== 'blinded' && mem.abilityCheckTimer <= 0) {
      mem.abilityCheckTimer = 0.65;
      const botEye: Vec3 = { x: bot.position.x, y: bot.position.y + BOT_EYE_HEIGHT, z: bot.position.z };

      if (bot.colorId === 'blue') {
        // Blue Controller: smoke Mid / spotted choke with Q, throw Cryo Field with E at spotted target
        if (spottedTarget && spottedDist > 8 && spottedDist < 30) {
          const aim = computeAimAngles(botEye, {
            x: spottedTarget.position.x,
            y: spottedTarget.position.y + 0.5,
            z: spottedTarget.position.z,
          });
          if (!abilities.castForBot('e', bot, aim.yaw, aim.pitch)) {
            abilities.castForBot('q', bot, aim.yaw, aim.pitch);
          }
        } else if (Math.abs(bot.position.z) < 14) {
          // Throw Mid Smoke toward center pillar (0, 1.0, 0)
          const aim = computeAimAngles(botEye, { x: 0, y: 1.0, z: 0 });
          abilities.castForBot('q', bot, aim.yaw, aim.pitch);
        }
      } else if (bot.colorId === 'green') {
        // Green Initiator: Bio-Stim when below 75 HP; Pop-Flash when engaging/peeking
        if (bot.health < 75) {
          abilities.castForBot('e', bot, bot.yaw, bot.pitch);
        }
        if (spottedTarget && spottedDist > 7 && spottedDist < 24) {
          const aim = computeAimAngles(botEye, {
            x: spottedTarget.position.x,
            y: spottedTarget.position.y + 1.5,
            z: spottedTarget.position.z,
          });
          abilities.castForBot('q', bot, aim.yaw, aim.pitch);
        }
      } else if (bot.colorId === 'violet') {
        // Violet Controller (Umbra): Singularity [E] onto engaged enemies (7-24m),
        // Void Shroud [Q] across longer sightlines (8-28m) or to break contact.
        const sightTarget: Vec3 | null = spottedTarget
          ? spottedTarget.position
          : mem.lastSeenPos && mem.timeSinceSeen < 2.5
            ? mem.lastSeenPos
            : null;
        const sightDist = sightTarget
          ? Math.hypot(sightTarget.x - bot.position.x, sightTarget.z - bot.position.z)
          : Infinity;

        if (spottedTarget && mem.fsm === 'engage' && spottedDist > 7 && spottedDist < 24) {
          const aim = computeAimAngles(botEye, {
            x: spottedTarget.position.x,
            y: spottedTarget.position.y + 0.6,
            z: spottedTarget.position.z,
          });
          abilities.castForBot('e', bot, aim.yaw, aim.pitch);
        }
        if (sightTarget && sightDist > 8 && sightDist < 28 && (sightDist > 14 || mem.fsm === 'evade_cover')) {
          const aim = computeAimAngles(botEye, {
            x: sightTarget.x,
            y: sightTarget.y + 0.9,
            z: sightTarget.z,
          });
          abilities.castForBot('q', bot, aim.yaw, aim.pitch);
        }
      } else if (bot.colorId === 'gold') {
        // Gold Duelist (Volt): Relay Bolt [E] at 6-26m; Overdrive [Q] to close the gap
        // (<18m) or slide out of trouble.
        if (spottedTarget && spottedDist > 6 && spottedDist < 26) {
          const aim = computeAimAngles(botEye, {
            x: spottedTarget.position.x,
            y: spottedTarget.position.y + 0.9,
            z: spottedTarget.position.z,
          });
          abilities.castForBot('e', bot, aim.yaw, aim.pitch);
        }
        if (spottedTarget && spottedDist > 4 && spottedDist < 18) {
          const aim = computeAimAngles(botEye, {
            x: spottedTarget.position.x,
            y: spottedTarget.position.y + 0.9,
            z: spottedTarget.position.z,
          });
          abilities.castForBot('q', bot, aim.yaw, aim.pitch);
        } else if (mem.fsm === 'evade_cover') {
          abilities.castForBot('q', bot, bot.yaw + Math.PI * 0.5 * mem.strafeDir, 0);
        }
      } else if (bot.colorId === 'red') {
        // Red Duelist: Inferno Orb onto spotted enemy, or Crimson Dash to evade/flank
        if (spottedTarget && spottedDist > 6 && spottedDist < 26) {
          const aim = computeAimAngles(botEye, {
            x: spottedTarget.position.x,
            y: spottedTarget.position.y + 0.4,
            z: spottedTarget.position.z,
          });
          if (!abilities.castForBot('e', bot, aim.yaw, aim.pitch) && mem.fsm === 'evade_cover') {
            abilities.castForBot('q', bot, bot.yaw + Math.PI * 0.5 * mem.strafeDir, 0);
          }
        } else if (mem.fsm === 'evade_cover') {
          abilities.castForBot('q', bot, bot.yaw + Math.PI * 0.5 * mem.strafeDir, 0);
        }
      }
    }

    // 4. Compute Movement Intent & Target Look Angles per FSM State
    const botInput: InputState = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      walk: false,
      jump: false,
      fire: false,
      reload: false,
      yaw: bot.yaw,
      pitch: bot.pitch,
    };

    let desiredYaw = bot.yaw;
    let desiredPitch = 0;

    if (mem.fsm === 'blinded') {
      // Blinded: stumble backward slowly & drift aim slightly away; cannot fire accurately
      botInput.backward = true;
      botInput.walk = true;
      desiredYaw = bot.yaw + dt * 1.4 * mem.strafeDir;
      desiredPitch = -0.15;
    } else if (mem.fsm === 'engage' && spottedTarget) {
      // Aim at enemy chest / head based on weapon archetype
      const botEye: Vec3 = {
        x: bot.position.x,
        y: bot.position.y + BOT_EYE_HEIGHT,
        z: bot.position.z,
      };
      const aimPos: Vec3 = {
        x: spottedTarget.position.x,
        y: spottedTarget.position.y + prof.aimHeightM - slideDrop(spottedTarget),
        z: spottedTarget.position.z,
      };
      const aim = computeAimAngles(botEye, aimPos);
      desiredYaw = aim.yaw;
      desiredPitch = aim.pitch;

      // Counter-strafe cadence: alternate 0.48s strafe bursts with 0.34s crisp stationary shoot windows
      mem.strafeTimer -= dt;
      if (mem.strafeTimer <= 0) {
        mem.strafeDir = -mem.strafeDir;
        mem.strafeTimer = 0.78 + Math.random() * 0.35;
      }

      const inStopWindow = mem.strafeTimer < 0.34;
      if (!inStopWindow) {
        if (mem.strafeDir > 0) botInput.right = true;
        else botInput.left = true;
        if (spottedDist > 22 && bot.weaponId === 'smg') {
          botInput.forward = true;
        } else if (spottedDist < 7 && bot.weaponId === 'sniper') {
          botInput.backward = true;
        }
      }
    } else {
      // 'advance' or 'evade_cover': navigate dynamic Killhouse waypoint graph
      const waypoints = getArenaWaypoints();
      const waypointById = new Map<string, ArenaWaypoint>(
        waypoints.map((wp) => [wp.id, wp])
      );
      const targetGoalId =
        mem.fsm === 'evade_cover'
          ? chooseCoverGoal(bot, waypoints)
          : chooseTacticalGoal(bot, mem, waypoints);

      if (
        targetGoalId &&
        (mem.route.length === 0 ||
          mem.goalId !== targetGoalId ||
          !waypointById.has(mem.route[0]))
      ) {
        const startId = findNearestWaypointId(bot.position, waypoints);
        mem.route = startId ? findShortestPath(startId, targetGoalId, waypointById) : [];
        mem.goalId = targetGoalId;
      }

      const nextWp = mem.route.length > 0 ? waypointById.get(mem.route[0]) : undefined;
      if (nextWp) {
        const dx = nextWp.pos.x - bot.position.x;
        const dz = nextWp.pos.z - bot.position.z;
        const horizDist = Math.hypot(dx, dz);

        if (horizDist < 1.25) {
          mem.route.shift();
          // Reached goal -> pick next patrol waypoint toward enemy side
          if (mem.route.length === 0) {
            mem.lastSeenPos = null;
            mem.laneBias =
              mem.laneBias === 'west' ? 'mid' : mem.laneBias === 'mid' ? 'east' : 'west';
          }
        }

        if (horizDist > 0.15) {
          const moveYaw = Math.atan2(-dx, -dz);
          desiredYaw = moveYaw;
          desiredPitch = 0;

          // If evading while still seeing enemy, face enemy while backing away!
          if (mem.fsm === 'evade_cover' && spottedTarget) {
            const botEye: Vec3 = { x: bot.position.x, y: bot.position.y + BOT_EYE_HEIGHT, z: bot.position.z };
            const aim = computeAimAngles(botEye, {
              x: spottedTarget.position.x,
              y: spottedTarget.position.y + prof.aimHeightM - slideDrop(spottedTarget),
              z: spottedTarget.position.z,
            });
            desiredYaw = aim.yaw;
            desiredPitch = aim.pitch;

            // Project desired movement onto bot's facing basis so bot backpedals/strafes cleanly
            const relAngle = wrapAngleRad(moveYaw - bot.yaw);
            if (Math.cos(relAngle) > 0.35) botInput.forward = true;
            else if (Math.cos(relAngle) < -0.35) botInput.backward = true;
            if (Math.sin(relAngle) < -0.35) botInput.right = true;
            else if (Math.sin(relAngle) > 0.35) botInput.left = true;
          } else {
            botInput.forward = true;
          }
        }
      }
    }

    // 5. Smoothly Slew Yaw & Pitch via Shortest-Arc Wrapping (`atan2(sin, cos)`)
    const maxStep = (prof.slewRadPerSec / slewPenalty) * dt;
    const yawDiff = wrapAngleRad(desiredYaw - bot.yaw);
    bot.yaw = wrapAngleRad(bot.yaw + clamp(yawDiff, -maxStep, maxStep));

    const pitchDiff = desiredPitch - bot.pitch;
    bot.pitch = clamp(bot.pitch + clamp(pitchDiff, -maxStep, maxStep), -1.35, 1.35);
    botInput.yaw = bot.yaw;
    botInput.pitch = bot.pitch;

    // 6. Step Authentic Physics Movement (obeys gravity, AABB walls, and 0.5x slow)
    updatePlayerMovement(botPhysics, botInput, colliders, dt, modifiers);
    bot.grounded = botPhysics.grounded;

    // 7. Hitscan Burst Combat (requires >= 0.24s reaction delay & aligned sightline)
    if (
      mem.fsm === 'engage' &&
      spottedTarget &&
      mem.reactionTimer >= prof.reactionSec * (concussed ? CONCUSS_SPREAD_SLEW_PENALTY : 1.0) &&
      !mem.reloading &&
      mem.ammo > 0 &&
      mem.fireTimer <= 0 &&
      Math.abs(yawDiff) < 0.26
    ) {
      if (mem.burstShotsLeft <= 0 && mem.burstCooldown <= 0) {
        const rawBurst =
          bot.weaponId === 'sniper' || bot.weaponId === 'pistol'
            ? 1
            : bot.weaponId === 'smg'
              ? 4 + Math.floor(Math.random() * 3)
              : 2 + Math.floor(Math.random() * 3);
        mem.burstShotsLeft = Math.max(1, Math.round(rawBurst * prof.burstLenScale));
      }

      if (mem.burstShotsLeft > 0) {
        mem.burstShotsLeft -= 1;
        mem.ammo -= 1;
        const baseInterval =
          bot.weaponId === 'pistol'
            ? Math.max(spec.fireIntervalSec, 0.28)
            : spec.fireIntervalSec * (bot.weaponId === 'sniper' ? 1.15 : 1.08);
        // Concussed bots fire at 0.68x rate (interval / 0.68).
        mem.fireTimer =
          (baseInterval * prof.fireIntervalScale) / (concussed ? CONCUSS_FIRE_RATE_MULT : 1.0);

        if (mem.burstShotsLeft <= 0) {
          const rawCooldown = bot.weaponId === 'sniper' ? 0.35 : 0.26 + Math.random() * 0.2;
          mem.burstCooldown = rawCooldown * prof.burstCooldownScale;
        }

        const origin: Vec3 = {
          x: bot.position.x,
          y: bot.position.y + BOT_EYE_HEIGHT - slideDrop(bot),
          z: bot.position.z,
        };

        const horizSpeed = getHorizontalSpeed(bot.velocity);
        const moveSpread =
          horizSpeed < 0.45 && bot.grounded ? 0 : (horizSpeed / RUN_SPEED) * spec.moveSpreadRad;
        // Bots use sniper scoped accuracy when stationary, plus a fair baseline dispersion
        const baseAimError =
          bot.weaponId === 'sniper' && horizSpeed < 0.45 ? prof.aimErrorRad * 0.55 : prof.aimErrorRad;
        const totalSpread =
          (baseAimError +
          (bot.weaponId === 'sniper' ? spec.scopedSpreadRad : spec.baseSpreadRad) +
          moveSpread +
          (bot.grounded ? 0 : spec.airSpreadRad) +
          mem.recoilAccum * 0.03) *
          slewPenalty;

        const baseDir = getLookDirection(bot.yaw, bot.pitch + mem.recoilAccum * 0.04);
        const shotDir = applyBotSpread(baseDir, totalSpread);
        mem.recoilAccum = Math.min(1.0, mem.recoilAccum + spec.recoilPerShot * 0.85);

        onFire(bot);

        // Audio attenuated by distance from camera
        const listenerDist = Math.hypot(
          origin.x - cameraPos.x,
          origin.y - cameraPos.y,
          origin.z - cameraPos.z
        );
        sfx.playWeaponShot(bot.weaponId, false, listenerDist);

        // Raycast static colliders first
        let closestWallDist = BOT_MAX_RAY_DIST;
        let closestWallHit: RaycastHit | null = null;
        for (const box of colliders) {
          const hit = raycastAABB(origin, shotDir, box, closestWallDist);
          if (hit && hit.distance < closestWallDist) {
            closestWallDist = hit.distance;
            closestWallHit = hit;
          }
        }

        // Raycast opposing living combatants
        let closestVictimDist = closestWallDist;
        let hitVictim: Combatant | null = null;
        let hitVictimHit: RaycastHit | null = null;
        let hitHeadshot = false;

        for (const other of allCombatants) {
          if (other.team === bot.team || !other.alive) continue;
          const { head, body } = getCombatantHitboxes(other);
          const headHit = raycastAABB(origin, shotDir, head, closestVictimDist);
          const bodyHit = raycastAABB(origin, shotDir, body, closestVictimDist);

          if (headHit && (!bodyHit || headHit.distance <= bodyHit.distance + 1e-4)) {
            if (headHit.distance < closestVictimDist) {
              closestVictimDist = headHit.distance;
              hitVictim = other;
              hitVictimHit = headHit;
              hitHeadshot = true;
            }
          } else if (bodyHit && bodyHit.distance < closestVictimDist) {
            closestVictimDist = bodyHit.distance;
            hitVictim = other;
            hitVictimHit = bodyHit;
            hitHeadshot = false;
          }
        }

        const paletteHex = AGENT_PALETTES[bot.colorId].hex;
        const muzzleOffset: Vec3 = {
          x: origin.x + shotDir.x * 0.45,
          y: origin.y - 0.12,
          z: origin.z + shotDir.z * 0.45,
        };

        if (hitVictim && hitVictimHit) {
          const dmg = computeWeaponDamage(spec, closestVictimDist, hitHeadshot);
          onDamage(bot, hitVictim, dmg, hitHeadshot, spec.shortTag);
          weaponSystem.spawnWorldTracer(
            muzzleOffset,
            hitVictimHit.point,
            hitVictimHit.normal,
            paletteHex,
            hitHeadshot
          );
        } else if (closestWallHit) {
          weaponSystem.spawnWorldTracer(
            muzzleOffset,
            closestWallHit.point,
            closestWallHit.normal,
            paletteHex,
            false
          );
        } else {
          weaponSystem.spawnWorldTracer(
            muzzleOffset,
            {
              x: origin.x + shotDir.x * 75,
              y: origin.y + shotDir.y * 75,
              z: origin.z + shotDir.z * 75,
            },
            null,
            paletteHex,
            false
          );
        }

        if (mem.ammo <= 0) {
          mem.reloading = true;
          mem.reloadTimer = spec.reloadDurationSec;
        }
      }
    }
  }

  function update(
    dt: number,
    combatants: Combatant[],
    colliders: AABB[],
    activeSmokes: SmokeSphere[],
    cameraPos: Vec3,
    isCombatActive: boolean,
    abilities: AbilitySystem,
    weaponSystem: WeaponSystem,
    sfx: SoundEngine,
    onDamage: BotDamageCallback,
    onFire: BotFireCallback
  ): void {
    for (const c of combatants) {
      if (c.isPlayer || !c.alive) continue;
      stepSingleBot(
        c,
        combatants,
        colliders,
        activeSmokes,
        cameraPos,
        isCombatActive,
        dt,
        abilities,
        weaponSystem,
        sfx,
        onDamage,
        onFire
      );
    }
  }

  return {
    setDifficulty,
    getDifficulty,
    resetRound,
    update,
  };
}
