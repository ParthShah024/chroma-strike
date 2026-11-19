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
      cooldownSec: 1.2,
      maxCharges: 2,
      description: 'Instant directional burst (2/round)',
    },
    e: {
      slot: 'e',
      keyLabel: 'E',
      name: 'Inferno Orb',
      shortTag: 'FIRE',
      cooldownSec: 1.2,
      maxCharges: 2,
      description: 'Bouncing molotov fire zone — 45 DPS (2/round)',
    },
    x: {
      slot: 'x',
      keyLabel: 'X',
      name: 'Inferno Overdrive',
      shortTag: 'EMPRESS',
      cooldownSec: 0,
      ultPointsRequired: 5,
      description: '8s combat frenzy: 1.35x fire rate & kills grant +1 Dash charge',
    },
  },
  blue: {
    q: {
      slot: 'q',
      keyLabel: 'Q',
      name: 'Smoke Dome',
      shortTag: 'SMOKE',
      cooldownSec: 1.2,
      maxCharges: 2,
      description: 'Map-placed opaque frost smoke dome via Tactical Tablet (2/round)',
    },
    e: {
      slot: 'e',
      keyLabel: 'E',
      name: 'Cryo Field',
      shortTag: 'SLOW',
      cooldownSec: 1.2,
      maxCharges: 2,
      description: '4.5m cryo slow zone suppressing jumps (2/round)',
    },
    x: {
      slot: 'x',
      keyLabel: 'X',
      name: 'Glacial Whiteout',
      shortTag: 'BLIZZARD',
      cooldownSec: 0,
      ultPointsRequired: 5,
      description: '8.5m freezing whiteout dome slowing & blinding sightlines',
    },
  },
  green: {
    q: {
      slot: 'q',
      keyLabel: 'Q',
      name: 'Pop-Flash',
      shortTag: 'FLASH',
      cooldownSec: 1.2,
      maxCharges: 2,
      description: 'Wall-bounce 0.65s fuse LoS flashbang (2/round)',
    },
    e: {
      slot: 'e',
      keyLabel: 'E',
      name: 'Bio-Stim',
      shortTag: 'STIM',
      cooldownSec: 1.2,
      maxCharges: 2,
      description: '+24 HP/s heal + 1.35x fire-rate stim (2/round)',
    },
    x: {
      slot: 'x',
      keyLabel: 'X',
      name: 'Orbital Recon',
      shortTag: 'SONAR',
      cooldownSec: 0,
      ultPointsRequired: 5,
      description: '3 arena-wide sonar pulses revealing all foes on Minimap',
    },
  },
  violet: {
    q: {
      slot: 'q',
      keyLabel: 'Q',
      name: 'Void Shroud',
      shortTag: 'SHROUD',
      cooldownSec: 1.2,
      maxCharges: 2,
      description: 'Map-placed opaque void smoke dome via Tactical Tablet (2/round)',
    },
    e: {
      slot: 'e',
      keyLabel: 'E',
      name: 'Singularity',
      shortTag: 'VORTEX',
      cooldownSec: 1.2,
      maxCharges: 2,
      description: 'Gravity well pulling foes inward + 1.25x Fragile (2/round)',
    },
    x: {
      slot: 'x',
      keyLabel: 'X',
      name: 'Eclipse Curtain',
      shortTag: 'ECLIPSE',
      cooldownSec: 0,
      ultPointsRequired: 5,
      description: 'Slices a 28m opaque Void Curtain wall across the map',
    },
  },
  gold: {
    q: {
      slot: 'q',
      keyLabel: 'Q',
      name: 'Overdrive Slide',
      shortTag: 'SLIDE',
      cooldownSec: 1.2,
      maxCharges: 2,
      description: '1.30x electric sprint + Shift/Q pinpoint Power-Slide (2/round)',
    },
    e: {
      slot: 'e',
      keyLabel: 'E',
      name: 'Relay Bolt',
      shortTag: 'RELAY',
      cooldownSec: 1.2,
      maxCharges: 2,
      description: '1-bounce lightning bolt creating twin concuss shockzones (2/round)',
    },
    x: {
      slot: 'x',
      keyLabel: 'X',
      name: 'Thunderstorm',
      shortTag: 'STORM',
      cooldownSec: 0,
      ultPointsRequired: 5,
      description: '7.5s high-voltage sprint, rapid slides & chain-lightning arcs',
    },
  },
  cyan: {
    q: {
      slot: 'q',
      keyLabel: 'Q',
      name: 'Updraft',
      shortTag: 'UPDRAFT',
      cooldownSec: 0.25,
      maxCharges: 2,
      description: 'Instant high-altitude wind boost — reach Heaven & high cover (2/round)',
    },
    e: {
      slot: 'e',
      keyLabel: 'E',
      name: 'Tailwind Dash',
      shortTag: 'DASH',
      cooldownSec: 0.25,
      maxCharges: 2,
      description: 'Instant directional wind dash — chains mid-air with Updraft (2/round)',
    },
    x: {
      slot: 'x',
      keyLabel: 'X',
      name: 'Blade Storm',
      shortTag: 'BLADES',
      cooldownSec: 0,
      ultPointsRequired: 5,
      description: '9s pinpoint mid-air wind blades: 0 spread, 1.30x fire rate & kills refresh Dash',
    },
  },
};
