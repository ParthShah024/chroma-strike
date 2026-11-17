import type { AbilitySlot, AbilitySpec, AgentColorId } from '../core/types';

/**
 * Immutable Ability Registry for Chroma Strike.
 *
 * Architectural Note — Separating Static Specifications from Mutable Runtime State:
 * Keeping `AGENT_ABILITIES` as a pure, read-only lookup table (data-driven design)
 * provides three major benefits:
 * 1. **Single Source of Truth**: Both the HUD (key labels, short tags, cooldown
 *    progress denominator) and the simulation (`cooldownSec`) read from the exact
 *    same numbers, eliminating UI/gameplay drift.
 * 2. **Zero-Allocation Swapping**: Switching between Red, Blue, and Green agents
 *    only changes `player.colorId` and queries a different key in this table.
 * 3. **Deterministic Netcode**: In a multiplayer client-server architecture, both
 *    client prediction and server validation load this identical static manifest,
 *    while only mutable timers (`cooldowns`, `ActiveZone`, `AbilityProjectile`)
 *    need to be replicated over the wire.
 */
export const AGENT_ABILITIES: Record<AgentColorId, Record<AbilitySlot, AbilitySpec>> = {
  red: {
    q: {
      slot: 'q',
      keyLabel: 'Q',
      name: 'Crimson Dash',
      shortTag: 'DASH',
      cooldownSec: 6.0,
      description: 'Instant directional burst',
    },
    e: {
      slot: 'e',
      keyLabel: 'E',
      name: 'Inferno Orb',
      shortTag: 'FIRE',
      cooldownSec: 10.0,
      description: 'Bouncing molotov fire zone (35 DPS)',
    },
  },
  blue: {
    q: {
      slot: 'q',
      keyLabel: 'Q',
      name: 'Smoke Dome',
      shortTag: 'SMOKE',
      cooldownSec: 12.0,
      description: '4.2m vision-blocking hollow sphere',
    },
    e: {
      slot: 'e',
      keyLabel: 'E',
      name: 'Cryo Field',
      shortTag: 'SLOW',
      cooldownSec: 10.0,
      description: '4.5m cryo zone (70% target slow)',
    },
  },
  green: {
    q: {
      slot: 'q',
      keyLabel: 'Q',
      name: 'Pop-Flash',
      shortTag: 'FLASH',
      cooldownSec: 9.0,
      description: 'Wall-bounce 0.65s fuse LoS flashbang',
    },
    e: {
      slot: 'e',
      keyLabel: 'E',
      name: 'Bio-Stim',
      shortTag: 'STIM',
      cooldownSec: 12.0,
      description: '+20 HP/s heal + 1.28x combat stim',
    },
  },
};
