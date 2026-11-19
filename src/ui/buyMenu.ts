import { AGENT_PALETTES, MatchHudState, ShieldTier, WeaponId } from '../core/types';
import { SHIELD_SPECS, WEAPON_ORDER, WEAPON_SPECS } from '../combat/arsenal';

export interface BuyMenuOptions {
  getCurrentWeaponId: () => WeaponId;
  getOwnedPrimary: () => WeaponId | null;
  onBuyWeapon: (weaponId: WeaponId) => boolean;
  onRefundWeapon: () => boolean;
  onBuyShield: (tier: ShieldTier) => boolean;
  onOpenAgentSelect: () => void;
  onSwapSides: () => void;
  onClose?: () => void;
}

export interface BuyMenuController {
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): boolean;
  sync(hud: MatchHudState): void;
  dispose(): void;
}

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Buy Menu: missing #${id} in index.html`);
  return el as T;
}

/**
 * Mirrors `economy.ts`'s smart delta shield pricing so the Buyout Shop UI
 * displays exact upgrade/repair costs before purchase.
 */
function computeShieldCost(
  currentArmor: number,
  currentTier: ShieldTier,
  targetTier: 'light' | 'heavy'
): number {
  const targetSpec = SHIELD_SPECS[targetTier];
  if (currentArmor >= targetSpec.armor) return 0;
  if (currentArmor <= 0) return targetSpec.cost;

  if (targetTier === 'heavy' && currentTier === 'light') {
    const lightValue = Math.round(
      (Math.min(currentArmor, SHIELD_SPECS.light.armor) / SHIELD_SPECS.light.armor) *
        SHIELD_SPECS.light.cost
    );
    return Math.max(50, Math.min(targetSpec.cost, targetSpec.cost - lightValue));
  }

  const missingRatio = (targetSpec.armor - currentArmor) / targetSpec.armor;
  return Math.max(
    50,
    Math.min(targetSpec.cost, Math.round((missingRatio * targetSpec.cost) / 10) * 10)
  );
}

/**
 * Creates the Valorant/CS-style `[B]` Tactical Buyout Shop modal controller.
 */
export function createBuyMenuController(options: BuyMenuOptions): BuyMenuController {
  const modal = requireEl<HTMLDivElement>('buy-menu-modal');
  const creditsEl = requireEl<HTMLDivElement>('buy-credits');
  const minNextEl = requireEl<HTMLDivElement>('buy-min-next');
  const lossLabelEl = requireEl<HTMLSpanElement>('buy-loss-label');
  const lossPipsEl = requireEl<HTMLDivElement>('buy-loss-pips');
  const roleBadgeEl = requireEl<HTMLDivElement>('buy-role-badge');
  const clockEl = requireEl<HTMLDivElement>('buy-clock');
  const refundBtn = requireEl<HTMLButtonElement>('buy-refund-btn');
  const squadStripEl = requireEl<HTMLDivElement>('buy-squad-strip');
  const agentBtn = requireEl<HTMLButtonElement>('buy-agent-btn');
  const swapBtn = requireEl<HTMLButtonElement>('buy-swap-btn');
  const readyBtn = requireEl<HTMLButtonElement>('buy-ready-btn');

  const weaponBtns = new Map<WeaponId, HTMLButtonElement>();
  for (const id of WEAPON_ORDER) {
    const btn = modal.querySelector<HTMLButtonElement>(`[data-buy-weapon="${id}"]`);
    if (btn) weaponBtns.set(id, btn);
  }

  const shieldBtns = new Map<'light' | 'heavy', HTMLButtonElement>();
  for (const tier of ['light', 'heavy'] as const) {
    const btn = modal.querySelector<HTMLButtonElement>(`[data-buy-shield="${tier}"]`);
    if (btn) shieldBtns.set(tier, btn);
  }

  let openState = false;
  let lastHud: MatchHudState | null = null;
  let lastSquadSignature = '';

  function open(): void {
    if (openState) return;
    openState = true;
    modal.classList.remove('hidden');
    if (lastHud) sync(lastHud);
  }

  function close(): void {
    if (!openState) return;
    openState = false;
    modal.classList.add('hidden');
    options.onClose?.();
  }

  function toggle(): boolean {
    if (openState) close();
    else open();
    return openState;
  }

  function renderSquadStrip(hud: MatchHudState): void {
    const allies = hud.allyEconomy ?? [];
    const sig = allies
      .map(
        (a) =>
          `${a.id}:${a.colorId}:${a.credits}:${a.weaponId}:${a.armor}:${a.hasSpike ? 1 : 0}`
      )
      .join('|');
    if (sig === lastSquadSignature) return;
    lastSquadSignature = sig;

    squadStripEl.replaceChildren();
    for (const ally of allies) {
      const palette = AGENT_PALETTES[ally.colorId];
      const codename = palette.name.split(' ')[0].toUpperCase();
      const wpnTag = WEAPON_SPECS[ally.weaponId].shortTag;

      const card = document.createElement('div');
      card.className = 'buy-squad-card';
      card.style.setProperty('--ally-accent', palette.css);

      const left = document.createElement('div');
      left.className = 'buy-squad-left';

      const dot = document.createElement('span');
      dot.className = 'buy-squad-dot';
      left.appendChild(dot);

      const nameEl = document.createElement('span');
      nameEl.className = 'buy-squad-name';
      nameEl.textContent = codename;
      left.appendChild(nameEl);

      if (ally.hasSpike) {
        const spikePill = document.createElement('span');
        spikePill.className = 'buy-squad-spike';
        spikePill.textContent = 'SPIKE';
        left.appendChild(spikePill);
      }

      const right = document.createElement('div');
      right.className = 'buy-squad-right';

      const wpnEl = document.createElement('span');
      wpnEl.className = 'buy-squad-wpn';
      wpnEl.textContent = wpnTag;

      const armorEl = document.createElement('span');
      armorEl.className = 'buy-squad-armor';
      armorEl.textContent = `🛡 ${ally.armor}`;

      const credEl = document.createElement('span');
      credEl.className = 'buy-squad-credits';
      credEl.textContent = `¤ ${ally.credits}`;

      right.append(wpnEl, armorEl, credEl);
      card.append(left, right);
      squadStripEl.appendChild(card);
    }
  }

  function sync(hud: MatchHudState): void {
    lastHud = hud;

    const credits = hud.credits ?? 0;
    const minNext = hud.nextRoundMinCredits ?? credits;
    const lossStreak = hud.lossStreak ?? 0;
    const side = hud.playerSide ?? 'attacker';

    creditsEl.textContent = `¤ ${credits}`;
    minNextEl.textContent = `MIN NEXT: ¤ ${minNext}`;
    lossLabelEl.textContent = `LOSS STREAK: x${lossStreak}`;

    const pips = lossPipsEl.children;
    for (let i = 0; i < pips.length; i++) {
      pips[i].classList.toggle('lit', i < lossStreak);
    }

    roleBadgeEl.textContent = side === 'attacker' ? 'ATTACKER' : 'DEFENDER';
    roleBadgeEl.classList.toggle('atk', side === 'attacker');
    roleBadgeEl.classList.toggle('def', side === 'defender');

    clockEl.textContent = `${Math.max(0, hud.phaseTimerSec).toFixed(1)}s`;

    const activeWeapon = options.getCurrentWeaponId();
    const ownedPrimary = options.getOwnedPrimary();
    const effectiveCredits =
      credits + (hud.canRefundWeapon ? hud.refundableWeaponCost ?? 0 : 0);

    for (const id of WEAPON_ORDER) {
      const btn = weaponBtns.get(id);
      if (!btn) continue;
      const spec = WEAPON_SPECS[id];
      const isEquipped = activeWeapon === id;
      const isOwned = id === 'pistol' || ownedPrimary === id;
      const canAfford = isOwned || effectiveCredits >= spec.cost;

      let statusLabel = 'BUY';
      if (isEquipped) statusLabel = 'EQUIPPED';
      else if (isOwned) statusLabel = 'OWNED';
      else if (!canAfford) statusLabel = 'LOCKED';

      btn.classList.toggle('equipped', isEquipped);
      btn.classList.toggle('owned', !isEquipped && isOwned);
      btn.classList.toggle('locked', !isEquipped && !isOwned && !canAfford);

      const costEl = btn.querySelector<HTMLElement>('.buy-item-cost');
      const stateEl = btn.querySelector<HTMLElement>('.buy-item-state');
      const metaEl = btn.querySelector<HTMLElement>('.buy-item-meta');
      if (costEl) costEl.textContent = spec.cost === 0 ? 'FREE' : `¤ ${spec.cost}`;
      if (stateEl) stateEl.textContent = statusLabel;
      if (metaEl) metaEl.textContent = `HD ${spec.headDamage} • BD ${spec.bodyDamage}`;
    }

    const canRefund = Boolean(hud.canRefundWeapon && (hud.refundableWeaponCost ?? 0) > 0);
    refundBtn.classList.toggle('hidden', !canRefund);
    if (canRefund) {
      refundBtn.textContent = `[R] REFUND (+¤${hud.refundableWeaponCost ?? 0})`;
    }

    const armor = hud.armor ?? 0;
    const shieldTier = hud.shieldTier ?? 'none';
    const boughtArmorThisRound = Boolean(hud.boughtArmorThisRound);

    for (const tier of ['light', 'heavy'] as const) {
      const btn = shieldBtns.get(tier);
      if (!btn) continue;
      const spec = SHIELD_SPECS[tier];
      const cost = computeShieldCost(armor, shieldTier, tier);
      const isActiveTier = shieldTier === tier && armor > 0;
      const isFull = isActiveTier && armor >= spec.armor;
      const blockedByOtherShield =
        (shieldTier === 'heavy' && armor > 0 && tier === 'light') ||
        (boughtArmorThisRound && !isActiveTier);
      const canAfford = credits >= cost;

      let statusLabel = tier === 'heavy' && shieldTier === 'light' ? 'UPGRADE' : 'BUY';
      let costLabel = cost === 0 ? 'FULL' : `¤ ${cost}`;
      if (blockedByOtherShield) {
        statusLabel = '1 SHIELD MAX';
        costLabel = '—';
      } else if (isActiveTier && boughtArmorThisRound) {
        statusLabel = 'REFUND';
        costLabel =
          (hud.refundableArmorCost ?? 0) > 0 ? `+¤ ${hud.refundableArmorCost}` : 'UNEQUIP';
      } else if (isFull) {
        statusLabel = 'EQUIPPED';
        costLabel = 'FULL';
      } else if (!canAfford) {
        statusLabel = 'LOCKED';
      }

      btn.disabled = blockedByOtherShield;
      btn.classList.toggle('equipped', isActiveTier);
      btn.classList.toggle(
        'locked',
        blockedByOtherShield || (!isFull && !isActiveTier && !canAfford)
      );

      const costEl = btn.querySelector<HTMLElement>('.buy-item-cost');
      const stateEl = btn.querySelector<HTMLElement>('.buy-item-state');
      if (costEl) costEl.textContent = costLabel;
      if (stateEl) stateEl.textContent = statusLabel;
    }

    renderSquadStrip(hud);
  }

  for (const id of WEAPON_ORDER) {
    weaponBtns.get(id)?.addEventListener('click', () => {
      options.onBuyWeapon(id);
    });
  }

  for (const tier of ['light', 'heavy'] as const) {
    shieldBtns.get(tier)?.addEventListener('click', () => {
      options.onBuyShield(tier);
    });
  }

  refundBtn.addEventListener('click', () => {
    options.onRefundWeapon();
  });

  agentBtn.addEventListener('click', () => {
    options.onOpenAgentSelect();
  });

  swapBtn.addEventListener('click', () => {
    options.onSwapSides();
  });

  readyBtn.addEventListener('click', () => {
    close();
  });

  function onKeyDown(e: KeyboardEvent): void {
    if (!openState) return;

    if (e.code === 'Digit1') {
      e.preventDefault();
      options.onBuyWeapon('pistol');
      return;
    }
    if (e.code === 'Digit2') {
      e.preventDefault();
      options.onBuyWeapon('smg');
      return;
    }
    if (e.code === 'Digit3') {
      e.preventDefault();
      options.onBuyWeapon('ar');
      return;
    }
    if (e.code === 'Digit4') {
      e.preventDefault();
      options.onBuyWeapon('sniper');
      return;
    }
    if (e.code === 'Digit5') {
      e.preventDefault();
      options.onBuyShield('light');
      return;
    }
    if (e.code === 'Digit6') {
      e.preventDefault();
      options.onBuyShield('heavy');
      return;
    }
    if (e.code === 'KeyR' && !e.repeat) {
      e.preventDefault();
      options.onRefundWeapon();
      return;
    }
    if (e.code === 'KeyH' && !e.repeat) {
      e.preventDefault();
      options.onOpenAgentSelect();
      return;
    }
    if (e.code === 'KeyP' && !e.repeat) {
      e.preventDefault();
      options.onSwapSides();
      return;
    }
    if ((e.code === 'KeyB' || e.code === 'Escape') && !e.repeat) {
      e.preventDefault();
      close();
    }
  }

  window.addEventListener('keydown', onKeyDown);
  modal.classList.add('hidden');

  function dispose(): void {
    window.removeEventListener('keydown', onKeyDown);
  }

  return {
    isOpen: () => openState,
    open,
    close,
    toggle,
    sync,
    dispose,
  };
}
