import {
  AABB,
  AGENT_PALETTES,
  AiDifficulty,
  BombSiteId,
  BombSiteZone,
  Combatant,
  InputState,
  MovementModifiers,
  PlayerState,
  RaycastHit,
  SmokeSphere,
  SpikeHudState,
  TeamId,
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
import {
  ArenaWaypoint,
  damageArenaDoor,
  getArenaSpawns,
  getArenaWaypoints,
} from '../arena/map';
import { WEAPON_SPECS, computeWeaponDamage } from '../combat/arsenal';
import { AbilitySystem } from '../abilities/system';
import { WeaponSystem } from '../combat/weapons';
import { SoundEngine } from '../audio/sfx';

/**
 * ============================================================================
 * Tactical 2-Site Search & Destroy AI Brain:
 * Finite State Machines (FSM), Execute/Lurk/Anchor/Retake Roles,
 * Shortest-Arc Aiming, Multi-Gate Perception & Waypoint BFS Navigation
 * ============================================================================
 *
 * 1. **Finite State Machine (FSM)**:
 *    - `'advance'`     : Traverse the tactical waypoint graph via BFS according
 *                        to the bot's S&D role (Execute, Lurk, Anchor, Retake,
 *                        or Post-Plant Guard).
 *    - `'engage'`      : Enemy perceived through all 3 perception gates; wait
 *                        difficulty-scaled reaction delay, counter-strafe into
 *                        stationary accuracy windows, cast role abilities, and
 *                        fire controlled hitscan bursts.
 *    - `'evade_cover'` : Low HP (`< 45`) or reloading under fire; disengage
 *                        toward rear cover while keeping sights raised.
 *    - `'blinded'`     : `bot.blindTimer > 0` (Pop-Flash); stumble backward and
 *                        suppress accurate fire until vision recovers.
 *    - `'plant'`       : Spike carrier inside target Bomb Site with no urgent
 *                        close-range duel; holds position and channels Spike plant.
 *    - `'defuse'`      : Retaking Defender within `2.6m` of planted Spike (clear
 *                        of immediate threat or `< 7.5s` left); sticks defusal.
 *
 * 2. **Multi-Gate Perception**:
 *    - Gate A (Status): `bot.blindTimer <= 0`.
 *    - Gate B (Geometry LoS): `raycastAABB` from eye (`y + 1.6m`) to enemy
 *      chest (`y + 1.2m`) hits NO static `ARENA_COLLIDERS` box (naturally shoots
 *      and perceives cleanly through open `'W'` framed tactical windows!).
 *    - Gate C (Volumetric Smoke): `raycastSphere` against every active
 *      `SmokeSphere` returns `null`.
 */

export type BotFsmState =
  | 'advance'
  | 'engage'
  | 'evade_cover'
  | 'blinded'
  | 'plant'
  | 'defuse';

export type BotTacticalRole =
  | 'execute'
  | 'lurker'
  | 'anchor_a'
  | 'mid_watch'
  | 'anchor_b';

export interface BotSdContext {
  attackerTeam: TeamId;
  spike: SpikeHudState;
  sites: Record<BombSiteId, BombSiteZone>;
  buyTimeRemainingSec?: number;
  onBotPlantTick?: (bot: Combatant, dt: number) => void;
  onBotDefuseTick?: (bot: Combatant, dt: number) => void;
}

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
// Per-Bot Tuning Constants & Difficulty Ladder
// ---------------------------------------------------------------------------

const BOT_EYE_HEIGHT = 1.6;
const ENEMY_CHEST_HEIGHT = 1.2;

interface DifficultyProfile {
  reactionSec: number;
  slewRadPerSec: number;
  aimHeightM: number;
  aimErrorRad: number;
  burstLenScale: number;
  burstCooldownScale: number;
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

const BOT_BODY_HALF_WIDTH = 0.38;
const BOT_BODY_HEIGHT = 1.38;
const BOT_HEAD_HALF_WIDTH = 0.22;
const BOT_HEAD_HEIGHT = 0.44;
const BOT_MAX_RAY_DIST = 160;
const BOT_EVADE_HP_THRESHOLD = 45;
const BOT_RECOVERY_HP_THRESHOLD = 68;

const BOT_DEFUSE_RANGE_M = 2.6;
const BOT_URGENT_DEFUSE_TIMER_SEC = 7.5;
const BOT_PLANT_THREAT_DIST_M = 13.5;
const MAX_ULT_POINTS = 5;
const BOT_ULT_ACTIVE_SEC = 7.5;
const BUY_SPIKE_BOT_PICKUP_WINDOW_SEC = 7.5;
const BOT_DOOR_DETECT_DIST_M = 6.2;
const BOT_DOOR_FIRE_MIN_INTERVAL_SEC = 0.18;
const BOT_DOOR_FIRE_MAX_INTERVAL_SEC = 0.3;

function slideDrop(c: Combatant): number {
  return (c.slideTimer ?? 0) > 0 ? SLIDE_HITBOX_DROP_M : 0;
}

interface BotMemory {
  fsm: BotFsmState;
  role: BotTacticalRole;
  route: string[];
  goalId: string | null;
  laneBias: 'west' | 'mid' | 'east';
  holdTimer: number;
  holdYaw: number;
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
// Geometry, Zone & Pathfinding Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function wrapAngleRad(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function horizDist2D(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function isPosInsideSite(pos: Vec3, site: BombSiteZone): boolean {
  return (
    pos.x >= site.minX &&
    pos.x <= site.maxX &&
    pos.z >= site.minZ &&
    pos.z <= site.maxZ
  );
}

function findNearestWaypointId(pos: Vec3, waypoints: ArenaWaypoint[]): string | null {
  if (waypoints.length === 0) return null;
  let bestId = waypoints[0].id;
  let bestDistSq = Infinity;
  for (const wp of waypoints) {
    const dx = wp.pos.x - pos.x;
    const dy = wp.pos.y - pos.y;
    const dz = wp.pos.z - pos.z;
    // Heavily weight vertical separation so multi-level A Heaven (y=3m) and A Hell (y=0m) never cross-snap
    const d2 = dx * dx + dz * dz + dy * dy * 9.0;
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
  targetZ: number,
  targetY?: number
): string | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestDistSq = Infinity;
  for (const wp of candidates) {
    const dx = wp.pos.x - targetX;
    const dz = wp.pos.z - targetZ;
    const dy = targetY !== undefined ? wp.pos.y - targetY : 0;
    const d2 = dx * dx + dz * dz + dy * dy * 9.0;
    if (d2 < bestDistSq) {
      bestDistSq = d2;
      best = wp;
    }
  }
  return best.id;
}

/**
 * Unweighted BFS shortest path on the dynamically generated 2-Site waypoint graph.
 */
function findShortestPath(
  startId: string,
  goalId: string,
  waypointById: Map<string, ArenaWaypoint>,
  isNodeAllowed?: (wp: ArenaWaypoint) => boolean
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
        const nextNode = waypointById.get(nextId);
        if (isNodeAllowed && nextNode && nextId !== goalId && !isNodeAllowed(nextNode)) {
          continue;
        }
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

function getSiteWaypoints(
  siteId: BombSiteId,
  sites: Record<BombSiteId, BombSiteZone>,
  waypoints: ArenaWaypoint[]
): ArenaWaypoint[] {
  const zoneTag = siteId === 'A' ? 'site_a' : 'site_b';
  const tagged = waypoints.filter((wp) => wp.zone === zoneTag);
  if (tagged.length > 0) return tagged;
  const site = sites[siteId];
  const inside = waypoints.filter((wp) => isPosInsideSite(wp.pos, site));
  return inside.length > 0 ? inside : waypoints;
}

function chooseFallbackTacticalGoal(
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
    const midNodes = waypoints.filter((wp) => wp.zone === 'mid' || Math.abs(wp.pos.z) < 4);
    if (midNodes.length > 0) {
      return findClosestWaypointInSubset(midNodes, 0, 0);
    }
  }

  const opposingHalf = waypoints.filter((wp) => (isAlly ? wp.pos.z < -8 : wp.pos.z > 8));
  const pool = opposingHalf.length > 0 ? opposingHalf : waypoints;
  const targetZ = isAlly ? -14 : 14;
  const targetX = mem.laneBias === 'west' ? -12 : mem.laneBias === 'east' ? 12 : 0;

  return findClosestWaypointInSubset(pool, targetX, targetZ);
}

function chooseCoverGoal(
  bot: Combatant,
  waypoints: ArenaWaypoint[],
  sdContext?: BotSdContext
): string | null {
  if (waypoints.length === 0) return null;

  // Attackers fall back South (+Z); Defenders fall back North (-Z).
  const isAttacker = sdContext ? bot.team === sdContext.attackerTeam : bot.team === 'ally';
  const friendlyHalf = waypoints.filter((wp) =>
    isAttacker ? wp.pos.z > 10 : wp.pos.z < -10
  );
  const pool = friendlyHalf.length > 0 ? friendlyHalf : waypoints;
  return findClosestWaypointInSubset(pool, bot.position.x * 0.6, isAttacker ? 18 : -18);
}

function chooseSdObjectiveGoal(
  bot: Combatant,
  mem: BotMemory,
  waypoints: ArenaWaypoint[],
  sdContext: BotSdContext,
  executeSite: BombSiteId,
  allCombatants: Combatant[],
  botSlotIndex: number
): { goalId: string | null; directTargetPos: Vec3 | null; shouldHoldAtGoal: boolean; holdLookPos?: Vec3 } {
  const { attackerTeam, spike, sites } = sdContext;
  const isAttacker = bot.team === attackerTeam;

  // -------------------------------------------------------------------------
  // ATTACKER OBJECTIVE LOGIC (Execute, Lurk, Retrieve Dropped Spike, Post-Plant)
  // -------------------------------------------------------------------------
  if (isAttacker) {
    // 1. Post-Plant: guard the planted Spike site from strong crossfire angles!
    if (spike.status === 'planted' && spike.plantedSite) {
      const siteZone = sites[spike.plantedSite];
      const siteWps = getSiteWaypoints(spike.plantedSite, sites, waypoints);
      // Offset guard position slightly per bot slot so attackers establish crossfires
      const angleOffset = (botSlotIndex * 2.1) + (spike.plantedSite === 'A' ? 0.6 : -0.6);
      const guardRadius = mem.role === 'lurker' ? 8.5 : 5.2;
      const desiredX = spike.position.x + Math.cos(angleOffset) * guardRadius;
      const desiredZ = spike.position.z + Math.sin(angleOffset) * guardRadius;

      const nearbyPool = waypoints.filter(
        (wp) => horizDist2D(wp.pos, spike.position) >= 3.2 && horizDist2D(wp.pos, spike.position) <= 12.0
      );
      const pool = nearbyPool.length > 0 ? nearbyPool : siteWps;

      // If we recently spotted a retaking defender near the site, contest them
      if (
        mem.lastSeenPos &&
        mem.timeSinceSeen < 4.0 &&
        horizDist2D(mem.lastSeenPos, spike.position) < 16
      ) {
        return {
          goalId: findNearestWaypointId(mem.lastSeenPos, waypoints),
          directTargetPos: null,
          shouldHoldAtGoal: false,
        };
      }

      return {
        goalId: findClosestWaypointInSubset(pool, desiredX, desiredZ),
        directTargetPos: null,
        shouldHoldAtGoal: true,
        holdLookPos: { x: siteZone.center.x, y: 0, z: siteZone.center.z - 5.0 },
      };
    }

    // 2. Dropped Spike: retrieve immediately!
    if (spike.status === 'dropped') {
      const otherExecuteAlive = allCombatants.some(
        (c) =>
          c.team === attackerTeam &&
          c.alive &&
          !c.isPlayer &&
          c.id !== bot.id
      );
      // Main execute bots ALWAYS recover the dropped Spike; lurker recovers if solo.
      if (mem.role !== 'lurker' || !otherExecuteAlive) {
        const distToDrop = horizDist2D(bot.position, spike.position);
        return {
          goalId: findNearestWaypointId(spike.position, waypoints),
          directTargetPos: distToDrop < 4.5 ? spike.position : null,
          shouldHoldAtGoal: false,
        };
      }
    }

    // 3. Lurker Role (Pre-Plant): route through Mid/Flank connectors on opposite side
    //    to catch rotating Defenders off-guard!
    if (mem.role === 'lurker' && spike.carrierId !== bot.id) {
      if (mem.lastSeenPos && mem.timeSinceSeen < 5.0) {
        return {
          goalId: findNearestWaypointId(mem.lastSeenPos, waypoints),
          directTargetPos: null,
          shouldHoldAtGoal: false,
        };
      }

      const oppositeSite: BombSiteId = executeSite === 'A' ? 'B' : 'A';
      const oppositeX = sites[oppositeSite].center.x;
      const flankNodes = waypoints.filter(
        (wp) => wp.zone === 'flank' || wp.zone === 'mid'
      );

      if (flankNodes.length > 0) {
        // Alternate between lurking mid/flank connector and pushing toward opposite connector
        const targetX =
          mem.laneBias === 'mid' ? 0 : oppositeX * 0.55;
        const targetZ = mem.laneBias === 'mid' ? -2 : -7;
        return {
          goalId: findClosestWaypointInSubset(flankNodes, targetX, targetZ),
          directTargetPos: null,
          shouldHoldAtGoal: true,
          holdLookPos: { x: oppositeX * 0.4, y: 0, z: -18 },
        };
      }

      return {
        goalId: findClosestWaypointInSubset(waypoints, oppositeX * 0.5, -4),
        directTargetPos: null,
        shouldHoldAtGoal: true,
        holdLookPos: { x: 0, y: 0, z: -18 },
      };
    }

    // 4. Main Execute Duo (including Spike Carrier): push target Bomb Site via BFS!
    const targetSiteZone = sites[executeSite];
    const siteWps = getSiteWaypoints(executeSite, sites, waypoints);
    const isCarrier = spike.status === 'carried' && spike.carrierId === bot.id;

    if (isCarrier) {
      const distCenter = horizDist2D(bot.position, targetSiteZone.center);
      return {
        goalId: findClosestWaypointInSubset(
          siteWps,
          targetSiteZone.center.x,
          targetSiteZone.center.z,
          targetSiteZone.center.y
        ),
        directTargetPos: distCenter < 4.0 ? targetSiteZone.center : null,
        shouldHoldAtGoal: false,
      };
    }

    // Execute support teammate: push ahead of/with carrier onto the execute site
    if (mem.lastSeenPos && mem.timeSinceSeen < 4.5) {
      return {
        goalId: findNearestWaypointId(mem.lastSeenPos, waypoints),
        directTargetPos: null,
        shouldHoldAtGoal: false,
      };
    }

    const offsetX = botSlotIndex % 2 === 0 ? -2.2 : 2.2;
    return {
      goalId: findClosestWaypointInSubset(
        siteWps,
        targetSiteZone.center.x + offsetX,
        targetSiteZone.center.z - 1.5
      ),
      directTargetPos: null,
      shouldHoldAtGoal: true,
      holdLookPos: { x: targetSiteZone.center.x, y: 0, z: targetSiteZone.center.z - 10 },
    };
  }

  // -------------------------------------------------------------------------
  // DEFENDER OBJECTIVE LOGIC (Site A Anchor, Mid/Window Watcher, Site B Anchor, Retake)
  // -------------------------------------------------------------------------

  // 1. Spike Planted -> ALL surviving Defenders sprint/rotate via BFS to retake & defuse!
  if (spike.status === 'planted' && spike.plantedSite) {
    const distToSpike = horizDist2D(bot.position, spike.position);
    return {
      goalId: findNearestWaypointId(spike.position, waypoints),
      directTargetPos: distToSpike < 4.5 ? spike.position : null,
      shouldHoldAtGoal: false,
    };
  }

  // 2. Dropped Spike spotted nearby -> Defenders guard the dropped Spike!
  if (spike.status === 'dropped' && horizDist2D(bot.position, spike.position) < 18) {
    return {
      goalId: findNearestWaypointId(spike.position, waypoints),
      directTargetPos: null,
      shouldHoldAtGoal: true,
      holdLookPos: spike.position,
    };
  }

  // 3. Recently spotted enemy -> contest / rotate toward contact
  if (mem.lastSeenPos && mem.timeSinceSeen < 5.5) {
    return {
      goalId: findNearestWaypointId(mem.lastSeenPos, waypoints),
      directTargetPos: null,
      shouldHoldAtGoal: false,
    };
  }

  // 4. Pre-Plant Defensive Assignments: Site A Anchor, Mid/Window Watcher, Site B Anchor
  if (mem.role === 'anchor_a') {
    const siteA = sites.A;
    const siteWps = getSiteWaypoints('A', sites, waypoints);
    // Anchor slightly toward CT side of Site A, watching South approaches
    const jitterX = mem.laneBias === 'west' ? -1.8 : mem.laneBias === 'east' ? 1.8 : 0;
    return {
      goalId: findClosestWaypointInSubset(siteWps, siteA.center.x + jitterX, siteA.center.z - 1.5),
      directTargetPos: null,
      shouldHoldAtGoal: true,
      holdLookPos: { x: siteA.center.x, y: 0, z: siteA.center.z + 12 },
    };
  }

  if (mem.role === 'anchor_b') {
    const siteB = sites.B;
    const siteWps = getSiteWaypoints('B', sites, waypoints);
    const jitterX = mem.laneBias === 'west' ? -1.8 : mem.laneBias === 'east' ? 1.8 : 0;
    return {
      goalId: findClosestWaypointInSubset(siteWps, siteB.center.x + jitterX, siteB.center.z - 1.5),
      directTargetPos: null,
      shouldHoldAtGoal: true,
      holdLookPos: { x: siteB.center.x, y: 0, z: siteB.center.z + 12 },
    };
  }

  // 'mid_watch': watch Mid Courtyard / Mid Sniper Window from Defender side
  const midNodes = waypoints.filter(
    (wp) => wp.zone === 'mid' || (Math.abs(wp.pos.x) <= 7 && wp.pos.z >= -14 && wp.pos.z <= 2)
  );
  const midPool = midNodes.length > 0 ? midNodes : waypoints;
  const watchX = mem.laneBias === 'west' ? -2.0 : mem.laneBias === 'east' ? 2.0 : 0;
  return {
    goalId: findClosestWaypointInSubset(midPool, watchX, -6),
    directTargetPos: null,
    shouldHoldAtGoal: true,
    holdLookPos: { x: 0, y: 0, z: 12 },
  };
}

/**
 * Buy-Phase Staging & Spike Pickup Goal Selector:
 * - Defenders walk via BFS out of CT-Spawn to `anchor_a`, `mid_watch`, and
 *   `anchor_b` staging points strictly inside `spawns.buyMaxDefenderZ`.
 * - Attackers let the human player grab the T-Spawn `'S'` Pedestal Spike for
 *   the first 4.5s (`buyTimeRemainingSec >= 7.5s`); below 7.5s (or when the
 *   enemy team is attacking), the designated carrier walks to `spike.position`
 *   to pick it up while Attackers stage neatly behind `spawns.buyMinAllyZ`.
 */
function chooseBuyPhaseGoal(
  bot: Combatant,
  mem: BotMemory,
  waypoints: ArenaWaypoint[],
  sdContext: BotSdContext,
  botSlotIndex: number,
  designatedBuyCarrierId: string | null,
  hasHumanAttacker: boolean
): {
  goalId: string | null;
  directTargetPos: Vec3 | null;
  lookPos: Vec3;
  isAllowedNode: (wp: ArenaWaypoint) => boolean;
} {
  const spawns = getArenaSpawns();
  const { attackerTeam, spike, sites } = sdContext;
  const isAttacker = bot.team === attackerTeam;

  if (!isAttacker) {
    const defMaxZ = spawns.buyMaxDefenderZ;
    const isAllowedNode = (wp: ArenaWaypoint): boolean => wp.pos.z <= defMaxZ - 0.35;
    const defPoolRaw = waypoints.filter(isAllowedNode);
    const defPool =
      defPoolRaw.length > 0
        ? defPoolRaw
        : waypoints.filter((wp) => wp.pos.z <= defMaxZ + 0.25);
    const pool = defPool.length > 0 ? defPool : waypoints;

    if (mem.role === 'anchor_a') {
      const siteA = sites.A;
      const targetZ = Math.min(siteA.center.z - 1.2, defMaxZ - 1.2);
      const siteAPool = pool.filter((wp) => wp.zone === 'site_a');
      return {
        goalId: findClosestWaypointInSubset(
          siteAPool.length > 0 ? siteAPool : pool,
          siteA.center.x,
          targetZ
        ),
        directTargetPos: null,
        lookPos: { x: siteA.center.x, y: 0, z: siteA.center.z + 16 },
        isAllowedNode,
      };
    }

    if (mem.role === 'anchor_b') {
      const siteB = sites.B;
      const targetZ = Math.min(siteB.center.z - 1.2, defMaxZ - 1.2);
      const siteBPool = pool.filter((wp) => wp.zone === 'site_b');
      return {
        goalId: findClosestWaypointInSubset(
          siteBPool.length > 0 ? siteBPool : pool,
          siteB.center.x,
          targetZ
        ),
        directTargetPos: null,
        lookPos: { x: siteB.center.x, y: 0, z: siteB.center.z + 16 },
        isAllowedNode,
      };
    }

    // 'mid_watch': stage at Mid Window / CT-Mid looking South
    const midPool = pool.filter(
      (wp) => wp.zone === 'mid' || (Math.abs(wp.pos.x) <= 8 && wp.pos.z <= defMaxZ)
    );
    const targetZ = Math.min(-6.0, defMaxZ - 1.2);
    return {
      goalId: findClosestWaypointInSubset(
        midPool.length > 0 ? midPool : pool,
        0,
        targetZ
      ),
      directTargetPos: null,
      lookPos: { x: 0, y: 0, z: 16 },
      isAllowedNode,
    };
  }

  // Attacker Buy Phase
  const atkMinZ = spawns.buyMinAllyZ;
  const isAllowedNode = (wp: ArenaWaypoint): boolean => wp.pos.z >= atkMinZ + 0.35;
  const atkPoolRaw = waypoints.filter(isAllowedNode);
  const atkPool =
    atkPoolRaw.length > 0
      ? atkPoolRaw
      : waypoints.filter((wp) => wp.pos.z >= atkMinZ - 0.25);
  const pool = atkPool.length > 0 ? atkPool : waypoints;

  const buyRemaining = sdContext.buyTimeRemainingSec ?? 0;
  const shouldClaimSpike =
    spike.status === 'dropped' &&
    bot.id === designatedBuyCarrierId &&
    (!hasHumanAttacker || buyRemaining < BUY_SPIKE_BOT_PICKUP_WINDOW_SEC);

  if (shouldClaimSpike) {
    const distToSpike = horizDist2D(bot.position, spike.position);
    return {
      goalId: findClosestWaypointInSubset(pool, spike.position.x, spike.position.z),
      directTargetPos: distToSpike < 7.5 ? spike.position : null,
      lookPos: spike.position,
      isAllowedNode,
    };
  }

  // Stage neatly behind `buyMinAllyZ` facing West (A Main) / Mid / East (B Main) barrier exits
  const midStageX = (sites.A.center.x + sites.B.center.x) * 0.5 + 5.0;
  const stageX =
    mem.role === 'lurker'
      ? midStageX
      : botSlotIndex % 3 === 0
        ? sites.A.center.x
        : botSlotIndex % 3 === 1
          ? midStageX
          : sites.B.center.x;
  const stageZ = atkMinZ + 1.4;
  return {
    goalId: findClosestWaypointInSubset(pool, stageX, stageZ),
    directTargetPos: null,
    lookPos: { x: stageX, y: 0, z: atkMinZ - 16 },
    isAllowedNode,
  };
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
 *   Gate A: `bot.blindTimer <= 0`
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

  for (const box of colliders) {
    if (raycastAABB(eye, dir, box, wallMaxDist) !== null) {
      return false;
    }
  }

  for (const smoke of activeSmokes) {
    if (raycastSphere(eye, dir, smoke.center, smoke.radius, dist) !== null) {
      return false;
    }
  }

  return true;
}

function getCombatantHitboxes(c: Combatant): { head: AABB; body: AABB } {
  const { x, y, z } = c.position;
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

interface BlockingDoorInfo {
  box: AABB;
  doorId: string;
  center: Vec3;
  dist: number;
}

/**
 * Checks whether a closed Blast Door (`tag === 'door' && box.doorId`) blocks
 * the bot's immediate path within `maxDist` meters with clear line of sight.
 */
function findBlockingClosedDoor(
  bot: Combatant,
  pathPoints: Vec3[],
  colliders: AABB[],
  maxDist = BOT_DOOR_DETECT_DIST_M
): BlockingDoorInfo | null {
  if (pathPoints.length === 0) return null;

  // Fast exit when all Blast Doors are open or shattered
  const closedDoors: AABB[] = [];
  for (const box of colliders) {
    if (box.tag === 'door' && box.doorId) {
      closedDoors.push(box);
    }
  }
  if (closedDoors.length === 0) return null;

  const origin: Vec3 = {
    x: bot.position.x,
    y: bot.position.y + 1.25,
    z: bot.position.z,
  };

  // 1. Raycast along upcoming path segments toward next waypoints
  for (const pt of pathPoints) {
    const dx = pt.x - origin.x;
    const dy = pt.y + 1.25 - origin.y;
    const dz = pt.z - origin.z;
    const segDist = Math.hypot(dx, dy, dz);
    if (segDist < 0.08) continue;

    const dir: Vec3 = { x: dx / segDist, y: dy / segDist, z: dz / segDist };
    const rayLimit = Math.min(segDist, maxDist);
    let closestDist = rayLimit;
    let closestBox: AABB | null = null;

    for (const box of colliders) {
      const hit = raycastAABB(origin, dir, box, closestDist);
      if (hit && hit.distance < closestDist) {
        closestDist = hit.distance;
        closestBox = box;
      }
    }

    if (closestBox && closestBox.tag === 'door' && closestBox.doorId) {
      return {
        box: closestBox,
        doorId: closestBox.doorId,
        center: {
          x: (closestBox.min.x + closestBox.max.x) * 0.5,
          y: (closestBox.min.y + closestBox.max.y) * 0.5,
          z: (closestBox.min.z + closestBox.max.z) * 0.5,
        },
        dist: closestDist,
      };
    }
  }

  // 2. Close-proximity oblique approach guard (prevents snagging near doorway edges)
  const firstPt = pathPoints[0];
  const moveDx = firstPt.x - bot.position.x;
  const moveDz = firstPt.z - bot.position.z;
  const moveLen = Math.hypot(moveDx, moveDz);
  if (moveLen > 0.1) {
    const mx = moveDx / moveLen;
    const mz = moveDz / moveLen;

    for (const doorBox of closedDoors) {
      const center: Vec3 = {
        x: (doorBox.min.x + doorBox.max.x) * 0.5,
        y: (doorBox.min.y + doorBox.max.y) * 0.5,
        z: (doorBox.min.z + doorBox.max.z) * 0.5,
      };
      const toDx = center.x - origin.x;
      const toDy = center.y - origin.y;
      const toDz = center.z - origin.z;
      const horizD = Math.hypot(toDx, toDz);
      if (horizD > 2.8 || Math.abs(toDy) > 2.2) continue;

      const dot = horizD > 1e-4 ? (toDx * mx + toDz * mz) / horizD : 1;
      if (dot < 0.25) continue;

      const dist3d = Math.hypot(toDx, toDy, toDz);
      if (dist3d < 1e-4) continue;
      const dir: Vec3 = { x: toDx / dist3d, y: toDy / dist3d, z: toDz / dist3d };
      let closestDist = Math.min(dist3d + 0.5, maxDist);
      let closestBox: AABB | null = null;
      for (const box of colliders) {
        const hit = raycastAABB(origin, dir, box, closestDist);
        if (hit && hit.distance < closestDist) {
          closestDist = hit.distance;
          closestBox = box;
        }
      }
      if (closestBox === doorBox && doorBox.doorId) {
        return {
          box: doorBox,
          doorId: doorBox.doorId,
          center,
          dist: closestDist,
        };
      }
    }
  }

  return null;
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
  resetRound(combatants: Combatant[], attackerTeam?: TeamId): void;
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
    onFire: BotFireCallback,
    sdContext?: BotSdContext
  ): void;
}

export function createBotBrainSystem(): BotBrainSystem {
  const memories = new Map<string, BotMemory>();
  let difficulty: AiDifficulty = 'casual';
  let roundExecuteSite: BombSiteId = 'A';
  let rolesAssignedForAttackerTeam: TeamId | null = null;
  let lastCombatActive = false;

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
        role: 'execute',
        route: [],
        goalId: null,
        laneBias,
        holdTimer: 0,
        holdYaw: bot.yaw,
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

  function assignRoles(combatants: Combatant[], attackerTeam: TeamId, spikeCarrierId?: string | null): void {
    rolesAssignedForAttackerTeam = attackerTeam;

    const attackers = combatants.filter((c) => c.team === attackerTeam);
    const defenders = combatants.filter((c) => c.team !== attackerTeam);

    // Assign Attackers: main execute duo (including carrier) + 1 dedicated Lurker bot
    const attackerBots = attackers.filter((c) => !c.isPlayer);
    for (const a of attackers) {
      getOrCreateMemory(a).role = 'execute';
    }
    if (attackerBots.length >= 2) {
      // Pick a lurker who is NOT carrying the Spike, preferring flankers/duelists
      const lurkCandidates = attackerBots.filter((b) => b.id !== spikeCarrierId);
      const lurker =
        lurkCandidates.find((b) => b.colorId === 'red' || b.colorId === 'gold' || b.colorId === 'violet') ??
        lurkCandidates[lurkCandidates.length - 1] ??
        attackerBots[attackerBots.length - 1];
      if (lurker) {
        getOrCreateMemory(lurker).role = 'lurker';
      }
    }

    // Assign Defenders across Site A Anchor, Mid/Window Watcher, and Site B Anchor
    if (defenders.length > 0) {
      // Prefer blue/violet sniper/controller for mid_watch if available
      const midPref =
        defenders.find((d) => d.colorId === 'blue' || d.colorId === 'violet') ??
        defenders[Math.min(1, defenders.length - 1)];
      const remaining = defenders.filter((d) => d.id !== midPref.id);

      getOrCreateMemory(midPref).role = 'mid_watch';
      if (remaining[0]) getOrCreateMemory(remaining[0]).role = 'anchor_a';
      if (remaining[1]) getOrCreateMemory(remaining[1]).role = 'anchor_b';
    }
  }

  function resetRound(combatants: Combatant[], attackerTeam?: TeamId): void {
    memories.clear();
    roundExecuteSite = Math.random() < 0.5 ? 'A' : 'B';
    rolesAssignedForAttackerTeam = null;
    lastCombatActive = false;

    for (const c of combatants) {
      getOrCreateMemory(c);
    }

    if (attackerTeam) {
      assignRoles(combatants, attackerTeam, null);
    }
  }

  function stepSingleBot(
    bot: Combatant,
    botSlotIndex: number,
    allCombatants: Combatant[],
    colliders: AABB[],
    activeSmokes: SmokeSphere[],
    waypoints: ArenaWaypoint[],
    waypointById: Map<string, ArenaWaypoint>,
    cameraPos: Vec3,
    isCombatActive: boolean,
    dt: number,
    abilities: AbilitySystem,
    weaponSystem: WeaponSystem,
    sfx: SoundEngine,
    onDamage: BotDamageCallback,
    onFire: BotFireCallback,
    sdContext: BotSdContext | undefined,
    primaryDefuserId: string | null,
    designatedBuyCarrierId: string | null,
    hasHumanAttacker: boolean
  ): void {
    const mem = getOrCreateMemory(bot);
    const spec = WEAPON_SPECS[bot.weaponId];
    const prof = DIFFICULTY_PROFILES[difficulty];
    const concussed = (bot.concussTimer ?? 0) > 0;
    const sliding = (bot.slideTimer ?? 0) > 0;
    const slewPenalty = concussed ? CONCUSS_SPREAD_SLEW_PENALTY : 1.0;

    const blazeUltActive = bot.colorId === 'red' && (bot.ultActiveTimer ?? 0) > 0;
    const voltUltActive = bot.colorId === 'gold' && (bot.ultActiveTimer ?? 0) > 0;
    const teamPulseUltActive = allCombatants.some(
      (c) => c.alive && c.team === bot.team && c.colorId === 'green' && (c.ultActiveTimer ?? 0) > 0
    );

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

    const botPhysics: PlayerState = {
      position: bot.position,
      velocity: bot.velocity,
      grounded: bot.grounded,
      health: bot.health,
      maxHealth: bot.maxHealth,
      armor: bot.armor,
      maxArmor: bot.maxArmor,
      colorId: bot.colorId,
    };

    const slowSpeedMult = bot.slowTimer > 0.35 ? 0.25 : bot.slowTimer > 0 ? 0.5 : 1.0;
    const modifiers: MovementModifiers = {
      dashActive: false,
      dashVelocity: { x: 0, y: 0, z: 0 },
      speedMultiplier:
        spec.moveSpeedMult *
        slowSpeedMult *
        (concussed ? CONCUSS_SPEED_MULT : 1.0) *
        (sliding ? SLIDE_SPEED_MULT : 1.0) *
        (blazeUltActive ? 1.2 : 1.0) *
        (voltUltActive ? 1.5 : 1.0) *
        (teamPulseUltActive ? 1.15 : 1.0),
      suppressJump: bot.slowTimer > 0,
    };

    // Buy-Phase Site Setup & T-Spawn Spike Pedestal Pickup (strictly barrier-clamped)
    if (!isCombatActive) {
      const buyInput: InputState = {
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

      if (sdContext && waypoints.length > 0) {
        const spawns = getArenaSpawns();
        const isAttacker = bot.team === sdContext.attackerTeam;
        const buyObj = chooseBuyPhaseGoal(
          bot,
          mem,
          waypoints,
          sdContext,
          botSlotIndex,
          designatedBuyCarrierId,
          hasHumanAttacker
        );

        let desiredYaw = bot.yaw;

        if (buyObj.directTargetPos) {
          const dx = buyObj.directTargetPos.x - bot.position.x;
          const dz = buyObj.directTargetPos.z - bot.position.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 0.35) {
            desiredYaw = Math.atan2(-dx, -dz);
            buyInput.forward = true;
          }
        } else if (buyObj.goalId) {
          const goalWp = waypointById.get(buyObj.goalId);
          const distToGoal = goalWp ? horizDist2D(bot.position, goalWp.pos) : Infinity;

          if (distToGoal <= 1.2) {
            // Staged cleanly at Buy-Phase position: face barrier / choke approach!
            mem.route = [];
            desiredYaw = Math.atan2(
              -(buyObj.lookPos.x - bot.position.x),
              -(buyObj.lookPos.z - bot.position.z)
            );
          } else {
            if (
              mem.route.length === 0 ||
              mem.goalId !== buyObj.goalId ||
              !waypointById.has(mem.route[0])
            ) {
              const startId = findNearestWaypointId(bot.position, waypoints);
              mem.route = startId
                ? findShortestPath(startId, buyObj.goalId, waypointById, buyObj.isAllowedNode)
                : [];
              mem.goalId = buyObj.goalId;
            }

            const nextWp = mem.route.length > 0 ? waypointById.get(mem.route[0]) : undefined;
            if (nextWp) {
              const dx = nextWp.pos.x - bot.position.x;
              const dz = nextWp.pos.z - bot.position.z;
              const horizDist = Math.hypot(dx, dz);
              if (horizDist < 1.15 && Math.abs(nextWp.pos.y - bot.position.y) < 1.8) {
                mem.route.shift();
              }
              if (horizDist > 0.15) {
                desiredYaw = Math.atan2(-dx, -dz);
                buyInput.forward = true;
              }
            }
          }
        }

        const maxStep = prof.slewRadPerSec * dt;
        const yawDiff = wrapAngleRad(desiredYaw - bot.yaw);
        bot.yaw = wrapAngleRad(bot.yaw + clamp(yawDiff, -maxStep, maxStep));
        bot.pitch = 0;
        buyInput.yaw = bot.yaw;

        updatePlayerMovement(botPhysics, buyInput, colliders, dt, modifiers);
        bot.grounded = botPhysics.grounded;

        // Strictly clamp every bot inside its Buy-Phase Barrier fence!
        if (!isAttacker) {
          if (bot.position.z > spawns.buyMaxDefenderZ) {
            bot.position.z = spawns.buyMaxDefenderZ;
            if (bot.velocity.z > 0) bot.velocity.z = 0;
          }
        } else {
          if (bot.position.z < spawns.buyMinAllyZ) {
            bot.position.z = spawns.buyMinAllyZ;
            if (bot.velocity.z < 0) bot.velocity.z = 0;
          }
        }
        return;
      }

      updatePlayerMovement(botPhysics, buyInput, colliders, dt, modifiers);
      bot.grounded = botPhysics.grounded;
      return;
    }

    // 1. Multi-Gate Perception Scan
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

    // 2. Check S&D Plant / Defuse Opportunities
    let wantsPlant = false;
    let wantsDefuse = false;

    if (sdContext && bot.blindTimer <= 0) {
      const { attackerTeam, spike, sites } = sdContext;
      const isAttacker = bot.team === attackerTeam;

      // Attacker Carrier planting when inside target site (or either site) and not dueling close-range
      if (
        isAttacker &&
        spike.status === 'carried' &&
        spike.carrierId === bot.id
      ) {
        const insideTarget = isPosInsideSite(bot.position, sites[roundExecuteSite]);
        const insideAnySite =
          insideTarget ||
          isPosInsideSite(bot.position, sites.A) ||
          isPosInsideSite(bot.position, sites.B);
        const underCloseThreat = spottedTarget !== null && spottedDist < BOT_PLANT_THREAT_DIST_M;

        if (insideAnySite && !underCloseThreat) {
          wantsPlant = true;
        }
      }

      // Defender sticking defuse within 2.6m of planted Spike when clear OR < 7.5s left
      if (
        !isAttacker &&
        spike.status === 'planted' &&
        primaryDefuserId === bot.id
      ) {
        const distToSpike = horizDist2D(bot.position, spike.position);
        const urgentClock = spike.timerSec < BOT_URGENT_DEFUSE_TIMER_SEC;
        const clearOfThreat = spottedTarget === null || spottedDist > 16.0;
        if (distToSpike <= BOT_DEFUSE_RANGE_M && (clearOfThreat || urgentClock)) {
          wantsDefuse = true;
        }
      }
    }

    // 3. FSM State Transitions
    if (bot.blindTimer > 0) {
      mem.fsm = 'blinded';
    } else if (wantsDefuse) {
      mem.fsm = 'defuse';
    } else if (wantsPlant) {
      mem.fsm = 'plant';
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

    // 4. Tactical Ability & Signature [X] Ultimate Casting (role-driven)
    if (
      mem.fsm !== 'blinded' &&
      mem.fsm !== 'plant' &&
      mem.fsm !== 'defuse' &&
      mem.abilityCheckTimer <= 0
    ) {
      mem.abilityCheckTimer = 0.65;
      const botEye: Vec3 = { x: bot.position.x, y: bot.position.y + BOT_EYE_HEIGHT, z: bot.position.z };

      // Bot Signature [X] Ultimate when charged (ultPoints >= 5) and engaged or executing/retaking
      let castUltimate = false;
      if ((bot.ultPoints ?? 0) >= MAX_ULT_POINTS) {
        const isExecutingOrRetaking = Boolean(
          sdContext &&
            (sdContext.spike.status === 'planted' ||
              (bot.team === sdContext.attackerTeam && Math.abs(bot.position.z) < 26))
        );
        const engaged = spottedTarget !== null;
        let shouldCastUlt = false;
        let ultYaw = bot.yaw;
        let ultPitch = bot.pitch;

        if (bot.colorId === 'red') {
          shouldCastUlt = engaged || isExecutingOrRetaking;
        } else if (bot.colorId === 'blue') {
          if (spottedTarget && spottedDist > 6 && spottedDist < 32) {
            const aim = computeAimAngles(botEye, {
              x: spottedTarget.position.x,
              y: spottedTarget.position.y + 0.5,
              z: spottedTarget.position.z,
            });
            ultYaw = aim.yaw;
            ultPitch = aim.pitch;
            shouldCastUlt = true;
          } else if (
            sdContext?.spike.status === 'planted' &&
            horizDist2D(bot.position, sdContext.spike.position) < 26
          ) {
            const aim = computeAimAngles(botEye, {
              x: sdContext.spike.position.x,
              y: sdContext.spike.position.y + 0.6,
              z: sdContext.spike.position.z,
            });
            ultYaw = aim.yaw;
            ultPitch = aim.pitch;
            shouldCastUlt = true;
          }
        } else if (bot.colorId === 'green') {
          shouldCastUlt = engaged || isExecutingOrRetaking;
        } else if (bot.colorId === 'violet') {
          if (spottedTarget && spottedDist > 6) {
            const aim = computeAimAngles(botEye, {
              x: spottedTarget.position.x,
              y: spottedTarget.position.y + 1.0,
              z: spottedTarget.position.z,
            });
            ultYaw = aim.yaw;
            ultPitch = 0;
            shouldCastUlt = true;
          } else if (isExecutingOrRetaking && sdContext) {
            const siteTarget =
              sdContext.spike.status === 'planted'
                ? sdContext.spike.position
                : sdContext.sites[roundExecuteSite].center;
            const aim = computeAimAngles(botEye, {
              x: siteTarget.x,
              y: siteTarget.y + 1.0,
              z: siteTarget.z,
            });
            ultYaw = aim.yaw;
            ultPitch = 0;
            shouldCastUlt = true;
          }
        } else if (bot.colorId === 'gold') {
          shouldCastUlt = (engaged && spottedDist < 22) || isExecutingOrRetaking;
        }

        if (shouldCastUlt && abilities.castForBot('x', bot, ultYaw, ultPitch)) {
          bot.ultPoints = 0;
          bot.ultActiveTimer = BOT_ULT_ACTIVE_SEC;
          sfx.playUltimateActivate(bot.colorId);
          castUltimate = true;
        }
      }

      if (castUltimate) {
        // Let signature ultimate breathe before casting secondary utility
      } else if (bot.colorId === 'blue') {
        if (spottedTarget && spottedDist > 8 && spottedDist < 30) {
          const aim = computeAimAngles(botEye, {
            x: spottedTarget.position.x,
            y: spottedTarget.position.y + 0.5,
            z: spottedTarget.position.z,
          });
          if (!abilities.castForBot('e', bot, aim.yaw, aim.pitch)) {
            abilities.castForBot('q', bot, aim.yaw, aim.pitch);
          }
        } else if (Math.abs(bot.position.z) < 16) {
          const smokeTarget: Vec3 = sdContext
            ? sdContext.sites[roundExecuteSite].center
            : { x: 0, y: 1.0, z: 0 };
          const aim = computeAimAngles(botEye, { x: smokeTarget.x, y: 1.0, z: smokeTarget.z });
          abilities.castForBot('q', bot, aim.yaw, aim.pitch);
        }
      } else if (bot.colorId === 'green') {
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
        const sightTarget: Vec3 | null = spottedTarget
          ? spottedTarget.position
          : mem.lastSeenPos && mem.timeSinceSeen < 2.5
            ? mem.lastSeenPos
            : null;
        const sightDist = sightTarget ? horizDist2D(bot.position, sightTarget) : Infinity;

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

    // 5. Movement Intent & Target Look Angles per FSM State
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
    let blockingDoor: BlockingDoorInfo | null = null;

    if (mem.fsm === 'plant' && sdContext) {
      // Stand still in safe site zone and channel Spike plant
      desiredPitch = -0.35;
      sdContext.onBotPlantTick?.(bot, dt);
    } else if (mem.fsm === 'defuse' && sdContext) {
      // Crouch/stick defuse facing the planted Spike
      const botEye: Vec3 = { x: bot.position.x, y: bot.position.y + BOT_EYE_HEIGHT, z: bot.position.z };
      const aim = computeAimAngles(botEye, {
        x: sdContext.spike.position.x,
        y: sdContext.spike.position.y + 0.3,
        z: sdContext.spike.position.z,
      });
      desiredYaw = aim.yaw;
      desiredPitch = aim.pitch;
      sdContext.onBotDefuseTick?.(bot, dt);
    } else if (mem.fsm === 'blinded') {
      botInput.backward = true;
      botInput.walk = true;
      desiredYaw = bot.yaw + dt * 1.4 * mem.strafeDir;
      desiredPitch = -0.15;
    } else if (mem.fsm === 'engage' && spottedTarget) {
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

      // Counter-strafe cadence: alternate strafe bursts with crisp stationary accuracy windows
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
      // 'advance' or 'evade_cover': navigate 2-Site S&D waypoint graph via BFS
      let targetGoalId: string | null = null;
      let directTargetPos: Vec3 | null = null;
      let shouldHoldAtGoal = false;
      let holdLookPos: Vec3 | undefined;

      if (mem.fsm === 'evade_cover') {
        targetGoalId = chooseCoverGoal(bot, waypoints, sdContext);
      } else if (sdContext) {
        const obj = chooseSdObjectiveGoal(
          bot,
          mem,
          waypoints,
          sdContext,
          roundExecuteSite,
          allCombatants,
          botSlotIndex
        );
        targetGoalId = obj.goalId;
        directTargetPos = obj.directTargetPos;
        shouldHoldAtGoal = obj.shouldHoldAtGoal;
        holdLookPos = obj.holdLookPos;
      } else {
        targetGoalId = chooseFallbackTacticalGoal(bot, mem, waypoints);
      }

      if (directTargetPos) {
        // Direct final approach onto exact Spike / site center (prevents 2m tile-center offset stalls)
        const dx = directTargetPos.x - bot.position.x;
        const dz = directTargetPos.z - bot.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.35) {
          desiredYaw = Math.atan2(-dx, -dz);
          desiredPitch = 0;
          botInput.forward = true;
        }
      } else {
        if (
          targetGoalId &&
          (mem.route.length === 0 ||
            mem.goalId !== targetGoalId ||
            !waypointById.has(mem.route[0]))
        ) {
          if (mem.holdTimer > 0 && mem.goalId === targetGoalId && shouldHoldAtGoal) {
            // Holding tactical angle at anchor / guard waypoint
            mem.holdTimer -= dt;
            desiredYaw = mem.holdYaw;
            desiredPitch = 0;
          } else {
            const startId = findNearestWaypointId(bot.position, waypoints);
            mem.route = startId ? findShortestPath(startId, targetGoalId, waypointById) : [];
            mem.goalId = targetGoalId;
          }
        }

        const nextWp = mem.route.length > 0 ? waypointById.get(mem.route[0]) : undefined;
        if (nextWp) {
          const dx = nextWp.pos.x - bot.position.x;
          const dz = nextWp.pos.z - bot.position.z;
          const horizDist = Math.hypot(dx, dz);

          if (horizDist < 1.25 && Math.abs(nextWp.pos.y - bot.position.y) < 1.8) {
            mem.route.shift();
            if (mem.route.length === 0) {
              mem.lastSeenPos = null;
              if (shouldHoldAtGoal) {
                mem.holdTimer = 3.0 + Math.random() * 2.5;
                if (holdLookPos) {
                  mem.holdYaw = Math.atan2(
                    -(holdLookPos.x - bot.position.x),
                    -(holdLookPos.z - bot.position.z)
                  );
                } else {
                  mem.holdYaw = bot.yaw;
                }
              }
              mem.laneBias =
                mem.laneBias === 'west' ? 'mid' : mem.laneBias === 'mid' ? 'east' : 'west';
            }
          }

          if (horizDist > 0.15) {
            const moveYaw = Math.atan2(-dx, -dz);
            desiredYaw = moveYaw;
            desiredPitch = 0;

            if (mem.fsm === 'evade_cover' && spottedTarget) {
              const botEye: Vec3 = {
                x: bot.position.x,
                y: bot.position.y + BOT_EYE_HEIGHT,
                z: bot.position.z,
              };
              const aim = computeAimAngles(botEye, {
                x: spottedTarget.position.x,
                y: spottedTarget.position.y + prof.aimHeightM - slideDrop(spottedTarget),
                z: spottedTarget.position.z,
              });
              desiredYaw = aim.yaw;
              desiredPitch = aim.pitch;

              const relAngle = wrapAngleRad(moveYaw - bot.yaw);
              if (Math.cos(relAngle) > 0.35) botInput.forward = true;
              else if (Math.cos(relAngle) < -0.35) botInput.backward = true;
              if (Math.sin(relAngle) < -0.35) botInput.right = true;
              else if (Math.sin(relAngle) > 0.35) botInput.left = true;
            } else {
              botInput.forward = true;
              // Lurkers walk quietly when approaching mid/flank angles pre-plant
              if (
                sdContext &&
                mem.role === 'lurker' &&
                sdContext.spike.status === 'carried' &&
                Math.abs(bot.position.z) < 12
              ) {
                botInput.walk = true;
              }
            }
          }
        }
      }

      // Closed Blast Door awareness: if a closed steel shutter blocks the path within ~6m,
      // halt movement and aim at door center to breach it with weapon bursts!
      if (!spottedTarget) {
        const pathPoints: Vec3[] = [];
        if (directTargetPos) {
          pathPoints.push(directTargetPos);
        } else {
          for (let r = 0; r < Math.min(3, mem.route.length); r++) {
            const wp = waypointById.get(mem.route[r]);
            if (wp) pathPoints.push(wp.pos);
          }
        }

        blockingDoor = findBlockingClosedDoor(bot, pathPoints, colliders);
        if (blockingDoor) {
          botInput.forward = false;
          botInput.left = false;
          botInput.right = false;
          botInput.walk = false;
          botInput.backward = blockingDoor.dist < 1.35;

          const botEye: Vec3 = {
            x: bot.position.x,
            y: bot.position.y + BOT_EYE_HEIGHT,
            z: bot.position.z,
          };
          const doorAim = computeAimAngles(botEye, blockingDoor.center);
          desiredYaw = doorAim.yaw;
          desiredPitch = doorAim.pitch;
        }
      }
    }

    // 6. Smoothly Slew Yaw & Pitch via Shortest-Arc Wrapping (`atan2(sin, cos)`)
    const maxStep = (prof.slewRadPerSec / slewPenalty) * dt;
    const yawDiff = wrapAngleRad(desiredYaw - bot.yaw);
    bot.yaw = wrapAngleRad(bot.yaw + clamp(yawDiff, -maxStep, maxStep));

    const pitchDiff = desiredPitch - bot.pitch;
    bot.pitch = clamp(bot.pitch + clamp(pitchDiff, -maxStep, maxStep), -1.35, 1.35);
    botInput.yaw = bot.yaw;
    botInput.pitch = bot.pitch;

    // 7. Step Authentic Physics Movement
    updatePlayerMovement(botPhysics, botInput, colliders, dt, modifiers);
    bot.grounded = botPhysics.grounded;

    // 8. Hitscan Burst Combat (respects Casual / Tactical / Pro ladder)
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
        const fireRateMult =
          (concussed ? CONCUSS_FIRE_RATE_MULT : 1.0) * (blazeUltActive ? 1.35 : 1.0);
        mem.fireTimer = (baseInterval * prof.fireIntervalScale) / fireRateMult;

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
        const recoilScale = blazeUltActive ? 0.65 : 1.0;
        mem.recoilAccum = Math.min(1.0, mem.recoilAccum + spec.recoilPerShot * 0.85 * recoilScale);

        onFire(bot);

        const listenerDist = Math.hypot(
          origin.x - cameraPos.x,
          origin.y - cameraPos.y,
          origin.z - cameraPos.z
        );
        sfx.playWeaponShot(bot.weaponId, blazeUltActive, listenerDist);

        // Raycast static colliders & closed doors first (bullets pass cleanly through open windows!)
        let closestWallDist = BOT_MAX_RAY_DIST;
        let closestWallHit: RaycastHit | null = null;
        let closestWallBox: AABB | null = null;
        for (const box of colliders) {
          const hit = raycastAABB(origin, shotDir, box, closestWallDist);
          if (hit && hit.distance < closestWallDist) {
            closestWallDist = hit.distance;
            closestWallHit = hit;
            closestWallBox = box;
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
          if (closestWallBox && closestWallBox.tag === 'door' && closestWallBox.doorId) {
            const doorDmg = computeWeaponDamage(spec, closestWallDist, false);
            const doorRes = damageArenaDoor(closestWallBox.doorId, doorDmg);
            if (doorRes.hit) {
              if (doorRes.broken) sfx.playDoorBreak();
              else if (listenerDist < 42) sfx.playDoorHit();
            }
          }
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
    } else if (
      blockingDoor &&
      !spottedTarget &&
      !mem.reloading &&
      mem.ammo > 0 &&
      mem.fireTimer <= 0 &&
      Math.abs(yawDiff) < 0.35
    ) {
      // Dedicated Blast Door breaching bursts until the shutter shatters
      mem.ammo -= 1;
      const fireRateMult =
        (concussed ? CONCUSS_FIRE_RATE_MULT : 1.0) * (blazeUltActive ? 1.35 : 1.0);
      const rawDoorInterval =
        bot.weaponId === 'sniper'
          ? BOT_DOOR_FIRE_MAX_INTERVAL_SEC
          : clamp(
              spec.fireIntervalSec * 1.6,
              BOT_DOOR_FIRE_MIN_INTERVAL_SEC,
              BOT_DOOR_FIRE_MAX_INTERVAL_SEC
            );
      mem.fireTimer = rawDoorInterval / fireRateMult;

      const origin: Vec3 = {
        x: bot.position.x,
        y: bot.position.y + BOT_EYE_HEIGHT - slideDrop(bot),
        z: bot.position.z,
      };
      const baseDir = getLookDirection(bot.yaw, bot.pitch);
      const shotDir = applyBotSpread(baseDir, 0.018);

      onFire(bot);

      const listenerDist = Math.hypot(
        origin.x - cameraPos.x,
        origin.y - cameraPos.y,
        origin.z - cameraPos.z
      );
      sfx.playWeaponShot(bot.weaponId, blazeUltActive, listenerDist);

      const doorHit = raycastAABB(origin, shotDir, blockingDoor.box, BOT_DOOR_DETECT_DIST_M + 2.0);
      const hitPoint = doorHit ? doorHit.point : blockingDoor.center;
      const hitNormal = doorHit ? doorHit.normal : null;
      const hitDist = doorHit ? doorHit.distance : blockingDoor.dist;

      const paletteHex = AGENT_PALETTES[bot.colorId].hex;
      const muzzleOffset: Vec3 = {
        x: origin.x + shotDir.x * 0.45,
        y: origin.y - 0.12,
        z: origin.z + shotDir.z * 0.45,
      };
      weaponSystem.spawnWorldTracer(muzzleOffset, hitPoint, hitNormal, paletteHex, false);

      const botDoorDamage = computeWeaponDamage(spec, hitDist, false);
      const doorRes = damageArenaDoor(blockingDoor.doorId, botDoorDamage);
      if (doorRes.hit) {
        if (doorRes.broken) sfx.playDoorBreak();
        else if (listenerDist < 42) sfx.playDoorHit();
      }

      if (mem.ammo <= 0) {
        mem.reloading = true;
        mem.reloadTimer = spec.reloadDurationSec;
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
    onFire: BotFireCallback,
    sdContext?: BotSdContext
  ): void {
    // Lazily ensure tactical roles match current attacking side (e.g., post-halftime swap)
    if (sdContext && rolesAssignedForAttackerTeam !== sdContext.attackerTeam) {
      assignRoles(combatants, sdContext.attackerTeam, sdContext.spike.carrierId);
    }

    // Clear buy-phase staging routes the moment barriers drop so bots launch into combat immediately
    if (isCombatActive && !lastCombatActive) {
      for (const mem of memories.values()) {
        mem.route = [];
        mem.goalId = null;
        mem.holdTimer = 0;
      }
    }
    lastCombatActive = isCombatActive;

    // Build waypoint lookup once per tick across all bots for O(1) lookups (used in BOTH Buy & Combat)
    const waypoints = getArenaWaypoints();
    const waypointById = new Map<string, ArenaWaypoint>();
    for (const wp of waypoints) {
      waypointById.set(wp.id, wp);
    }

    // Determine single primary defender bot closest to planted Spike so teammates cover
    let primaryDefuserId: string | null = null;
    if (sdContext && sdContext.spike.status === 'planted') {
      let bestDist = Infinity;
      for (const c of combatants) {
        if (c.isPlayer || !c.alive || c.team === sdContext.attackerTeam) continue;
        const d = horizDist2D(c.position, sdContext.spike.position);
        if (d < bestDist) {
          bestDist = d;
          primaryDefuserId = c.id;
        }
      }
    }

    // Determine designated Attacker bot for Buy-Phase T-Spawn Spike Pedestal pickup
    let designatedBuyCarrierId: string | null = null;
    const hasHumanAttacker = Boolean(
      sdContext && combatants.some((c) => c.isPlayer && c.alive && c.team === sdContext.attackerTeam)
    );
    if (!isCombatActive && sdContext && sdContext.spike.status === 'dropped') {
      const attackerBots = combatants.filter(
        (c) => !c.isPlayer && c.alive && c.team === sdContext.attackerTeam
      );
      const executeBot = attackerBots.find((b) => getOrCreateMemory(b).role === 'execute');
      if (executeBot) {
        designatedBuyCarrierId = executeBot.id;
      } else if (attackerBots.length > 0) {
        let bestDist = Infinity;
        for (const b of attackerBots) {
          const d = horizDist2D(b.position, sdContext.spike.position);
          if (d < bestDist) {
            bestDist = d;
            designatedBuyCarrierId = b.id;
          }
        }
      }
    }

    for (let i = 0; i < combatants.length; i++) {
      const c = combatants[i];
      if (c.isPlayer || !c.alive) continue;
      stepSingleBot(
        c,
        i,
        combatants,
        colliders,
        activeSmokes,
        waypoints,
        waypointById,
        cameraPos,
        isCombatActive,
        dt,
        abilities,
        weaponSystem,
        sfx,
        onDamage,
        onFire,
        sdContext,
        primaryDefuserId,
        designatedBuyCarrierId,
        hasHumanAttacker
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
