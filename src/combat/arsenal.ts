import type { ShieldTier, WeaponId, WeaponSpec } from '../core/types';

/**
 * Canonical slot ordering matching keys `[1]` through `[4]` and mouse-wheel cycling.
 */
export const WEAPON_ORDER: WeaponId[] = ['pistol', 'smg', 'ar', 'sniper'];

/**
 * Static weapon specification table inspired by tactical 5v5 arena shooters.
 *
 * Separating immutable `WeaponSpec` metadata from live per-round `WeaponState`
 * allows AI bots, HUD widgets, mobility scaling, and hitscan raycasts to read
 * balanced combat parameters from a single source of truth without duplicating data.
 */
export const WEAPON_SPECS: Record<WeaponId, WeaponSpec> = {
  pistol: {
    id: 'pistol',
    slotNumber: 1,
    name: 'Sidearm',
    shortTag: 'PISTOL',
    automatic: false,
    fireIntervalSec: 0.19,
    reloadDurationSec: 1.15,
    maxAmmo: 12,
    headDamage: 115,
    bodyDamage: 36,
    falloffStartM: 18,
    falloffEndM: 42,
    minFalloffMult: 0.72,
    baseSpreadRad: 0.001,
    scopedSpreadRad: 0,
    moveSpreadRad: 0.030,
    airSpreadRad: 0.055,
    recoilPerShot: 0.14,
    moveSpeedMult: 1.05,
    adsFovDeg: null,
    tracerWidthScale: 0.9,
    cost: 0,
    killReward: 200,
  },
  smg: {
    id: 'smg',
    slotNumber: 2,
    name: 'Spectre SMG',
    shortTag: 'SMG',
    automatic: true,
    fireIntervalSec: 0.062,
    reloadDurationSec: 1.35,
    maxAmmo: 30,
    headDamage: 78,
    bodyDamage: 24,
    falloffStartM: 15,
    falloffEndM: 38,
    minFalloffMult: 0.65,
    baseSpreadRad: 0.004,
    scopedSpreadRad: 0.002,
    moveSpreadRad: 0.034,
    airSpreadRad: 0.062,
    recoilPerShot: 0.11,
    moveSpeedMult: 1.02,
    adsFovDeg: 64,
    tracerWidthScale: 0.85,
    cost: 1600,
    killReward: 200,
  },
  ar: {
    id: 'ar',
    slotNumber: 3,
    name: 'Pulse Rifle',
    shortTag: 'AR',
    automatic: true,
    fireIntervalSec: 0.105,
    reloadDurationSec: 1.5,
    maxAmmo: 25,
    headDamage: 160,
    bodyDamage: 40,
    falloffStartM: 50,
    falloffEndM: 100,
    minFalloffMult: 1.0,
    baseSpreadRad: 0.0,
    scopedSpreadRad: 0.0,
    moveSpreadRad: 0.065,
    airSpreadRad: 0.085,
    recoilPerShot: 0.18,
    moveSpeedMult: 1.0,
    adsFovDeg: 58,
    tracerWidthScale: 1.0,
    cost: 2900,
    killReward: 200,
  },
  sniper: {
    id: 'sniper',
    slotNumber: 4,
    name: 'Rail Sniper',
    shortTag: 'SNIPER',
    automatic: false,
    fireIntervalSec: 1.15,
    reloadDurationSec: 2.1,
    maxAmmo: 5,
    headDamage: 255,
    bodyDamage: 150,
    falloffStartM: 100,
    falloffEndM: 200,
    minFalloffMult: 1.0,
    baseSpreadRad: 0.085,
    scopedSpreadRad: 0.0,
    moveSpreadRad: 0.11,
    airSpreadRad: 0.14,
    recoilPerShot: 0.45,
    moveSpeedMult: 0.88,
    adsFovDeg: 24,
    tracerWidthScale: 1.8,
    cost: 4700,
    killReward: 200,
  },
};

/**
 * Tactical armor shield tiers purchasable during the Buy Phase.
 */
export const SHIELD_SPECS: Record<ShieldTier, { id: ShieldTier; name: string; armor: number; cost: number }> = {
  none: { id: 'none', name: 'No Shield', armor: 0, cost: 0 },
  light: { id: 'light', name: 'Light Shield', armor: 25, cost: 400 },
  heavy: { id: 'heavy', name: 'Heavy Shield', armor: 50, cost: 1000 },
};

/**
 * Computes weapon hitscan damage using **piecewise linear distance falloff**.
 *
 * Pedagogical Breakdown — Piecewise Linear Falloff:
 * Tactical shooters define three distinct range regimes per weapon so close-quarters
 * weapons (Pistol, SMG) cannot out-duel rifles across long corridors while still
 * rewarding clean close-range engagements:
 *
 * 1. **Point-Blank Plateau (`d <= falloffStartM`)**:
 *    `t` clamps to `0`, giving `mult = 1.0` (100% full damage). For example, the
 *    Sidearm deals its full `115` headshot (1-tap!) inside `18 m`.
 * 2. **Linear Transition Ramp (`falloffStartM < d < falloffEndM`)**:
 *    Normalized progress `t = (d - start) / max(0.01, end - start)` increases
 *    linearly across `(0, 1)`. The denominator guard `max(0.01, ...)` prevents
 *    `NaN` or `Infinity` if a weapon ever sets `falloffStartM === falloffEndM`.
 *    Multiplier interpolates linearly from `1.0` down to `minFalloffMult`:
 *    `mult = 1 - (1 - minFalloffMult) * t`.
 * 3. **Long-Range Floor (`d >= falloffEndM`)**:
 *    `t` clamps to `1`, locking damage at `baseDamage * minFalloffMult` so
 *    bullets never decay to zero at extreme arena sightlines.
 *
 * Note: Pulse Rifle (`ar`) and Rail Sniper (`sniper`) set `minFalloffMult = 1.0`,
 * preserving their deterministic 1-shot headshot (`160`) and 1-shot body (`150`)
 * breakpoints across the entire arena.
 */
export function computeWeaponDamage(
  spec: WeaponSpec,
  distanceM: number,
  isHeadshot: boolean,
): number {
  const span = Math.max(0.01, spec.falloffEndM - spec.falloffStartM);
  const rawT = (distanceM - spec.falloffStartM) / span;
  const t = Math.min(1, Math.max(0, rawT));
  const mult = 1 - (1 - spec.minFalloffMult) * t;
  const baseDamage = isHeadshot ? spec.headDamage : spec.bodyDamage;
  return Math.round(baseDamage * mult);
}
