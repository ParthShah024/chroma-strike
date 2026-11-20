import { Combatant, ShieldTier, TeamId, WeaponId } from '../core/types';
import { SHIELD_SPECS, WEAPON_SPECS } from '../combat/arsenal';

/**
 * ============================================================================
 * Valorant / CS Tactical Economy State Machine
 * ============================================================================
 *
 * Manages per-combatant credits, round-over-round weapon/armor persistence,
 * team loss-streak bonuses, smart delta shield pricing, 100% buy-phase weapon
 * refunds, and intelligent eco / half-buy / full-buy AI purchasing decisions.
 */

export const START_CREDITS = 800;
export const MAX_CREDITS = 9000;
export const WIN_REWARD = 3000;
export const LOSS_STREAK_REWARDS = [1900, 2400, 2900] as const;
export const KILL_REWARD = 200;
export const PLANT_TEAM_BONUS = 300;
export const DEFUSE_TEAM_BONUS = 300;

export interface CombatantEconomyState {
  credits: number;
  weaponId: WeaponId;
  shieldTier: ShieldTier;
  armor: number;
  maxArmor: number;
  boughtWeaponThisRound: boolean;
  preBuyWeapon: WeaponId;
  boughtWeaponCost: number;
  boughtArmorThisRound: boolean;
  preBuyShieldTier: ShieldTier;
  preBuyArmor: number;
  preBuyMaxArmor: number;
  boughtArmorCost: number;
}

export interface BuyWeaponResult {
  ok: boolean;
  reason?: string;
  weaponId: WeaponId;
  credits: number;
}

export interface RefundWeaponResult {
  ok: boolean;
  weaponId: WeaponId;
  refunded: number;
  credits: number;
}

export interface BuyShieldResult {
  ok: boolean;
  reason?: string;
  shieldTier: ShieldTier;
  armor: number;
  maxArmor: number;
  cost: number;
  credits: number;
}

export interface EconomySystem {
  resetForNewMatch(combatants: Combatant[]): void;
  resetForHalftime(combatants: Combatant[]): void;
  beginBuyPhase(combatants: Combatant[]): void;
  onKill(killerId: string, combatants?: Combatant[]): void;
  onPlant(attackerTeam: TeamId, combatants: Combatant[]): void;
  onRoundEnd(winnerTeam: TeamId, allCombatants: Combatant[], spikeDefused: boolean): void;
  runBotBuyPhase(combatants: Combatant[], attackerTeam: TeamId): void;
  buyWeapon(playerId: string, weaponId: WeaponId, combatants?: Combatant[]): BuyWeaponResult;
  refundPlayerWeapon(playerId: string, combatants?: Combatant[]): RefundWeaponResult;
  buyShield(playerId: string, tier: ShieldTier, combatants?: Combatant[]): BuyShieldResult;
  refundPlayerShield(playerId: string, combatants?: Combatant[]): BuyShieldResult;
  getShieldUpgradeCost(playerId: string, tier: ShieldTier): number;
  getMinNextRoundCredits(team: TeamId, credits: number): number;
  getLossStreak(team: TeamId): number;
  getCombatantState(combatantId: string): CombatantEconomyState;
  syncDamageArmor(combatantId: string, remainingArmor: number): void;
}

const WEAPON_TIER_RANK: Record<WeaponId, number> = {
  knife: -1,
  pistol: 0,
  smg: 1,
  ar: 2,
  sniper: 3,
};

function clampCredits(value: number): number {
  return Math.max(0, Math.min(MAX_CREDITS, Math.round(value)));
}

function createDefaultState(): CombatantEconomyState {
  return {
    credits: START_CREDITS,
    weaponId: 'pistol',
    shieldTier: 'none',
    armor: 0,
    maxArmor: 0,
    boughtWeaponThisRound: false,
    preBuyWeapon: 'pistol',
    boughtWeaponCost: 0,
    boughtArmorThisRound: false,
    preBuyShieldTier: 'none',
    preBuyArmor: 0,
    preBuyMaxArmor: 0,
    boughtArmorCost: 0,
  };
}

export function createEconomySystem(): EconomySystem {
  const states = new Map<string, CombatantEconomyState>();
  const lossStreak: Record<TeamId, number> = {
    ally: 0,
    enemy: 0,
  };

  function getOrCreateState(combatantId: string): CombatantEconomyState {
    let st = states.get(combatantId);
    if (!st) {
      st = createDefaultState();
      states.set(combatantId, st);
    }
    return st;
  }

  function applyStateToCombatant(c: Combatant, st: CombatantEconomyState): void {
    c.credits = st.credits;
    c.weaponId = st.weaponId;
    c.shieldTier = st.shieldTier;
    c.armor = st.armor;
    c.maxArmor = st.maxArmor;
  }

  function syncCombatantById(combatantId: string, combatants?: Combatant[]): void {
    if (!combatants) return;
    const c = combatants.find((item) => item.id === combatantId);
    if (!c) return;
    applyStateToCombatant(c, getOrCreateState(combatantId));
  }

  function resetAllToPistolRound(combatants: Combatant[]): void {
    lossStreak.ally = 0;
    lossStreak.enemy = 0;
    states.clear();

    for (const c of combatants) {
      const st = createDefaultState();
      states.set(c.id, st);
      applyStateToCombatant(c, st);
    }
  }

  function resetForNewMatch(combatants: Combatant[]): void {
    resetAllToPistolRound(combatants);
  }

  function resetForHalftime(combatants: Combatant[]): void {
    resetAllToPistolRound(combatants);
  }

  function beginBuyPhase(combatants: Combatant[]): void {
    for (const c of combatants) {
      const st = getOrCreateState(c.id);
      st.preBuyWeapon = st.weaponId;
      st.preBuyShieldTier = st.shieldTier;
      st.preBuyArmor = st.armor;
      st.preBuyMaxArmor = st.maxArmor;
      st.boughtWeaponThisRound = false;
      st.boughtWeaponCost = 0;
      st.boughtArmorThisRound = false;
      st.boughtArmorCost = 0;
      applyStateToCombatant(c, st);
    }
  }

  function onKill(killerId: string, combatants?: Combatant[]): void {
    const st = getOrCreateState(killerId);
    st.credits = clampCredits(st.credits + KILL_REWARD);
    syncCombatantById(killerId, combatants);
  }

  function onPlant(attackerTeam: TeamId, combatants: Combatant[]): void {
    for (const c of combatants) {
      if (c.team !== attackerTeam) continue;
      const st = getOrCreateState(c.id);
      st.credits = clampCredits(st.credits + PLANT_TEAM_BONUS);
      applyStateToCombatant(c, st);
    }
  }

  function onRoundEnd(
    winnerTeam: TeamId,
    allCombatants: Combatant[],
    spikeDefused: boolean
  ): void {
    const loserTeam: TeamId = winnerTeam === 'ally' ? 'enemy' : 'ally';
    const winnerBonus = WIN_REWARD + (spikeDefused ? DEFUSE_TEAM_BONUS : 0);
    const loserBonus =
      LOSS_STREAK_REWARDS[Math.min(LOSS_STREAK_REWARDS.length - 1, lossStreak[loserTeam])];

    lossStreak[winnerTeam] = 0;
    lossStreak[loserTeam] += 1;

    for (const c of allCombatants) {
      const st = getOrCreateState(c.id);

      // Survivors carry over their current weapon and remaining armor into the next round.
      if (c.alive) {
        st.weaponId = c.weaponId;
        const remainingArmor = Math.max(0, Math.round(c.armor ?? st.armor));
        st.armor = remainingArmor;
        if (remainingArmor <= 0) {
          st.maxArmor = 0;
          st.shieldTier = 'none';
        } else {
          st.maxArmor = Math.max(st.maxArmor, c.maxArmor ?? remainingArmor);
          if (st.shieldTier === 'none') {
            st.shieldTier = remainingArmor > SHIELD_SPECS.light.armor ? 'heavy' : 'light';
          }
        }
      } else {
        st.weaponId = 'pistol';
        st.armor = 0;
        st.maxArmor = 0;
        st.shieldTier = 'none';
      }

      const roundIncome = c.team === winnerTeam ? winnerBonus : loserBonus;
      st.credits = clampCredits(st.credits + roundIncome);
      st.boughtWeaponThisRound = false;
      st.boughtWeaponCost = 0;
      st.boughtArmorThisRound = false;
      st.boughtArmorCost = 0;
      st.preBuyWeapon = st.weaponId;
      st.preBuyShieldTier = st.shieldTier;
      st.preBuyArmor = st.armor;
      st.preBuyMaxArmor = st.maxArmor;

      applyStateToCombatant(c, st);
    }
  }

  /**
   * Computes smart delta pricing for shields:
   * - Upgrading intact Light (25) -> Heavy (50) costs `1000 - 400 = 600¤`.
   * - Re-buying damaged armor charges proportionally for missing armor capacity.
   */
  function getShieldUpgradeCost(playerId: string, tier: ShieldTier): number {
    if (tier === 'none') return 0;
    const st = getOrCreateState(playerId);
    const targetSpec = SHIELD_SPECS[tier];
    if (st.armor >= targetSpec.armor) return 0;

    if (st.armor <= 0) {
      return targetSpec.cost;
    }

    if (tier === 'heavy') {
      if (st.shieldTier === 'light') {
        const lightValue = Math.round(
          (Math.min(st.armor, SHIELD_SPECS.light.armor) / SHIELD_SPECS.light.armor) *
            SHIELD_SPECS.light.cost
        );
        return Math.max(50, Math.min(targetSpec.cost, targetSpec.cost - lightValue));
      }
      // Re-buying damaged Heavy Shield
      const missingRatio = (targetSpec.armor - st.armor) / targetSpec.armor;
      return Math.max(50, Math.min(targetSpec.cost, Math.round((missingRatio * targetSpec.cost) / 10) * 10));
    }

    // Re-buying damaged Light Shield
    const missingRatio = (targetSpec.armor - st.armor) / targetSpec.armor;
    return Math.max(50, Math.min(targetSpec.cost, Math.round((missingRatio * targetSpec.cost) / 10) * 10));
  }

  function buyWeapon(
    playerId: string,
    weaponId: WeaponId,
    combatants?: Combatant[]
  ): BuyWeaponResult {
    const st = getOrCreateState(playerId);
    if (weaponId === 'knife') {
      return {
        ok: false,
        reason: 'Knife is always equipped',
        weaponId: st.weaponId,
        credits: st.credits,
      };
    }
    const spec = WEAPON_SPECS[weaponId];

    // Clicking the already-equipped weapon is a clean no-op (prevents double charge).
    if (st.weaponId === weaponId) {
      return { ok: false, reason: 'Already equipped', weaponId: st.weaponId, credits: st.credits };
    }

    // Switching back to pre-buy weapon after a buy-phase purchase refunds 100%.
    if (st.boughtWeaponThisRound && weaponId === st.preBuyWeapon) {
      const refunded = refundPlayerWeapon(playerId, combatants);
      return {
        ok: refunded.ok,
        weaponId: refunded.weaponId,
        credits: refunded.credits,
      };
    }

    const effectiveCredits = st.credits + (st.boughtWeaponThisRound ? st.boughtWeaponCost : 0);
    if (effectiveCredits < spec.cost) {
      return {
        ok: false,
        reason: 'Insufficient credits',
        weaponId: st.weaponId,
        credits: st.credits,
      };
    }

    if (st.boughtWeaponThisRound) {
      st.credits = clampCredits(st.credits + st.boughtWeaponCost);
    } else {
      st.preBuyWeapon = st.weaponId;
    }

    st.credits = clampCredits(st.credits - spec.cost);
    st.weaponId = weaponId;
    st.boughtWeaponThisRound = spec.cost > 0;
    st.boughtWeaponCost = spec.cost;

    syncCombatantById(playerId, combatants);
    return {
      ok: true,
      weaponId: st.weaponId,
      credits: st.credits,
    };
  }

  function refundPlayerWeapon(playerId: string, combatants?: Combatant[]): RefundWeaponResult {
    const st = getOrCreateState(playerId);
    if (!st.boughtWeaponThisRound || st.boughtWeaponCost <= 0) {
      return {
        ok: false,
        weaponId: st.weaponId,
        refunded: 0,
        credits: st.credits,
      };
    }

    const refunded = st.boughtWeaponCost;
    st.credits = clampCredits(st.credits + refunded);
    st.weaponId = st.preBuyWeapon;
    st.boughtWeaponThisRound = false;
    st.boughtWeaponCost = 0;

    syncCombatantById(playerId, combatants);
    return {
      ok: true,
      weaponId: st.weaponId,
      refunded,
      credits: st.credits,
    };
  }

  function refundPlayerShield(playerId: string, combatants?: Combatant[]): BuyShieldResult {
    const st = getOrCreateState(playerId);
    if (!st.boughtArmorThisRound || st.boughtArmorCost <= 0) {
      return {
        ok: false,
        reason: 'No shield purchase to refund',
        shieldTier: st.shieldTier,
        armor: st.armor,
        maxArmor: st.maxArmor,
        cost: 0,
        credits: st.credits,
      };
    }

    const refunded = st.boughtArmorCost;
    st.credits = clampCredits(st.credits + refunded);
    st.shieldTier = st.preBuyShieldTier;
    st.armor = st.preBuyArmor;
    st.maxArmor = st.preBuyMaxArmor;
    st.boughtArmorThisRound = false;
    st.boughtArmorCost = 0;

    syncCombatantById(playerId, combatants);
    return {
      ok: true,
      shieldTier: st.shieldTier,
      armor: st.armor,
      maxArmor: st.maxArmor,
      cost: -refunded,
      credits: st.credits,
    };
  }

  function buyShield(
    playerId: string,
    tier: ShieldTier,
    combatants?: Combatant[]
  ): BuyShieldResult {
    const st = getOrCreateState(playerId);
    if (tier === 'none') {
      return {
        ok: false,
        reason: 'Invalid shield tier',
        shieldTier: st.shieldTier,
        armor: st.armor,
        maxArmor: st.maxArmor,
        cost: 0,
        credits: st.credits,
      };
    }

    // One-shield-per-round rule: clicking your already-bought tier refunds 100%,
    // while clicking the other tier is blocked until you unequip first.
    if (st.boughtArmorThisRound) {
      if (st.shieldTier === tier) {
        return refundPlayerShield(playerId, combatants);
      }
      return {
        ok: false,
        reason: 'Only one shield tier may be chosen',
        shieldTier: st.shieldTier,
        armor: st.armor,
        maxArmor: st.maxArmor,
        cost: 0,
        credits: st.credits,
      };
    }

    // Never allow buying Light Shield when Heavy armor is already carried over.
    if (st.shieldTier === 'heavy' && st.armor > 0 && tier === 'light') {
      return {
        ok: false,
        reason: 'Heavy Shield already active',
        shieldTier: st.shieldTier,
        armor: st.armor,
        maxArmor: st.maxArmor,
        cost: 0,
        credits: st.credits,
      };
    }

    const targetSpec = SHIELD_SPECS[tier];
    if (st.armor >= targetSpec.armor) {
      return {
        ok: false,
        reason: 'Already at full armor for tier',
        shieldTier: st.shieldTier,
        armor: st.armor,
        maxArmor: st.maxArmor,
        cost: 0,
        credits: st.credits,
      };
    }

    const cost = getShieldUpgradeCost(playerId, tier);
    if (st.credits < cost) {
      return {
        ok: false,
        reason: 'Insufficient credits',
        shieldTier: st.shieldTier,
        armor: st.armor,
        maxArmor: st.maxArmor,
        cost,
        credits: st.credits,
      };
    }

    st.credits = clampCredits(st.credits - cost);
    st.shieldTier = tier;
    st.armor = targetSpec.armor;
    st.maxArmor = targetSpec.armor;
    st.boughtArmorThisRound = cost > 0;
    st.boughtArmorCost = cost;

    syncCombatantById(playerId, combatants);
    return {
      ok: true,
      shieldTier: st.shieldTier,
      armor: st.armor,
      maxArmor: st.maxArmor,
      cost,
      credits: st.credits,
    };
  }

  function runBotBuyPhase(combatants: Combatant[], attackerTeam: TeamId): void {
    for (const bot of combatants) {
      if (bot.isPlayer) continue;

      const st = getOrCreateState(bot.id);
      const currentRank = WEAPON_TIER_RANK[st.weaponId];
      const wantsSniper = bot.colorId === 'blue' || bot.colorId === 'violet';

      // Case 1: Bot survived with a primary rifle or sniper -> keep weapon and top up armor.
      if (currentRank >= WEAPON_TIER_RANK.ar) {
        const heavyCost = getShieldUpgradeCost(bot.id, 'heavy');
        const lightCost = getShieldUpgradeCost(bot.id, 'light');
        if (st.armor < SHIELD_SPECS.heavy.armor && st.credits >= heavyCost) {
          buyShield(bot.id, 'heavy', combatants);
        } else if (st.armor < SHIELD_SPECS.light.armor && st.credits >= lightCost) {
          buyShield(bot.id, 'light', combatants);
        }
        applyStateToCombatant(bot, st);
        continue;
      }

      // Case 2: Rail Sniper full-buy for Controllers (`blue` / `violet`) at >= 4700¤
      if (wantsSniper && st.credits >= WEAPON_SPECS.sniper.cost) {
        buyWeapon(bot.id, 'sniper', combatants);
        const heavyCost = getShieldUpgradeCost(bot.id, 'heavy');
        const lightCost = getShieldUpgradeCost(bot.id, 'light');
        if (st.credits >= heavyCost && st.armor < SHIELD_SPECS.heavy.armor) {
          buyShield(bot.id, 'heavy', combatants);
        } else if (st.credits >= lightCost && st.armor < SHIELD_SPECS.light.armor) {
          buyShield(bot.id, 'light', combatants);
        }
        applyStateToCombatant(bot, st);
        continue;
      }

      // Case 3: Full-Buy AR + Heavy Shield at >= 3900¤
      if (st.credits >= WEAPON_SPECS.ar.cost + SHIELD_SPECS.heavy.cost) {
        buyWeapon(bot.id, 'ar', combatants);
        buyShield(bot.id, 'heavy', combatants);
        applyStateToCombatant(bot, st);
        continue;
      }

      // Case 4: Rifle + Light Shield at >= 3300¤
      if (st.credits >= WEAPON_SPECS.ar.cost + SHIELD_SPECS.light.cost) {
        buyWeapon(bot.id, 'ar', combatants);
        buyShield(bot.id, 'light', combatants);
        applyStateToCombatant(bot, st);
        continue;
      }

      // Case 5: Half-Buy SMG + Light Shield at >= 2000¤
      // Smart eco check: if team is saving for a full-buy next round on loss streak,
      // force half-buy only when attackers are pushing or credits >= 2200 or already own SMG.
      const minNextIfSave = getMinNextRoundCredits(bot.team, st.credits);
      const canForceHalfBuy =
        currentRank >= WEAPON_TIER_RANK.smg ||
        st.credits >= 2400 ||
        (bot.team === attackerTeam && st.credits >= 2000) ||
        minNextIfSave < 3300;

      if (st.credits >= WEAPON_SPECS.smg.cost + SHIELD_SPECS.light.cost && canForceHalfBuy) {
        if (currentRank < WEAPON_TIER_RANK.smg) {
          buyWeapon(bot.id, 'smg', combatants);
        }
        const lightCost = getShieldUpgradeCost(bot.id, 'light');
        if (st.armor < SHIELD_SPECS.light.armor && st.credits >= lightCost) {
          buyShield(bot.id, 'light', combatants);
        }
        applyStateToCombatant(bot, st);
        continue;
      }

      // Case 6: Pistol Round (800¤ start) -> buy Light Shield (400¤) so pistol fights use armor!
      if (
        st.credits === START_CREDITS &&
        lossStreak[bot.team] === 0 &&
        st.armor < SHIELD_SPECS.light.armor
      ) {
        buyShield(bot.id, 'light', combatants);
      }

      // Otherwise full eco (Sidearm, saving credits so bots never go broke blindly).
      applyStateToCombatant(bot, st);
    }
  }

  function getMinNextRoundCredits(team: TeamId, credits: number): number {
    const nextLossBonus =
      LOSS_STREAK_REWARDS[Math.min(LOSS_STREAK_REWARDS.length - 1, lossStreak[team])];
    return clampCredits(credits + nextLossBonus);
  }

  function getLossStreak(team: TeamId): number {
    return lossStreak[team];
  }

  function getCombatantState(combatantId: string): CombatantEconomyState {
    return { ...getOrCreateState(combatantId) };
  }

  function syncDamageArmor(combatantId: string, remainingArmor: number): void {
    const st = getOrCreateState(combatantId);
    st.armor = Math.max(0, remainingArmor);
    if (st.armor <= 0) {
      st.armor = 0;
      st.maxArmor = 0;
      st.shieldTier = 'none';
    }
  }

  return {
    resetForNewMatch,
    resetForHalftime,
    beginBuyPhase,
    onKill,
    onPlant,
    onRoundEnd,
    runBotBuyPhase,
    buyWeapon,
    refundPlayerWeapon,
    buyShield,
    refundPlayerShield,
    getShieldUpgradeCost,
    getMinNextRoundCredits,
    getLossStreak,
    getCombatantState,
    syncDamageArmor,
  };
}
