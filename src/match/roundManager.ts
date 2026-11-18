import * as THREE from 'three';
import {
  AABB,
  AGENT_ORDER,
  AGENT_PALETTES,
  AgentColorId,
  AiDifficulty,
  BombSiteId,
  Combatant,
  InputState,
  KillFeedEntry,
  MatchHudState,
  MinimapContact,
  PlayerState,
  RoundPhase,
  ShieldTier,
  SmokeSphere,
  SpikeHudState,
  SpikeStatus,
  TacticalSide,
  TargetDummy,
  TeamId,
  Vec3,
  WeaponId,
} from '../core/types';
import {
  ARENA_COLLIDERS,
  getArenaSpawns,
  getBombSiteAt,
  getBombSites,
  getSpikeSpawnPos,
} from '../arena/map';
import { raycastAABB, raycastSphere } from '../physics/movement';
import { WEAPON_SPECS } from '../combat/arsenal';
import { CharacterRig, createCharacterModel } from '../entities/characterModel';
import { createSpikeModel } from '../entities/spikeModel';
import { AbilitySystem } from '../abilities/system';
import { WeaponSystem } from '../combat/weapons';
import { SoundEngine } from '../audio/sfx';
import { TargetsManager } from '../combat/targets';
import { BotSdContext, createBotBrainSystem } from '../ai/botBrain';
import { createEconomySystem } from './economy';

/**
 * ============================================================================
 * 3v3 Search & Destroy Round State Machine, Economy & Spike Orchestrator
 * ============================================================================
 *
 * Match Structure (`First to 6 Wins`, Halftime Side Swap after Round 5):
 *   - Rounds 1–5: Allies start as `'attacker'` (South `+Z`), Enemies as `'defender'` (North `-Z`).
 *   - Round 6+  : Halftime side swap — Allies become `'defender'` (North `-Z`),
 *                 Enemies become `'attacker'` (South `+Z`), economy resets to
 *                 `800¤` pistol round!
 *
 * Round Phases:
 *   1. `'buy'` (`12.0s`)       : Shop weapons/shields (`[B]` / shop API), bots run
 *                                eco/half-buy/full-buy AI, `[Space]` skips to fight.
 *   2. `'combat'` (`85.0s`)    : Full 2-Site S&D loop (drop `[G]`, pickup `1.8m`,
 *                                plant `3.0s` inside Site A/B -> `45.0s` timer +
 *                                `+300¤` team bonus, defuse `5.0s` with permanent
 *                                50% halfway checkpoint + `+300¤` team bonus,
 *                                detonation blast inside `15m`).
 *   3. `'round_end'` (`3.2s`)  : Applies win/loss-streak rewards & survivor carryover.
 *   4. `'match_over'`          : Awaits `[Enter]` -> `restartMatch()`.
 */

export interface MatchManager {
  combatants: Combatant[];
  enemyTargetsView: TargetsManager;
  allTargetsView: TargetsManager;
  getPlayerCombatant(): Combatant;
  getPlayerOwnedPrimary(): WeaponId | null;
  getPlayerSide(): TacticalSide;
  selectPlayerAgent(colorId: AgentColorId): void;
  setDifficulty(diff: AiDifficulty): void;
  getDifficulty(): AiDifficulty;
  tryTakeoverAlly(): AgentColorId | null;
  skipBuyPhase(): void;
  restartMatch(): void;
  onMapRebuilt(): void;
  setThirdPersonMode(thirdPerson: boolean): void;
  buyWeapon(weaponId: WeaponId): boolean;
  refundCurrentRoundWeapon(): boolean;
  buyShield(tier: ShieldTier): boolean;
  swapSides(): void;
  tryCastPlayerUltimate(player: PlayerState, input: InputState): boolean;
  syncPlayerFromPhysics(
    player: PlayerState,
    yaw: number,
    pitch: number,
    weaponId: WeaponId,
    firedThisFrame: boolean,
    interactHeld?: boolean,
    dropSpikePressed?: boolean
  ): void;
  update(
    dt: number,
    player: PlayerState,
    cameraPos: Vec3,
    activeSmokes: SmokeSphere[],
    ultRevealAll?: boolean
  ): MatchHudState;
}

const WINS_TO_WIN_MATCH = 6;
const HALFTIME_AFTER_ROUND = 5;
const MAX_ULT_POINTS = 5;
const INITIAL_ULT_POINTS = 2;
const PLAYER_ULT_ACTIVE_SEC = 7.5;
const BUY_PHASE_DURATION_SEC = 12.0;
const COMBAT_PHASE_DURATION_SEC = 85.0;
const POST_PLANT_DURATION_SEC = 45.0;
const PLANT_TIME_SEC = 3.0;
const DEFUSE_TIME_SEC = 5.0;
const DEFUSE_INTERACT_RADIUS_M = 2.8;
const SPIKE_PICKUP_RADIUS_M = 1.8;
const SPIKE_BLAST_RADIUS_M = 15.0;
const ROUND_END_DURATION_SEC = 3.2;
const KILLFEED_MAX_AGE_SEC = 6.5;
const MAX_KILLFEED_ENTRIES = 5;

const BODY_HALF_WIDTH = 0.38;
const BODY_HEIGHT = 1.38;
const HEAD_HALF_WIDTH = 0.22;
const HEAD_HEIGHT = 0.44;
const TARGET_CHEST_HEIGHT = 1.2;
const EYE_HEIGHT_M = 1.6;
const SLIDE_HITBOX_DROP_M = 0.5;
const VULNERABLE_DAMAGE_MULT = 1.25;

const BUY_BANNER_SUBTITLE =
  '[SPACE] FIGHT  •  [B] SHOP  •  [F] PLANT / DEFUSE  •  [G] DROP SPIKE';

interface SpawnDef {
  id: string;
  team: TeamId;
  spawn: Vec3;
  yaw: number;
}

/**
 * Attackers ALWAYS spawn on `spawns.allies` (`+Z` south pads facing `yaw = 0`);
 * Defenders ALWAYS spawn on `spawns.enemies` (`-Z` north pads facing `yaw = Math.PI`).
 * Team IDs (`'ally'` / `'enemy'`) stay constant while North/South sides swap on Halftime.
 */
function buildRosterSpawns(attackerTeam: TeamId): SpawnDef[] {
  const spawns = getArenaSpawns();
  const allyPads = attackerTeam === 'ally' ? spawns.allies : spawns.enemies;
  const allyYaw = attackerTeam === 'ally' ? 0 : Math.PI;
  const enemyPads = attackerTeam === 'enemy' ? spawns.allies : spawns.enemies;
  const enemyYaw = attackerTeam === 'enemy' ? 0 : Math.PI;

  return [
    { id: 'ally-0', team: 'ally', spawn: { ...allyPads[0] }, yaw: allyYaw },
    { id: 'ally-1', team: 'ally', spawn: { ...allyPads[1] }, yaw: allyYaw },
    { id: 'ally-2', team: 'ally', spawn: { ...allyPads[2] }, yaw: allyYaw },
    { id: 'enemy-0', team: 'enemy', spawn: { ...enemyPads[0] }, yaw: enemyYaw },
    { id: 'enemy-1', team: 'enemy', spawn: { ...enemyPads[1] }, yaw: enemyYaw },
    { id: 'enemy-2', team: 'enemy', spawn: { ...enemyPads[2] }, yaw: enemyYaw },
  ];
}

function shuffled<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function draftAllyRoster(preferred: AgentColorId): AgentColorId[] {
  const roster: AgentColorId[] = [preferred];
  const startIdx = AGENT_ORDER.indexOf(preferred);
  const rotated: AgentColorId[] = [];
  for (let i = 1; i < AGENT_ORDER.length; i++) {
    rotated.push(AGENT_ORDER[(startIdx + i) % AGENT_ORDER.length]);
  }
  const usedRoles = new Set<string>([AGENT_PALETTES[preferred].role]);
  for (const id of rotated) {
    if (roster.length >= 3) break;
    if (!usedRoles.has(AGENT_PALETTES[id].role)) {
      roster.push(id);
      usedRoles.add(AGENT_PALETTES[id].role);
    }
  }
  for (const id of rotated) {
    if (roster.length >= 3) break;
    if (!roster.includes(id)) roster.push(id);
  }
  return roster;
}

function draftEnemyRoster(previous: AgentColorId[] | null): AgentColorId[] {
  let pick: AgentColorId[] = shuffled(AGENT_ORDER).slice(0, 3);
  if (previous) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const sameSet = pick.every((id) => previous.includes(id));
      if (!sameSet) break;
      pick = shuffled(AGENT_ORDER).slice(0, 3);
    }
  }
  return pick;
}

function formatCombatantLabel(c: Combatant): string {
  if (c.isPlayer) return 'YOU';
  const prefix = c.team === 'ally' ? 'ALLY' : 'FOE';
  return `${prefix} ${c.colorId.toUpperCase()}`;
}

function hasLineOfSight(
  observer: Combatant,
  target: Combatant,
  colliders: AABB[],
  activeSmokes: SmokeSphere[]
): boolean {
  if (!observer.alive || !target.alive || observer.blindTimer > 0) return false;
  const eye: Vec3 = {
    x: observer.position.x,
    y: observer.position.y + EYE_HEIGHT_M,
    z: observer.position.z,
  };
  const drop = (target.slideTimer ?? 0) > 0 ? SLIDE_HITBOX_DROP_M : 0;
  const chest: Vec3 = {
    x: target.position.x,
    y: target.position.y + TARGET_CHEST_HEIGHT - drop,
    z: target.position.z,
  };
  const dx = chest.x - eye.x;
  const dy = chest.y - eye.y;
  const dz = chest.z - eye.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-4) return true;

  const dir: Vec3 = { x: dx / dist, y: dy / dist, z: dz / dist };
  const wallMax = Math.max(0, dist - 0.05);

  for (const box of colliders) {
    if (raycastAABB(eye, dir, box, wallMax) !== null) return false;
  }
  for (const smoke of activeSmokes) {
    if (raycastSphere(eye, dir, smoke.center, smoke.radius, dist) !== null) return false;
  }
  return true;
}

export function createMatchManager(
  scene: THREE.Scene,
  abilities: AbilitySystem,
  weaponSystem: WeaponSystem,
  sfx: SoundEngine
): MatchManager {
  const botBrain = createBotBrainSystem();
  const economy = createEconomySystem();
  const spikeModel = createSpikeModel(scene);

  const combatants: Combatant[] = [];
  const rigById = new Map<string, CharacterRig>();
  const combatantById = new Map<string, Combatant>();
  const ownedPrimaryById = new Map<string, WeaponId | null>();
  const dotFlashCooldownById = new Map<string, number>();

  // Match, Side & Round State
  let phase: RoundPhase = 'buy';
  let roundNumber = 1;
  let phaseTimerSec = BUY_PHASE_DURATION_SEC;
  let allyScore = 0;
  let enemyScore = 0;
  let playerSide: TacticalSide = 'attacker';
  let halftimeSwapped = false;
  let roundBannerTitle: string | null = 'ROUND 1 — BUY PHASE';
  let roundBannerSubtitle: string | null = BUY_BANNER_SUBTITLE;
  let transientBannerTimer = 0;

  let thirdPersonMode = false;
  let preferredPlayerColor: AgentColorId = 'red';
  let pendingSyncCombatantToPlayer = true;
  let playerStateRef: PlayerState | null = null;
  let lastSyncedPlayerHealth = 100;
  let difficulty: AiDifficulty = 'casual';
  let lastDamageAngleRad: number | null = null;
  let lastDamageSeq = 0;

  // Player S&D Input Latches (fed via syncPlayerFromPhysics)
  let playerInteractHeld = false;
  let playerDropSpikeRequested = false;

  // Spike Lifecycle State
  let spikeStatus: SpikeStatus = 'carried';
  let spikeCarrierId: string | null = null;
  let spikePlantedSite: BombSiteId | null = null;
  let spikePosition: Vec3 = { x: 0, y: 0, z: 0 };
  let spikeTimerSec = POST_PLANT_DURATION_SEC;
  let spikePlantProgress = 0;
  let spikeDefuseProgress = 0;
  let spikeHalfwayCheckpoint = false;
  let spikeBeepAccum = 0;
  let spikePlantTickCooldown = 0;
  let spikeDefuseCuePlayed = false;
  let dropPickupBlockId: string | null = null;
  let dropPickupBlockTimer = 0;

  let nextKillId = 1;
  const killFeed: KillFeedEntry[] = [];

  let allyRoster: AgentColorId[] = draftAllyRoster(preferredPlayerColor);
  let enemyRoster: AgentColorId[] = draftEnemyRoster(null);

  function getAttackerTeam(): TeamId {
    return playerSide === 'attacker' ? 'ally' : 'enemy';
  }

  function getDefenderTeam(): TeamId {
    return playerSide === 'attacker' ? 'enemy' : 'ally';
  }

  // Spawn all 6 combatants + articulated 3D CharacterRigs
  const initialSpawns = buildRosterSpawns(getAttackerTeam());
  let allyIdx = 0;
  let enemyIdx = 0;
  for (const def of initialSpawns) {
    const colorId: AgentColorId =
      def.team === 'ally' ? allyRoster[allyIdx++] : enemyRoster[enemyIdx++];
    const isInitialPlayer = def.team === 'ally' && colorId === preferredPlayerColor;

    const combatant: Combatant = {
      id: def.id,
      basePosition: { ...def.spawn },
      position: { ...def.spawn },
      colorId,
      health: 100,
      maxHealth: 100,
      armor: 0,
      maxArmor: 0,
      credits: 800,
      shieldTier: 'none',
      ultPoints: INITIAL_ULT_POINTS,
      ultActiveTimer: 0,
      alive: true,
      respawnTimer: 0,
      strafeSpeed: 0,
      strafeRange: 0,
      strafePhase: 0,
      slowTimer: 0,
      blindTimer: 0,
      vulnerableTimer: 0,
      concussTimer: 0,
      slideTimer: 0,
      team: def.team,
      isPlayer: isInitialPlayer,
      yaw: def.yaw,
      pitch: 0,
      velocity: { x: 0, y: 0, z: 0 },
      grounded: false,
      weaponId: 'pistol',
    };

    const rig = createCharacterModel(scene, def.team, colorId);
    rig.setWeaponModel('pistol');
    rig.setVisible(!isInitialPlayer || thirdPersonMode);

    combatants.push(combatant);
    combatantById.set(combatant.id, combatant);
    ownedPrimaryById.set(combatant.id, null);
    rigById.set(combatant.id, rig);
  }

  function getPlayerCombatant(): Combatant {
    return combatants.find((c) => c.isPlayer) ?? combatants[0];
  }

  function getPlayerOwnedPrimary(): WeaponId | null {
    return ownedPrimaryById.get(getPlayerCombatant().id) ?? null;
  }

  function getPlayerSide(): TacticalSide {
    return playerSide;
  }

  function assignAgentToCombatant(c: Combatant, colorId: AgentColorId): void {
    if (c.colorId === colorId && rigById.has(c.id)) return;
    rigById.get(c.id)?.dispose(scene);
    c.colorId = colorId;
    const rig = createCharacterModel(scene, c.team, colorId);
    rig.setWeaponModel(c.weaponId);
    rigById.set(c.id, rig);
  }

  function addUltPoint(c: Combatant | null | undefined, amount = 1): void {
    if (!c) return;
    c.ultPoints = Math.min(MAX_ULT_POINTS, (c.ultPoints ?? 0) + amount);
  }

  function resetUltimatesForHalf(): void {
    for (const c of combatants) {
      c.ultPoints = INITIAL_ULT_POINTS;
      c.ultActiveTimer = 0;
    }
  }

  function resetSpikeForRound(): void {
    const attackerTeam = getAttackerTeam();
    const attackerSample = combatants.find((c) => c.team === attackerTeam);
    const spawns = getArenaSpawns();

    // Spawn ONE physical dropped Spike on the Attacker Spawn Spike Pedestal (never pre-equipped!)
    let pedestalPos: Vec3;
    if (!attackerSample || attackerSample.position.z >= 0) {
      pedestalPos = getSpikeSpawnPos();
    } else {
      const northPad = spawns.enemies[1] ?? spawns.enemies[0];
      pedestalPos = { x: northPad.x, y: Math.max(0, northPad.y), z: northPad.z + 2.5 };
    }

    spikeStatus = 'dropped';
    spikeCarrierId = null;
    spikePlantedSite = null;
    spikePosition = {
      x: pedestalPos.x,
      y: Math.max(0, pedestalPos.y),
      z: pedestalPos.z,
    };
    spikeTimerSec = POST_PLANT_DURATION_SEC;
    spikePlantProgress = 0;
    spikeDefuseProgress = 0;
    spikeHalfwayCheckpoint = false;
    spikeBeepAccum = 0;
    spikePlantTickCooldown = 0;
    spikeDefuseCuePlayed = false;
    dropPickupBlockId = null;
    dropPickupBlockTimer = 0;
  }

  function dropSpikeAt(pos: Vec3, blockPickupForId: string | null): void {
    spikeStatus = 'dropped';
    spikeCarrierId = null;
    spikePosition = {
      x: pos.x,
      y: Math.max(0, pos.y),
      z: pos.z,
    };
    spikePlantProgress = 0;
    spikePlantTickCooldown = 0;
    dropPickupBlockId = blockPickupForId;
    dropPickupBlockTimer = blockPickupForId ? 1.25 : 0;
  }

  function buildSpikeHudState(playerCombatant: Combatant): SpikeHudState {
    const canPlantNow: BombSiteId | null =
      phase === 'combat' &&
      spikeStatus === 'carried' &&
      spikeCarrierId === playerCombatant.id &&
      playerCombatant.alive
        ? getBombSiteAt(playerCombatant.position.x, playerCombatant.position.z)
        : null;

    const canDefuseNow =
      phase === 'combat' &&
      spikeStatus === 'planted' &&
      playerCombatant.alive &&
      playerCombatant.team === getDefenderTeam() &&
      Math.hypot(
        playerCombatant.position.x - spikePosition.x,
        playerCombatant.position.z - spikePosition.z
      ) <= DEFUSE_INTERACT_RADIUS_M;

    return {
      status: spikeStatus,
      carrierId: spikeCarrierId,
      playerHasSpike: spikeStatus === 'carried' && spikeCarrierId === playerCombatant.id,
      plantedSite: spikePlantedSite,
      position: { ...spikePosition },
      timerSec: spikeTimerSec,
      plantProgress: spikePlantProgress,
      defuseProgress: spikeDefuseProgress,
      halfwayCheckpoint: spikeHalfwayCheckpoint,
      canPlantNow,
      canDefuseNow,
    };
  }

  // Seed Round 1 Economy (800¤ pistol round), Bot Buy Phase, Spike & AI
  economy.resetForNewMatch(combatants);
  economy.beginBuyPhase(combatants);
  economy.runBotBuyPhase(combatants, getAttackerTeam());
  for (const c of combatants) {
    ownedPrimaryById.set(c.id, c.weaponId !== 'pistol' ? c.weaponId : null);
    rigById.get(c.id)?.setWeaponModel(c.weaponId);
  }
  weaponSystem.equipWeapon(getPlayerCombatant().weaponId);
  resetSpikeForRound();
  botBrain.resetRound(combatants, getAttackerTeam());

  function pushKillFeed(
    killerName: string,
    killerTeam: TeamId,
    killerColor: AgentColorId,
    victim: Combatant,
    weaponTag: string,
    headshot: boolean
  ): void {
    killFeed.unshift({
      id: nextKillId++,
      killerName,
      killerTeam,
      killerColor,
      victimName: formatCombatantLabel(victim),
      victimTeam: victim.team,
      victimColor: victim.colorId,
      weaponTag,
      headshot,
      age: 0,
    });
    if (killFeed.length > MAX_KILLFEED_ENTRIES) {
      killFeed.length = MAX_KILLFEED_ENTRIES;
    }
  }

  function updateRigVisibilities(): void {
    for (const c of combatants) {
      const rig = rigById.get(c.id);
      if (!rig) continue;
      if (c.isPlayer) {
        rig.setVisible(thirdPersonMode || !c.alive);
      } else {
        rig.setVisible(true);
      }
    }
  }

  function applyDamageInternal(
    victim: Combatant,
    amount: number,
    isHeadshot: boolean,
    attacker: Combatant | null,
    weaponTag: string
  ): boolean {
    if (!victim.alive || amount <= 0) return false;

    // 1. Singularity "Fragile": +25% damage amplification BEFORE shield absorption.
    let dmg = amount;
    if ((victim.vulnerableTimer ?? 0) > 0) {
      const scaled = dmg * VULNERABLE_DAMAGE_MULT;
      dmg = dmg >= 2 ? Math.round(scaled) : scaled;
    }

    // 2. Directional damage indicator for the human player.
    if (victim.isPlayer && attacker && attacker.team !== victim.team) {
      lastDamageAngleRad = Math.atan2(
        attacker.position.x - victim.position.x,
        attacker.position.z - victim.position.z
      );
      lastDamageSeq += 1;
    }

    // 3. Shield Absorption: armor absorbs incoming damage before health.
    const absorbed = Math.min(victim.armor ?? 0, dmg);
    victim.armor = Math.max(0, (victim.armor ?? 0) - absorbed);
    victim.health = Math.max(0, victim.health - (dmg - absorbed));

    economy.syncDamageArmor(victim.id, victim.armor);
    if (victim.armor <= 0) {
      victim.maxArmor = 0;
      victim.shieldTier = 'none';
    }

    if (victim.isPlayer && playerStateRef) {
      playerStateRef.health = victim.health;
      playerStateRef.armor = victim.armor;
      playerStateRef.maxArmor = victim.maxArmor;
      lastSyncedPlayerHealth = victim.health;
    }

    const rig = rigById.get(victim.id);
    if (rig) {
      if (dmg >= 1.5 || isHeadshot) {
        rig.triggerHitFlash(isHeadshot);
      } else {
        const cd = dotFlashCooldownById.get(victim.id) ?? 0;
        if (cd <= 0) {
          rig.triggerHitFlash(false);
          dotFlashCooldownById.set(victim.id, 0.25);
        }
      }
    }

    if (victim.health <= 0) {
      victim.alive = false;
      victim.velocity.x = 0;
      victim.velocity.y = 0;
      victim.velocity.z = 0;

      // Drop Spike immediately on carrier death
      if (spikeStatus === 'carried' && spikeCarrierId === victim.id) {
        dropSpikeAt(victim.position, null);
      }

      // Valorant-style Ult Economy: +1 Ult Point to victim on death; +1 & notifyKill to killer
      addUltPoint(victim, 1);

      if (attacker) {
        if (attacker.team !== victim.team) {
          economy.onKill(attacker.id, combatants);
          addUltPoint(attacker, 1);
          abilities.notifyKill(attacker.colorId, attacker.isPlayer);
        }
        pushKillFeed(
          formatCombatantLabel(attacker),
          attacker.team,
          attacker.colorId,
          victim,
          weaponTag,
          isHeadshot
        );
      } else {
        const oppTeam: TeamId = victim.team === 'ally' ? 'enemy' : 'ally';
        pushKillFeed(weaponTag === 'SPIKE' ? 'SPIKE' : 'INFERNO', oppTeam, 'red', victim, weaponTag, false);
      }

      updateRigVisibilities();
      return true;
    }

    return false;
  }

  function getCombatantHitboxes(target: TargetDummy): { head: AABB; body: AABB } {
    const { x, y, z } = target.position;
    const drop = (target.slideTimer ?? 0) > 0 ? SLIDE_HITBOX_DROP_M : 0;
    return {
      body: {
        min: { x: x - BODY_HALF_WIDTH, y, z: z - BODY_HALF_WIDTH },
        max: { x: x + BODY_HALF_WIDTH, y: y + BODY_HEIGHT - drop, z: z + BODY_HALF_WIDTH },
      },
      head: {
        min: { x: x - HEAD_HALF_WIDTH, y: y + BODY_HEIGHT - drop, z: z - HEAD_HALF_WIDTH },
        max: {
          x: x + HEAD_HALF_WIDTH,
          y: y + BODY_HEIGHT + HEAD_HEIGHT - drop,
          z: z + HEAD_HALF_WIDTH,
        },
      },
    };
  }

  function applyStatusToCombatant(
    targetId: string,
    kind: 'slow' | 'blind',
    durationSec: number
  ): void {
    const c = combatantById.get(targetId);
    if (!c || !c.alive || durationSec <= 0) return;
    if (kind === 'slow') {
      c.slowTimer = Math.max(c.slowTimer, durationSec);
    } else {
      c.blindTimer = Math.max(c.blindTimer, durationSec);
    }
  }

  // Keep ally vs enemy team views consistent regardless of North/South side swap
  const enemyTargetsView: TargetsManager = {
    get targets(): TargetDummy[] {
      return combatants.filter((c) => c.team === 'enemy');
    },
    update(): void {},
    getHitboxes: getCombatantHitboxes,
    applyDamage(targetId: string, amount: number, isHeadshot: boolean): boolean {
      const victim = combatantById.get(targetId);
      if (!victim || victim.team !== 'enemy') return false;
      const playerAttacker = getPlayerCombatant();
      const weaponTag = WEAPON_SPECS[weaponSystem.currentWeaponId].shortTag;
      return applyDamageInternal(victim, amount, isHeadshot, playerAttacker, weaponTag);
    },
    applyStatus: applyStatusToCombatant,
  };

  const allTargetsView: TargetsManager = {
    get targets(): TargetDummy[] {
      return combatants;
    },
    update(): void {},
    getHitboxes: getCombatantHitboxes,
    applyDamage(targetId: string, amount: number, isHeadshot: boolean): boolean {
      const victim = combatantById.get(targetId);
      if (!victim) return false;
      return applyDamageInternal(victim, amount, isHeadshot, null, 'INFERNO');
    },
    applyStatus: applyStatusToCombatant,
  };

  function setupRound(nextRoundNum: number, redraftEnemies = true): void {
    roundNumber = nextRoundNum;

    // Trigger Halftime Side Swap after Round 5 (entering Round 6)
    let isHalftimeRound = false;
    if (roundNumber === HALFTIME_AFTER_ROUND + 1 && !halftimeSwapped) {
      halftimeSwapped = true;
      playerSide = playerSide === 'attacker' ? 'defender' : 'attacker';
      economy.resetForHalftime(combatants);
      resetUltimatesForHalf();
      isHalftimeRound = true;
    }

    phase = 'buy';
    phaseTimerSec = BUY_PHASE_DURATION_SEC;
    transientBannerTimer = 0;
    roundBannerTitle = isHalftimeRound
      ? `HALFTIME — SIDE SWAP (${playerSide.toUpperCase()}S)`
      : `ROUND ${roundNumber} — BUY PHASE`;
    roundBannerSubtitle = isHalftimeRound
      ? 'ECONOMY RESET (800¤ PISTOL ROUND)  •  ' + BUY_BANNER_SUBTITLE
      : BUY_BANNER_SUBTITLE;

    abilities.resetRound();
    weaponSystem.resetForRound();
    dotFlashCooldownById.clear();

    if (!allyRoster.includes(preferredPlayerColor)) {
      allyRoster = draftAllyRoster(preferredPlayerColor);
    }
    if (redraftEnemies) {
      enemyRoster = draftEnemyRoster(enemyRoster);
    }

    const attackerTeam = getAttackerTeam();
    const rosterSpawns = buildRosterSpawns(attackerTeam);
    let aI = 0;
    let eI = 0;
    for (let i = 0; i < rosterSpawns.length; i++) {
      const def = rosterSpawns[i];
      const c = combatants[i];
      const colorId: AgentColorId = def.team === 'ally' ? allyRoster[aI++] : enemyRoster[eI++];
      const shouldBePlayer = def.team === 'ally' && colorId === preferredPlayerColor;

      c.isPlayer = shouldBePlayer;
      c.basePosition = { ...def.spawn };
      c.position.x = def.spawn.x;
      c.position.y = def.spawn.y;
      c.position.z = def.spawn.z;
      c.velocity.x = 0;
      c.velocity.y = 0;
      c.velocity.z = 0;
      c.grounded = false;
      c.health = 100;
      c.maxHealth = 100;
      c.alive = true;
      c.respawnTimer = 0;
      c.slowTimer = 0;
      c.blindTimer = 0;
      c.vulnerableTimer = 0;
      c.concussTimer = 0;
      c.slideTimer = 0;
      c.ultActiveTimer = 0;
      c.yaw = def.yaw;
      c.pitch = 0;

      if (c.colorId !== colorId) {
        assignAgentToCombatant(c, colorId);
      }
    }

    // Begin buy phase and execute bot smart buying (eco / half-buy / full-buy / sniper)
    economy.beginBuyPhase(combatants);
    economy.runBotBuyPhase(combatants, attackerTeam);

    for (const c of combatants) {
      ownedPrimaryById.set(c.id, c.weaponId !== 'pistol' ? c.weaponId : null);
      rigById.get(c.id)?.setWeaponModel(c.weaponId);
    }

    const pc = getPlayerCombatant();
    weaponSystem.equipWeapon(pc.weaponId);
    weaponSystem.setAgentColor(pc.colorId);

    lastSyncedPlayerHealth = 100;
    pendingSyncCombatantToPlayer = true;
    if (playerStateRef) {
      playerStateRef.position.x = pc.position.x;
      playerStateRef.position.y = pc.position.y;
      playerStateRef.position.z = pc.position.z;
      playerStateRef.velocity.x = 0;
      playerStateRef.velocity.y = 0;
      playerStateRef.velocity.z = 0;
      playerStateRef.grounded = false;
      playerStateRef.health = 100;
      playerStateRef.maxHealth = 100;
      playerStateRef.armor = pc.armor ?? 0;
      playerStateRef.maxArmor = pc.maxArmor ?? 0;
      playerStateRef.colorId = pc.colorId;
    }

    resetSpikeForRound();
    botBrain.resetRound(combatants, attackerTeam);
    updateRigVisibilities();
  }

  function selectPlayerAgent(colorId: AgentColorId): void {
    preferredPlayerColor = colorId;
    const current = getPlayerCombatant();
    if (current.colorId === colorId) return;

    const target = combatants.find((c) => c.team === 'ally' && c.colorId === colorId);

    if (!target) {
      if (phase !== 'buy') return;
      const slot = allyRoster.indexOf(current.colorId);
      if (slot >= 0) allyRoster[slot] = colorId;
      else allyRoster = draftAllyRoster(colorId);

      assignAgentToCombatant(current, colorId);
      rigById.get(current.id)?.setWeaponModel(current.weaponId);
      current.vulnerableTimer = 0;
      current.concussTimer = 0;
      current.slideTimer = 0;
      if (playerStateRef) playerStateRef.colorId = colorId;
      updateRigVisibilities();
      return;
    }

    if (phase === 'buy') {
      // Swap agent identities in-place so the player preserves their credits, weapon, armor & Spike!
      const prevColor = current.colorId;
      const curIdx = allyRoster.indexOf(prevColor);
      const tgtIdx = allyRoster.indexOf(colorId);
      if (curIdx >= 0 && tgtIdx >= 0) {
        allyRoster[curIdx] = colorId;
        allyRoster[tgtIdx] = prevColor;
      }

      assignAgentToCombatant(current, colorId);
      assignAgentToCombatant(target, prevColor);
      rigById.get(current.id)?.setWeaponModel(current.weaponId);
      rigById.get(target.id)?.setWeaponModel(target.weaponId);
      if (playerStateRef) playerStateRef.colorId = colorId;
      updateRigVisibilities();
    } else if (target.alive) {
      // Mid-combat swap onto a living ally transfers human control cleanly
      current.isPlayer = false;
      target.isPlayer = true;
      weaponSystem.equipWeapon(target.weaponId);
      weaponSystem.setAgentColor(target.colorId);
      lastSyncedPlayerHealth = target.health;
      pendingSyncCombatantToPlayer = true;
      updateRigVisibilities();
    }
  }

  function buyWeapon(weaponId: WeaponId): boolean {
    if (phase !== 'buy') {
      sfx.playBuyError();
      return false;
    }
    const pc = getPlayerCombatant();

    // Switching back to an already-owned primary in-hand (e.g. after pressing [1] for pistol)
    if (weaponId !== 'pistol' && ownedPrimaryById.get(pc.id) === weaponId) {
      if (pc.weaponId === weaponId) {
        sfx.playBuyError();
        return false;
      }
      pc.weaponId = weaponId;
      weaponSystem.equipWeapon(weaponId);
      rigById.get(pc.id)?.setWeaponModel(weaponId);
      sfx.playBuyPurchase();
      return true;
    }

    // Clicking [1] Sidearm refunds only if bought from pistol this round;
    // otherwise it equips Sidearm in-hand while preserving any carried-over primary.
    if (weaponId === 'pistol') {
      const econState = economy.getCombatantState(pc.id);
      if (!(econState.boughtWeaponThisRound && econState.preBuyWeapon === 'pistol')) {
        if (pc.weaponId === 'pistol') {
          sfx.playBuyError();
          return false;
        }
        pc.weaponId = 'pistol';
        weaponSystem.equipWeapon('pistol');
        rigById.get(pc.id)?.setWeaponModel('pistol');
        sfx.playBuyPurchase();
        return true;
      }
    }

    const res = economy.buyWeapon(pc.id, weaponId, combatants);
    if (!res.ok) {
      sfx.playBuyError();
      return false;
    }
    pc.weaponId = res.weaponId;
    ownedPrimaryById.set(pc.id, res.weaponId !== 'pistol' ? res.weaponId : null);
    weaponSystem.equipWeapon(res.weaponId);
    rigById.get(pc.id)?.setWeaponModel(res.weaponId);
    sfx.playBuyPurchase();
    return true;
  }

  function refundCurrentRoundWeapon(): boolean {
    if (phase !== 'buy') {
      sfx.playBuyError();
      return false;
    }
    const pc = getPlayerCombatant();
    const res = economy.refundPlayerWeapon(pc.id, combatants);
    if (!res.ok) {
      sfx.playBuyError();
      return false;
    }
    pc.weaponId = res.weaponId;
    ownedPrimaryById.set(pc.id, res.weaponId !== 'pistol' ? res.weaponId : null);
    weaponSystem.equipWeapon(res.weaponId);
    rigById.get(pc.id)?.setWeaponModel(res.weaponId);
    sfx.playBuyPurchase();
    return true;
  }

  function buyShield(tier: ShieldTier): boolean {
    if (phase !== 'buy') {
      sfx.playBuyError();
      return false;
    }
    const pc = getPlayerCombatant();
    const res = economy.buyShield(pc.id, tier, combatants);
    if (!res.ok) {
      sfx.playBuyError();
      return false;
    }
    if (playerStateRef) {
      playerStateRef.armor = res.armor;
      playerStateRef.maxArmor = res.maxArmor;
    }
    sfx.playBuyPurchase();
    return true;
  }

  function swapSides(): void {
    playerSide = playerSide === 'attacker' ? 'defender' : 'attacker';
    halftimeSwapped = !halftimeSwapped;
    setupRound(roundNumber, false);
    sfx.playRoundCue('buy');
  }

  function setDifficulty(diff: AiDifficulty): void {
    difficulty = diff;
    botBrain.setDifficulty(diff);
  }

  function getDifficulty(): AiDifficulty {
    return difficulty;
  }

  function tryTakeoverAlly(): AgentColorId | null {
    const current = getPlayerCombatant();
    if (current.alive) return null;

    const livingAlly = combatants.find((c) => c.team === 'ally' && !c.isPlayer && c.alive);
    if (!livingAlly) return null;

    current.isPlayer = false;
    livingAlly.isPlayer = true;
    preferredPlayerColor = livingAlly.colorId;

    weaponSystem.equipWeapon(livingAlly.weaponId);
    weaponSystem.setAgentColor(livingAlly.colorId);
    lastSyncedPlayerHealth = livingAlly.health;
    pendingSyncCombatantToPlayer = true;

    if (playerStateRef) {
      playerStateRef.position.x = livingAlly.position.x;
      playerStateRef.position.y = livingAlly.position.y;
      playerStateRef.position.z = livingAlly.position.z;
      playerStateRef.velocity.x = livingAlly.velocity.x;
      playerStateRef.velocity.y = livingAlly.velocity.y;
      playerStateRef.velocity.z = livingAlly.velocity.z;
      playerStateRef.grounded = livingAlly.grounded;
      playerStateRef.health = livingAlly.health;
      playerStateRef.armor = livingAlly.armor ?? 0;
      playerStateRef.maxArmor = livingAlly.maxArmor ?? 0;
      playerStateRef.colorId = livingAlly.colorId;
    }

    updateRigVisibilities();
    return livingAlly.colorId;
  }

  function skipBuyPhase(): void {
    if (phase !== 'buy') return;
    phase = 'combat';
    phaseTimerSec = COMBAT_PHASE_DURATION_SEC;
    roundBannerTitle = 'FIGHT!';
    roundBannerSubtitle =
      playerSide === 'attacker'
        ? 'PLANT THE SPIKE AT SITE A OR B'
        : 'DEFEND SITES A & B';
    transientBannerTimer = 1.6;
    sfx.playBarrierDrop();
    sfx.playRoundCue('fight');
  }

  function tryCastPlayerUltimate(player: PlayerState, input: InputState): boolean {
    const pc = getPlayerCombatant();
    if (phase !== 'combat' || !pc.alive || (pc.ultPoints ?? 0) < MAX_ULT_POINTS) {
      return false;
    }
    const castOk = abilities.cast('x', player, input);
    if (!castOk) return false;
    pc.ultPoints = 0;
    pc.ultActiveTimer = PLAYER_ULT_ACTIVE_SEC;
    sfx.playUltimateActivate(pc.colorId);
    return true;
  }

  function restartMatch(): void {
    allyScore = 0;
    enemyScore = 0;
    playerSide = 'attacker';
    halftimeSwapped = false;
    killFeed.length = 0;
    ownedPrimaryById.clear();
    economy.resetForNewMatch(combatants);
    resetUltimatesForHalf();
    setupRound(1);
    sfx.playRoundCue('buy');
  }

  function onMapRebuilt(): void {
    setupRound(roundNumber, false);
  }

  function setThirdPersonMode(thirdPerson: boolean): void {
    thirdPersonMode = thirdPerson;
    updateRigVisibilities();
  }

  function syncPlayerFromPhysics(
    player: PlayerState,
    yaw: number,
    pitch: number,
    weaponId: WeaponId,
    firedThisFrame: boolean,
    interactHeld = false,
    dropSpikePressed = false
  ): void {
    playerStateRef = player;
    playerInteractHeld = interactHeld;
    if (dropSpikePressed) {
      playerDropSpikeRequested = true;
    }

    const pc = getPlayerCombatant();

    if (pendingSyncCombatantToPlayer) {
      player.position.x = pc.position.x;
      player.position.y = pc.position.y;
      player.position.z = pc.position.z;
      player.velocity.x = pc.velocity.x;
      player.velocity.y = pc.velocity.y;
      player.velocity.z = pc.velocity.z;
      player.grounded = pc.grounded;
      player.health = pc.health;
      player.maxHealth = pc.maxHealth;
      player.armor = pc.armor ?? 0;
      player.maxArmor = pc.maxArmor ?? 0;
      player.colorId = pc.colorId;
      lastSyncedPlayerHealth = pc.health;
      pendingSyncCombatantToPlayer = false;
      return;
    }

    // Reconcile health deltas cleanly between AbilitySystem heals/burns and combat damage
    const playerDelta = player.health - lastSyncedPlayerHealth;
    const combatantDelta = pc.health - lastSyncedPlayerHealth;
    let mergedHealth = lastSyncedPlayerHealth;

    if (Math.abs(playerDelta) > 1e-6 || Math.abs(combatantDelta) > 1e-6) {
      mergedHealth = Math.max(
        0,
        Math.min(pc.maxHealth, lastSyncedPlayerHealth + playerDelta + combatantDelta)
      );
    }

    pc.health = mergedHealth;
    player.health = mergedHealth;
    player.armor = pc.armor ?? 0;
    player.maxArmor = pc.maxArmor ?? 0;
    lastSyncedPlayerHealth = mergedHealth;

    if (pc.health <= 0 && pc.alive) {
      pc.alive = false;
      addUltPoint(pc, 1);
      if (spikeStatus === 'carried' && spikeCarrierId === pc.id) {
        dropSpikeAt(pc.position, null);
      }
      updateRigVisibilities();
    }

    if (!pc.alive) return;

    pc.position.x = player.position.x;
    pc.position.y = player.position.y;
    pc.position.z = player.position.z;
    pc.velocity.x = player.velocity.x;
    pc.velocity.y = player.velocity.y;
    pc.velocity.z = player.velocity.z;
    pc.grounded = player.grounded;
    pc.yaw = yaw;
    pc.pitch = pitch;

    if (pc.weaponId !== weaponId) {
      pc.weaponId = weaponId;
      rigById.get(pc.id)?.setWeaponModel(weaponId);
    }

    if (firedThisFrame) {
      rigById.get(pc.id)?.triggerFireKick();
    }
  }

  function transitionToRoundEnd(winner: TeamId, subtitle: string, spikeDefused = false): void {
    if (phase !== 'combat') return;

    phase = 'round_end';
    phaseTimerSec = ROUND_END_DURATION_SEC;
    transientBannerTimer = 0;

    // Surviving while holding backup Sidearm still preserves purchased SMG/AR/Sniper into next round.
    for (const c of combatants) {
      if (!c.alive) continue;
      const primary = ownedPrimaryById.get(c.id);
      if (primary && c.weaponId === 'pistol') {
        c.weaponId = primary;
      }
    }

    economy.onRoundEnd(winner, combatants, spikeDefused);

    if (winner === 'ally') {
      allyScore += 1;
      roundBannerTitle = allyScore >= WINS_TO_WIN_MATCH ? 'MATCH POINT WON' : 'ROUND WON';
      roundBannerSubtitle = subtitle;
      sfx.playRoundCue('win');
    } else {
      enemyScore += 1;
      roundBannerTitle = enemyScore >= WINS_TO_WIN_MATCH ? 'MATCH POINT LOST' : 'ROUND LOST';
      roundBannerSubtitle = subtitle;
      sfx.playRoundCue('lose');
    }
  }

  function tickSpikePlant(planter: Combatant, dt: number): boolean {
    if (
      phase !== 'combat' ||
      spikeStatus !== 'carried' ||
      spikeCarrierId !== planter.id ||
      !planter.alive
    ) {
      return false;
    }

    const site = getBombSiteAt(planter.position.x, planter.position.z);
    if (!site) return false;

    spikePlantProgress = Math.min(1, spikePlantProgress + dt / PLANT_TIME_SEC);
    spikePlantTickCooldown -= dt;
    if (spikePlantTickCooldown <= 0) {
      sfx.playSpikePlantTick();
      spikePlantTickCooldown = 0.48;
    }

    if (spikePlantProgress >= 1) {
      spikeStatus = 'planted';
      spikeCarrierId = null;
      spikePlantedSite = site;
      spikePosition = {
        x: planter.position.x,
        y: Math.max(0, planter.position.y),
        z: planter.position.z,
      };
      spikeTimerSec = POST_PLANT_DURATION_SEC;
      phaseTimerSec = POST_PLANT_DURATION_SEC;
      spikePlantProgress = 1;
      spikeDefuseProgress = 0;
      spikeHalfwayCheckpoint = false;
      spikeBeepAccum = 0;
      spikeDefuseCuePlayed = false;

      economy.onPlant(getAttackerTeam(), combatants);
      addUltPoint(planter, 1);
      sfx.playSpikePlanted();
      roundBannerTitle = `SPIKE PLANTED — SITE ${site}`;
      roundBannerSubtitle = '45 SECONDS UNTIL DETONATION';
      transientBannerTimer = 2.6;
    }

    return true;
  }

  function tickSpikeDefuse(defuser: Combatant, dt: number): boolean {
    if (
      phase !== 'combat' ||
      spikeStatus !== 'planted' ||
      !defuser.alive ||
      defuser.team !== getDefenderTeam()
    ) {
      return false;
    }

    const dist = Math.hypot(
      defuser.position.x - spikePosition.x,
      defuser.position.z - spikePosition.z
    );
    if (dist > DEFUSE_INTERACT_RADIUS_M) return false;

    if (!spikeDefuseCuePlayed) {
      sfx.playSpikeDefuseCue(spikeHalfwayCheckpoint);
      spikeDefuseCuePlayed = true;
    }

    spikeDefuseProgress = Math.min(1, spikeDefuseProgress + dt / DEFUSE_TIME_SEC);

    // Permanent 50% halfway checkpoint
    if (!spikeHalfwayCheckpoint && spikeDefuseProgress >= 0.5) {
      spikeHalfwayCheckpoint = true;
      sfx.playSpikeDefuseCue(true);
    }

    if (spikeDefuseProgress >= 1) {
      spikeStatus = 'defused';
      spikeDefuseProgress = 1;
      addUltPoint(defuser, 1);
      sfx.playSpikeDefused();
      transitionToRoundEnd(getDefenderTeam(), 'SPIKE DEFUSED', true);
    }

    return true;
  }

  function triggerSpikeDetonation(): void {
    spikeStatus = 'detonated';
    spikeTimerSec = 0;
    sfx.playSpikeDetonate();

    // Lethal Radianite blast damage inside 15m radius
    for (const c of combatants) {
      if (!c.alive) continue;
      const dist = Math.hypot(
        c.position.x - spikePosition.x,
        c.position.y - spikePosition.y,
        c.position.z - spikePosition.z
      );
      if (dist <= SPIKE_BLAST_RADIUS_M) {
        const blastDmg = Math.max(150, Math.round(280 * (1 - dist / (SPIKE_BLAST_RADIUS_M + 2))));
        applyDamageInternal(c, blastDmg, false, null, 'SPIKE');
      }
    }

    transitionToRoundEnd(getAttackerTeam(), 'SPIKE DETONATED', false);
  }

  function handleDropAndPickup(dt: number, playerCombatant: Combatant): void {
    if (dropPickupBlockTimer > 0) {
      dropPickupBlockTimer = Math.max(0, dropPickupBlockTimer - dt);
      if (dropPickupBlockTimer <= 0) {
        dropPickupBlockId = null;
      }
    }

    // Handle player [G] drop request
    if (playerDropSpikeRequested) {
      playerDropSpikeRequested = false;
      if (
        (phase === 'combat' || phase === 'buy') &&
        spikeStatus === 'carried' &&
        spikeCarrierId === playerCombatant.id &&
        playerCombatant.alive
      ) {
        dropSpikeAt(
          {
            x: playerCombatant.position.x - Math.sin(playerCombatant.yaw) * 0.9,
            y: Math.max(0, playerCombatant.position.y),
            z: playerCombatant.position.z - Math.cos(playerCombatant.yaw) * 0.9,
          },
          playerCombatant.id
        );
      }
    }

    // Track carrier position
    if (spikeStatus === 'carried' && spikeCarrierId) {
      const carrier = combatantById.get(spikeCarrierId);
      if (carrier && carrier.alive) {
        spikePosition.x = carrier.position.x;
        spikePosition.y = carrier.position.y;
        spikePosition.z = carrier.position.z;
      } else if (carrier) {
        dropSpikeAt(carrier.position, null);
      }
    }

    // Living Attacker within 1.8m auto-picks up dropped Spike during BOTH 'buy' AND 'combat'
    if (spikeStatus === 'dropped' && (phase === 'buy' || phase === 'combat')) {
      const attackerTeam = getAttackerTeam();
      for (const c of combatants) {
        if (c.team !== attackerTeam || !c.alive) continue;
        if (c.id === dropPickupBlockId && dropPickupBlockTimer > 0) continue;
        const dist = Math.hypot(c.position.x - spikePosition.x, c.position.z - spikePosition.z);
        if (dist <= SPIKE_PICKUP_RADIUS_M) {
          spikeStatus = 'carried';
          spikeCarrierId = c.id;
          spikePosition.x = c.position.x;
          spikePosition.y = c.position.y;
          spikePosition.z = c.position.z;
          sfx.playSpikePickup();
          break;
        }
      }
    }
  }

  function computeMinimapEnemies(
    activeSmokes: SmokeSphere[],
    ultRevealAll = false
  ): MinimapContact[] {
    if (ultRevealAll) {
      const contacts: MinimapContact[] = [];
      for (const enemy of combatants) {
        if (enemy.team !== 'enemy' || !enemy.alive) continue;
        contacts.push({
          x: enemy.position.x,
          z: enemy.position.z,
          colorId: enemy.colorId,
        });
      }
      return contacts;
    }

    const allies = combatants.filter((c) => c.team === 'ally' && c.alive && c.blindTimer <= 0);
    if (allies.length === 0) return [];

    const contacts: MinimapContact[] = [];
    for (const enemy of combatants) {
      if (enemy.team !== 'enemy' || !enemy.alive) continue;
      let spotted = false;
      for (const ally of allies) {
        if (hasLineOfSight(ally, enemy, ARENA_COLLIDERS, activeSmokes)) {
          spotted = true;
          break;
        }
      }
      if (spotted) {
        contacts.push({
          x: enemy.position.x,
          z: enemy.position.z,
          colorId: enemy.colorId,
        });
      }
    }
    return contacts;
  }

  function update(
    dt: number,
    player: PlayerState,
    cameraPos: Vec3,
    activeSmokes: SmokeSphere[],
    ultRevealAll = false
  ): MatchHudState {
    playerStateRef = player;
    const playerCombatant = getPlayerCombatant();

    // 1. Age out kill feed & decay status / ultimate timers
    for (let i = killFeed.length - 1; i >= 0; i--) {
      killFeed[i].age += dt;
      if (killFeed[i].age >= KILLFEED_MAX_AGE_SEC) {
        killFeed.splice(i, 1);
      }
    }

    for (const c of combatants) {
      c.slowTimer = Math.max(0, c.slowTimer - dt);
      c.blindTimer = Math.max(0, c.blindTimer - dt);
      c.vulnerableTimer = Math.max(0, (c.vulnerableTimer ?? 0) - dt);
      c.concussTimer = Math.max(0, (c.concussTimer ?? 0) - dt);
      c.slideTimer = Math.max(0, (c.slideTimer ?? 0) - dt);
      c.ultActiveTimer = Math.max(0, (c.ultActiveTimer ?? 0) - dt);
      const flashCd = dotFlashCooldownById.get(c.id) ?? 0;
      if (flashCd > 0) {
        dotFlashCooldownById.set(c.id, Math.max(0, flashCd - dt));
      }
    }

    if (transientBannerTimer > 0) {
      transientBannerTimer -= dt;
      if (transientBannerTimer <= 0 && phase === 'combat') {
        roundBannerTitle = null;
        roundBannerSubtitle = null;
      }
    }

    handleDropAndPickup(dt, playerCombatant);

    const attackerTeam = getAttackerTeam();
    const defenderTeam = getDefenderTeam();
    const sites = getBombSites();
    let channelingCombatantId: string | null = null;

    // 2. Step Round State Machine
    if (phase === 'buy') {
      phaseTimerSec = Math.max(0, phaseTimerSec - dt);

      const buySdContext: BotSdContext = {
        attackerTeam,
        spike: buildSpikeHudState(playerCombatant),
        sites,
        buyTimeRemainingSec: phaseTimerSec,
      };

      botBrain.update(
        dt,
        combatants,
        ARENA_COLLIDERS,
        activeSmokes,
        cameraPos,
        false,
        abilities,
        weaponSystem,
        sfx,
        () => {},
        () => {},
        buySdContext
      );

      // Re-check proximity pickup immediately after Buy-Phase bot movement
      handleDropAndPickup(0, playerCombatant);

      if (phaseTimerSec <= 0) {
        skipBuyPhase();
      }
    } else if (phase === 'combat') {
      if (spikeStatus === 'planted') {
        spikeTimerSec = Math.max(0, spikeTimerSec - dt);
        phaseTimerSec = spikeTimerSec;

        // Accelerating timer beep (`max(0.12, min(1.0, timerSec / 45))`)
        const beepInterval = Math.max(
          0.12,
          Math.min(1.0, spikeTimerSec / POST_PLANT_DURATION_SEC)
        );
        spikeBeepAccum += dt;
        if (spikeBeepAccum >= beepInterval) {
          spikeBeepAccum = 0;
          const urgency01 = Math.max(0, Math.min(1, 1 - spikeTimerSec / POST_PLANT_DURATION_SEC));
          sfx.playSpikeBeep(urgency01);
        }
      } else {
        phaseTimerSec = Math.max(0, phaseTimerSec - dt);
      }

      let plantedThisFrame = false;
      let defusedThisFrame = false;

      // Player [F] Plant / Defuse channel
      if (playerInteractHeld && playerCombatant.alive) {
        if (spikeStatus === 'carried' && spikeCarrierId === playerCombatant.id) {
          plantedThisFrame = tickSpikePlant(playerCombatant, dt);
          if (plantedThisFrame) channelingCombatantId = playerCombatant.id;
        } else if (spikeStatus === 'planted' && playerCombatant.team === defenderTeam) {
          defusedThisFrame = tickSpikeDefuse(playerCombatant, dt);
          if (defusedThisFrame) channelingCombatantId = playerCombatant.id;
        }
      }

      const sdContext: BotSdContext = {
        attackerTeam,
        spike: buildSpikeHudState(playerCombatant),
        sites,
        onBotPlantTick: (bot, stepDt) => {
          if (tickSpikePlant(bot, stepDt)) {
            plantedThisFrame = true;
            channelingCombatantId = bot.id;
          }
        },
        onBotDefuseTick: (bot, stepDt) => {
          if (tickSpikeDefuse(bot, stepDt)) {
            defusedThisFrame = true;
            channelingCombatantId = bot.id;
          }
        },
      };

      // Step Tactical 2-Site S&D Bot AI
      if (phase === 'combat') {
        botBrain.update(
          dt,
          combatants,
          ARENA_COLLIDERS,
          activeSmokes,
          cameraPos,
          true,
          abilities,
          weaponSystem,
          sfx,
          (attacker, victim, damage, isHeadshot, weaponTag) => {
            applyDamageInternal(victim, damage, isHeadshot, attacker, weaponTag);
            if (victim.isPlayer) {
              if (isHeadshot) sfx.playHeadshot();
              else sfx.playBodyHit();
            }
          },
          (bot) => {
            rigById.get(bot.id)?.triggerFireKick();
          },
          sdContext
        );
      }

      // Reset unheld channel progress (defuse preserves permanent 50% halfway checkpoint!)
      if (spikeStatus === 'carried' && !plantedThisFrame) {
        spikePlantProgress = 0;
        spikePlantTickCooldown = 0;
      }
      if (spikeStatus === 'planted' && !defusedThisFrame) {
        spikeDefuseProgress = spikeHalfwayCheckpoint ? 0.5 : 0;
        spikeDefuseCuePlayed = false;
      }

      // Evaluate S&D Round Termination Conditions
      if (phase === 'combat') {
        if (spikeStatus === 'planted' && spikeTimerSec <= 0) {
          triggerSpikeDetonation();
        } else {
          const aliveAttackers = combatants.filter(
            (c) => c.team === attackerTeam && c.alive
          ).length;
          const aliveDefenders = combatants.filter(
            (c) => c.team === defenderTeam && c.alive
          ).length;

          if (aliveDefenders === 0) {
            transitionToRoundEnd(attackerTeam, 'DEFENDERS ELIMINATED', false);
          } else if (aliveAttackers === 0 && spikeStatus !== 'planted') {
            // Never end early on post-plant when all attackers fall: Defenders must defuse!
            transitionToRoundEnd(defenderTeam, 'ATTACKERS ELIMINATED', false);
          } else if (phaseTimerSec <= 0 && spikeStatus !== 'planted') {
            transitionToRoundEnd(defenderTeam, 'TIME EXPIRED — DEFENDERS HELD', false);
          }
        }
      }
    } else if (phase === 'round_end') {
      phaseTimerSec = Math.max(0, phaseTimerSec - dt);
      if (phaseTimerSec <= 0) {
        if (allyScore >= WINS_TO_WIN_MATCH || enemyScore >= WINS_TO_WIN_MATCH) {
          phase = 'match_over';
          phaseTimerSec = 0;
          roundBannerTitle = allyScore >= WINS_TO_WIN_MATCH ? 'VICTORY' : 'DEFEAT';
          roundBannerSubtitle = 'PRESS [ENTER] FOR NEW MATCH';
        } else {
          setupRound(roundNumber + 1);
          sfx.playRoundCue('buy');
        }
      }
    }

    // 3. Update 3D Spike Model & Articulated 3D Character Rigs
    const spikeHud = buildSpikeHudState(playerCombatant);
    spikeModel.update(dt, spikeHud);

    const hasLivingAllyBot = combatants.some(
      (c) => c.team === 'ally' && !c.isPlayer && c.alive
    );
    const canTakeoverBot = phase === 'combat' && !playerCombatant.alive && hasLivingAllyBot;

    let bannerTitle = roundBannerTitle;
    let bannerSubtitle = roundBannerSubtitle;
    if (canTakeoverBot) {
      bannerTitle = 'ELIMINATED';
      bannerSubtitle = '[TAB] TAKE OVER LIVING ALLY';
    }

    for (const c of combatants) {
      const rig = rigById.get(c.id);
      if (!rig) continue;

      let occludedBySmoke = false;
      if (!c.isPlayer && c.alive && activeSmokes.length > 0) {
        const dx = c.position.x - cameraPos.x;
        const dy = c.position.y + TARGET_CHEST_HEIGHT - cameraPos.y;
        const dz = c.position.z - cameraPos.z;
        const distToTarget = Math.hypot(dx, dy, dz);
        if (distToTarget > 1e-6) {
          const invDist = 1 / distToTarget;
          const dir: Vec3 = { x: dx * invDist, y: dy * invDist, z: dz * invDist };
          for (const smoke of activeSmokes) {
            if (raycastSphere(cameraPos, dir, smoke.center, smoke.radius, distToTarget) !== null) {
              occludedBySmoke = true;
              break;
            }
          }
        }
      }

      rig.update(
        dt,
        {
          position: c.position,
          velocity: c.velocity,
          yaw: c.yaw,
          pitch: c.pitch,
          health: c.health,
          maxHealth: c.maxHealth,
          alive: c.alive,
          slowTimer: c.slowTimer,
          blindTimer: c.blindTimer,
          occludedBySmoke,
          slideTimer: c.slideTimer,
          concussTimer: c.concussTimer,
          hasSpike: spikeStatus === 'carried' && spikeCarrierId === c.id,
          channelingSpike: channelingCombatantId === c.id,
          ultActive: (c.ultActiveTimer ?? 0) > 0,
        },
        cameraPos
      );
    }

    // Mirror player's health & armor cleanly back to PlayerState
    player.health = playerCombatant.health;
    player.armor = playerCombatant.armor ?? 0;
    player.maxArmor = playerCombatant.maxArmor ?? 0;
    lastSyncedPlayerHealth = playerCombatant.health;

    // 4. Project Full Read-Only MatchHudState (including Economy, Spike, Ult & Minimap Contacts)
    const allyStates = combatants
      .filter((c) => c.team === 'ally')
      .map((c) => ({
        colorId: c.colorId,
        alive: c.alive,
        isPlayer: c.isPlayer,
        hp: Math.ceil(c.health),
      }));

    const enemyStates = combatants
      .filter((c) => c.team === 'enemy')
      .map((c) => ({
        colorId: c.colorId,
        alive: c.alive,
        hp: Math.ceil(c.health),
      }));

    const playerEcon = economy.getCombatantState(playerCombatant.id);
    const allyEconomy = combatants
      .filter((c) => c.team === 'ally')
      .map((c) => {
        const st = economy.getCombatantState(c.id);
        return {
          id: c.id,
          colorId: c.colorId,
          credits: st.credits,
          weaponId: c.weaponId,
          armor: Math.ceil(c.armor ?? 0),
          hasSpike: spikeStatus === 'carried' && spikeCarrierId === c.id,
        };
      });

    const minimapEnemies = computeMinimapEnemies(activeSmokes, ultRevealAll);

    return {
      phase,
      roundNumber,
      phaseTimerSec,
      allyScore,
      enemyScore,
      allyStates,
      enemyStates,
      bannerTitle,
      bannerSubtitle,
      canTakeoverBot,
      killFeed: killFeed.map((entry) => ({ ...entry })),
      lastDamageAngleRad,
      lastDamageSeq,
      difficulty,
      playerSide,
      halftimeSwapped,
      credits: playerEcon.credits,
      nextRoundMinCredits: economy.getMinNextRoundCredits('ally', playerEcon.credits),
      lossStreak: economy.getLossStreak('ally'),
      armor: Math.ceil(playerCombatant.armor ?? 0),
      maxArmor: playerCombatant.maxArmor ?? 0,
      shieldTier: playerCombatant.shieldTier ?? 'none',
      canRefundWeapon:
        phase === 'buy' && playerEcon.boughtWeaponThisRound && playerEcon.boughtWeaponCost > 0,
      refundableWeaponCost:
        phase === 'buy' && playerEcon.boughtWeaponThisRound ? playerEcon.boughtWeaponCost : 0,
      allyEconomy,
      spike: spikeHud,
      minimapEnemies,
      ultPoints: playerCombatant.ultPoints ?? 0,
      maxUltPoints: MAX_ULT_POINTS,
    };
  }

  return {
    combatants,
    enemyTargetsView,
    allTargetsView,
    getPlayerCombatant,
    getPlayerOwnedPrimary,
    getPlayerSide,
    selectPlayerAgent,
    setDifficulty,
    getDifficulty,
    tryTakeoverAlly,
    skipBuyPhase,
    restartMatch,
    onMapRebuilt,
    setThirdPersonMode,
    buyWeapon,
    refundCurrentRoundWeapon,
    buyShield,
    swapSides,
    tryCastPlayerUltimate,
    syncPlayerFromPhysics,
    update,
  };
}
