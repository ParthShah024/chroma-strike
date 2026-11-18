import * as THREE from 'three';
import {
  AABB,
  AgentColorId,
  Combatant,
  KillFeedEntry,
  MatchHudState,
  PlayerState,
  RoundPhase,
  SmokeSphere,
  TargetDummy,
  TeamId,
  Vec3,
  WeaponId,
} from '../core/types';
import { ARENA_COLLIDERS, getArenaSpawns } from '../arena/map';
import { raycastSphere } from '../physics/movement';
import { WEAPON_SPECS } from '../combat/arsenal';
import { CharacterRig, createCharacterModel } from '../entities/characterModel';
import { AbilitySystem } from '../abilities/system';
import { WeaponSystem } from '../combat/weapons';
import { SoundEngine } from '../audio/sfx';
import { TargetsManager } from '../combat/targets';
import { createBotBrainSystem } from '../ai/botBrain';

/**
 * ============================================================================
 * 3v3 Tactical Round State Machine & Combatant Orchestrator
 * ============================================================================
 *
 * Round State Machine (`buy -> combat -> round_end -> match_over`):
 *   1. `'buy'` (`3.5s`):
 *      - All 6 combatants spawn at opposing ends (`+Z` Allies vs `-Z` Enemies).
 *      - Bots stand ready with round-scaled loadouts (R1 Pistol, R2 SMG, R3+ AR/Sniper).
 *      - Human player can swap weapons `[1-4]`, pick agent `[F1-F3]`, or press
 *        `[Space]` to skip straight into `'combat'` (`sfx.playRoundCue('fight')`).
 *   2. `'combat'` (`60.0s`):
 *      - Bot AI runs full FSM + Multi-Gate Perception + ability usage.
 *      - Round ends immediately when all 3 enemies die (`allyScore++`) or all 3
 *        allies die (`enemyScore++`), or on timeout (`enemyScore++` Defenders hold).
 *      - If the human player falls while >= 1 ally bot survives, `canTakeoverBot`
 *        enables `[Tab]` bot takeover so the player stays in the action!
 *   3. `'round_end'` (`3.0s`):
 *      - Celebrates round winner, then either enters `'match_over'` at 5 wins
 *        (`First to 5`) or calls `abilities.resetRound()` + `weaponSystem.resetForRound()`
 *        and starts the next `'buy'` phase.
 *   4. `'match_over'`:
 *      - Awaits `[Enter]` -> `restartMatch()` to reset scores and start Round 1.
 */

export interface MatchManager {
  combatants: Combatant[];
  enemyTargetsView: TargetsManager;
  allTargetsView: TargetsManager;
  getPlayerCombatant(): Combatant;
  selectPlayerAgent(colorId: AgentColorId): void;
  tryTakeoverAlly(): AgentColorId | null;
  skipBuyPhase(): void;
  restartMatch(): void;
  onMapRebuilt(): void;
  setThirdPersonMode(thirdPerson: boolean): void;
  syncPlayerFromPhysics(
    player: PlayerState,
    yaw: number,
    pitch: number,
    weaponId: WeaponId,
    firedThisFrame: boolean
  ): void;
  update(
    dt: number,
    player: PlayerState,
    cameraPos: Vec3,
    activeSmokes: SmokeSphere[]
  ): MatchHudState;
}

const WINS_TO_WIN_MATCH = 5;
const BUY_PHASE_DURATION_SEC = 3.5;
const COMBAT_PHASE_DURATION_SEC = 60.0;
const ROUND_END_DURATION_SEC = 3.0;
const KILLFEED_MAX_AGE_SEC = 6.5;
const MAX_KILLFEED_ENTRIES = 5;

const BODY_HALF_WIDTH = 0.38;
const BODY_HEIGHT = 1.38;
const HEAD_HALF_WIDTH = 0.22;
const HEAD_HEIGHT = 0.44;
const TARGET_CHEST_HEIGHT = 1.1;

interface SpawnDef {
  id: string;
  team: TeamId;
  colorId: AgentColorId;
  spawn: Vec3;
  yaw: number;
}

function buildRosterSpawns(): SpawnDef[] {
  const spawns = getArenaSpawns();
  return [
    { id: 'ally-red', team: 'ally', colorId: 'red', spawn: { ...spawns.allies[0] }, yaw: 0 },
    { id: 'ally-blue', team: 'ally', colorId: 'blue', spawn: { ...spawns.allies[1] }, yaw: 0 },
    { id: 'ally-green', team: 'ally', colorId: 'green', spawn: { ...spawns.allies[2] }, yaw: 0 },
    { id: 'enemy-red', team: 'enemy', colorId: 'red', spawn: { ...spawns.enemies[0] }, yaw: Math.PI },
    { id: 'enemy-blue', team: 'enemy', colorId: 'blue', spawn: { ...spawns.enemies[1] }, yaw: Math.PI },
    { id: 'enemy-green', team: 'enemy', colorId: 'green', spawn: { ...spawns.enemies[2] }, yaw: Math.PI },
  ];
}

function getBotWeaponForRound(roundNum: number, colorId: AgentColorId): WeaponId {
  if (roundNum <= 1) return 'pistol';
  if (roundNum === 2) return 'smg';
  return colorId === 'blue' ? 'sniper' : 'ar';
}

function formatCombatantLabel(c: Combatant): string {
  if (c.isPlayer) return 'YOU';
  const prefix = c.team === 'ally' ? 'ALLY' : 'FOE';
  return `${prefix} ${c.colorId.toUpperCase()}`;
}

export function createMatchManager(
  scene: THREE.Scene,
  abilities: AbilitySystem,
  weaponSystem: WeaponSystem,
  sfx: SoundEngine
): MatchManager {
  const botBrain = createBotBrainSystem();

  const combatants: Combatant[] = [];
  const rigById = new Map<string, CharacterRig>();
  const combatantById = new Map<string, Combatant>();
  const dotFlashCooldownById = new Map<string, number>();

  // Match & Round State
  let phase: RoundPhase = 'buy';
  let roundNumber = 1;
  let phaseTimerSec = BUY_PHASE_DURATION_SEC;
  let allyScore = 0;
  let enemyScore = 0;
  let roundBannerTitle: string | null = `ROUND 1 — BUY PHASE`;
  let roundBannerSubtitle: string | null =
    'PRESS [SPACE] TO FIGHT  •  [1-4] WEAPON  •  [F1-F3] AGENT';

  let thirdPersonMode = false;
  let preferredPlayerColor: AgentColorId = 'red';
  let pendingSyncCombatantToPlayer = true;
  let playerStateRef: PlayerState | null = null;
  let lastSyncedPlayerHealth = 100;

  let nextKillId = 1;
  const killFeed: KillFeedEntry[] = [];

  // Spawn all 6 combatants + articulated 3D CharacterRigs using dynamic Killhouse spawns
  const initialSpawns = buildRosterSpawns();
  for (const def of initialSpawns) {
    const isInitialPlayer = def.team === 'ally' && def.colorId === preferredPlayerColor;
    const startingWeapon: WeaponId = isInitialPlayer
      ? weaponSystem.currentWeaponId
      : getBotWeaponForRound(1, def.colorId);

    const combatant: Combatant = {
      id: def.id,
      basePosition: { ...def.spawn },
      position: { ...def.spawn },
      colorId: def.colorId,
      health: 100,
      maxHealth: 100,
      alive: true,
      respawnTimer: 0,
      strafeSpeed: 0,
      strafeRange: 0,
      strafePhase: 0,
      slowTimer: 0,
      blindTimer: 0,
      team: def.team,
      isPlayer: isInitialPlayer,
      yaw: def.yaw,
      pitch: 0,
      velocity: { x: 0, y: 0, z: 0 },
      grounded: false,
      weaponId: startingWeapon,
    };

    const rig = createCharacterModel(scene, def.team, def.colorId);
    rig.setWeaponModel(startingWeapon);
    rig.setVisible(!isInitialPlayer || thirdPersonMode);

    combatants.push(combatant);
    combatantById.set(combatant.id, combatant);
    rigById.set(combatant.id, rig);
  }

  botBrain.resetRound(combatants);

  function getPlayerCombatant(): Combatant {
    return combatants.find((c) => c.isPlayer) ?? combatants[0];
  }

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
        // Show player's own 3D rig in 3rd-person mode OR when collapsed on death
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

    victim.health = Math.max(0, victim.health - amount);
    if (victim.isPlayer && playerStateRef) {
      playerStateRef.health = victim.health;
      lastSyncedPlayerHealth = victim.health;
    }

    const rig = rigById.get(victim.id);
    if (rig) {
      // Throttle hit flash on continuous fire-tick damage so character doesn't strobe
      if (amount >= 1.5 || isHeadshot) {
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

      if (attacker) {
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
        pushKillFeed('INFERNO', oppTeam, 'red', victim, weaponTag, false);
      }

      updateRigVisibilities();
      return true;
    }

    return false;
  }

  // Shared hitbox computation matching characterModel.ts & targets.ts
  function getCombatantHitboxes(target: TargetDummy): { head: AABB; body: AABB } {
    const { x, y, z } = target.position;
    return {
      body: {
        min: { x: x - BODY_HALF_WIDTH, y, z: z - BODY_HALF_WIDTH },
        max: { x: x + BODY_HALF_WIDTH, y: y + BODY_HEIGHT, z: z + BODY_HALF_WIDTH },
      },
      head: {
        min: { x: x - HEAD_HALF_WIDTH, y: y + BODY_HEIGHT, z: z - HEAD_HALF_WIDTH },
        max: { x: x + HEAD_HALF_WIDTH, y: y + BODY_HEIGHT + HEAD_HEIGHT, z: z + HEAD_HALF_WIDTH },
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

  /**
   * `TargetsManager` adapter exposing living `'enemy'` combatants to the player's
   * `WeaponSystem`. Kills are credited directly to `getPlayerCombatant()` with the
   * active weapon's `shortTag`.
   */
  const enemyTargetsView: TargetsManager = {
    get targets(): TargetDummy[] {
      return combatants.filter((c) => c.team === 'enemy');
    },
    update(): void {
      // Driven by MatchManager.update()
    },
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

  /**
   * `TargetsManager` adapter exposing ALL 6 combatants to `AbilitySystem` for
   * AoE fire damage, Cryo slows, Bio-Stim heals, and Pop-Flash blinds.
   */
  const allTargetsView: TargetsManager = {
    get targets(): TargetDummy[] {
      return combatants;
    },
    update(): void {
      // Driven by MatchManager.update()
    },
    getHitboxes: getCombatantHitboxes,
    applyDamage(targetId: string, amount: number, isHeadshot: boolean): boolean {
      const victim = combatantById.get(targetId);
      if (!victim) return false;
      return applyDamageInternal(victim, amount, isHeadshot, null, 'INFERNO');
    },
    applyStatus: applyStatusToCombatant,
  };

  function setupRound(nextRoundNum: number): void {
    roundNumber = nextRoundNum;
    phase = 'buy';
    phaseTimerSec = BUY_PHASE_DURATION_SEC;
    roundBannerTitle = `ROUND ${roundNumber} — BUY PHASE`;
    roundBannerSubtitle = 'PRESS [SPACE] TO FIGHT  •  [1-4] WEAPON  •  [F1-F3] AGENT';

    abilities.resetRound();
    weaponSystem.resetForRound();
    dotFlashCooldownById.clear();

    const rosterSpawns = buildRosterSpawns();
    for (let i = 0; i < rosterSpawns.length; i++) {
      const def = rosterSpawns[i];
      const c = combatants[i];
      const shouldBePlayer = def.team === 'ally' && def.colorId === preferredPlayerColor;

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
      c.yaw = def.yaw;
      c.pitch = 0;
      c.weaponId = shouldBePlayer
        ? weaponSystem.currentWeaponId
        : getBotWeaponForRound(roundNumber, c.colorId);

      const rig = rigById.get(c.id);
      if (rig) {
        rig.setWeaponModel(c.weaponId);
      }
    }

    lastSyncedPlayerHealth = 100;
    pendingSyncCombatantToPlayer = true;
    if (playerStateRef) {
      const pc = getPlayerCombatant();
      playerStateRef.position.x = pc.position.x;
      playerStateRef.position.y = pc.position.y;
      playerStateRef.position.z = pc.position.z;
      playerStateRef.velocity.x = 0;
      playerStateRef.velocity.y = 0;
      playerStateRef.velocity.z = 0;
      playerStateRef.grounded = false;
      playerStateRef.health = 100;
      playerStateRef.maxHealth = 100;
      playerStateRef.colorId = pc.colorId;
    }

    botBrain.resetRound(combatants);
    updateRigVisibilities();
  }

  function selectPlayerAgent(colorId: AgentColorId): void {
    preferredPlayerColor = colorId;
    const current = getPlayerCombatant();
    if (current.colorId === colorId) return;

    const target = combatants.find((c) => c.team === 'ally' && c.colorId === colorId);
    if (!target) return;

    if (phase === 'buy') {
      // In Buy Phase: swap spawn slots so the human player stays smoothly in place
      const prevPos = { ...current.position };
      const targetPos = { ...target.position };
      current.position.x = targetPos.x;
      current.position.y = targetPos.y;
      current.position.z = targetPos.z;
      target.position.x = prevPos.x;
      target.position.y = prevPos.y;
      target.position.z = prevPos.z;

      current.isPlayer = false;
      current.weaponId = getBotWeaponForRound(roundNumber, current.colorId);
      target.isPlayer = true;
      target.weaponId = weaponSystem.currentWeaponId;

      rigById.get(current.id)?.setWeaponModel(current.weaponId);
      rigById.get(target.id)?.setWeaponModel(target.weaponId);
      updateRigVisibilities();
    } else if (target.alive) {
      // Mid-combat swap onto a living ally transfers human control cleanly
      current.isPlayer = false;
      current.weaponId = getBotWeaponForRound(roundNumber, current.colorId);
      target.isPlayer = true;
      weaponSystem.equipWeapon(target.weaponId);
      weaponSystem.setAgentColor(target.colorId);
      lastSyncedPlayerHealth = target.health;
      pendingSyncCombatantToPlayer = true;
      updateRigVisibilities();
    }
  }

  function tryTakeoverAlly(): AgentColorId | null {
    const current = getPlayerCombatant();
    if (current.alive) return null;

    const livingAlly = combatants.find(
      (c) => c.team === 'ally' && !c.isPlayer && c.alive
    );
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
    roundBannerSubtitle = null;
    sfx.playRoundCue('fight');
  }

  function restartMatch(): void {
    allyScore = 0;
    enemyScore = 0;
    killFeed.length = 0;
    setupRound(1);
    sfx.playRoundCue('buy');
  }

  function onMapRebuilt(): void {
    setupRound(roundNumber);
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
    firedThisFrame: boolean
  ): void {
    playerStateRef = player;
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
      player.colorId = pc.colorId;
      lastSyncedPlayerHealth = pc.health;
      pendingSyncCombatantToPlayer = false;
      return;
    }

    // Reconcile health deltas cleanly whether AbilitySystem mutated `player.health`
    // (beacon heal / self-scorch) or `allTargetsView` (enemy fire / bot damage).
    const playerDelta = player.health - lastSyncedPlayerHealth;
    const combatantDelta = pc.health - lastSyncedPlayerHealth;
    let mergedHealth = lastSyncedPlayerHealth;

    if (Math.abs(playerDelta) > 1e-6 || Math.abs(combatantDelta) > 1e-6) {
      mergedHealth = Math.max(0, Math.min(pc.maxHealth, lastSyncedPlayerHealth + playerDelta + combatantDelta));
    }

    pc.health = mergedHealth;
    player.health = mergedHealth;
    lastSyncedPlayerHealth = mergedHealth;

    if (pc.health <= 0 && pc.alive) {
      pc.alive = false;
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

  function transitionToRoundEnd(winner: TeamId, subtitle: string): void {
    phase = 'round_end';
    phaseTimerSec = ROUND_END_DURATION_SEC;

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

  function update(
    dt: number,
    player: PlayerState,
    cameraPos: Vec3,
    activeSmokes: SmokeSphere[]
  ): MatchHudState {
    playerStateRef = player;

    // 1. Age out kill feed entries and decay combatant status timers
    for (let i = killFeed.length - 1; i >= 0; i--) {
      killFeed[i].age += dt;
      if (killFeed[i].age >= KILLFEED_MAX_AGE_SEC) {
        killFeed.splice(i, 1);
      }
    }

    for (const c of combatants) {
      c.slowTimer = Math.max(0, c.slowTimer - dt);
      c.blindTimer = Math.max(0, c.blindTimer - dt);
      const flashCd = dotFlashCooldownById.get(c.id) ?? 0;
      if (flashCd > 0) {
        dotFlashCooldownById.set(c.id, Math.max(0, flashCd - dt));
      }
    }

    // 2. Step Round State Machine
    if (phase === 'buy') {
      phaseTimerSec = Math.max(0, phaseTimerSec - dt);
      roundBannerTitle = `ROUND ${roundNumber} — BUY PHASE`;
      roundBannerSubtitle = 'PRESS [SPACE] TO FIGHT  •  [1-4] WEAPON  •  [F1-F3] AGENT';

      // Keep bots grounded in spawn during buy phase
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
        () => {}
      );

      if (phaseTimerSec <= 0) {
        skipBuyPhase();
      }
    } else if (phase === 'combat') {
      phaseTimerSec = Math.max(0, phaseTimerSec - dt);

      // Clear brief "FIGHT!" callout after 1.4s into combat
      if (phaseTimerSec < COMBAT_PHASE_DURATION_SEC - 1.4 && roundBannerTitle === 'FIGHT!') {
        roundBannerTitle = null;
        roundBannerSubtitle = null;
      }

      // Step AI bots (FSM + Multi-Gate Perception + Abilities + Burst Firing)
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
        }
      );

      // Evaluate round termination conditions
      const aliveAllies = combatants.filter((c) => c.team === 'ally' && c.alive).length;
      const aliveEnemies = combatants.filter((c) => c.team === 'enemy' && c.alive).length;

      if (aliveEnemies === 0) {
        transitionToRoundEnd('ally', 'ALL ENEMIES ELIMINATED');
      } else if (aliveAllies === 0) {
        transitionToRoundEnd('enemy', 'TEAM ELIMINATED');
      } else if (phaseTimerSec <= 0) {
        transitionToRoundEnd('enemy', 'TIME EXPIRED — DEFENDERS HELD');
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

    // 3. Check Bot Takeover Availability & Update Articulated 3D Character Rigs
    const playerCombatant = getPlayerCombatant();
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

      // Smoke vision occlusion check from active camera to combatant chest
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
        },
        cameraPos
      );
    }

    // Keep player's health mirrored cleanly into PlayerState
    player.health = playerCombatant.health;
    lastSyncedPlayerHealth = playerCombatant.health;

    // 4. Project Read-Only HUD State
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
    };
  }

  return {
    combatants,
    enemyTargetsView,
    allTargetsView,
    getPlayerCombatant,
    selectPlayerAgent,
    tryTakeoverAlly,
    skipBuyPhase,
    restartMatch,
    onMapRebuilt,
    setThirdPersonMode,
    syncPlayerFromPhysics,
    update,
  };
}
