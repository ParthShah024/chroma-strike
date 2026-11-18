import * as THREE from 'three';
import {
  AGENT_ORDER,
  AGENT_PALETTES,
  AbilityFrameFeedback,
  AbilityHudSlotState,
  AgentColorId,
  AiDifficulty,
  InputState,
  MatchHudState,
  MovementModifiers,
  RoundPhase,
  SpikeHudState,
  TacticalSide,
  WeaponId,
} from './core/types';
import {
  EYE_HEIGHT,
  createInitialPlayerState,
  getHorizontalSpeed,
  getLookDirection,
  raycastAABB,
  updatePlayerMovement,
} from './physics/movement';
import {
  ARENA_COLLIDERS,
  PLAYER_SPAWN,
  buildArenaScene,
  getArenaSpawns,
} from './arena/map';
import { WEAPON_SPECS } from './combat/arsenal';
import { createWeaponSystem } from './combat/weapons';
import { createAbilitySystem } from './abilities/system';
import { createSoundEngine } from './audio/sfx';
import { createMatchManager } from './match/roundManager';
import { createCrosshairController } from './ui/crosshair';
import { createAgentSelectController } from './ui/agentSelect';
import { createBuyMenuController } from './ui/buyMenu';
import { createMinimapController } from './ui/minimap';
import {
  createMapEditorController,
  loadSavedCustomMapGrid,
} from './ui/mapEditor';

/**
 * Clamp a number between min and max.
 * Used to keep camera pitch within [-1.48, 1.48] radians (~±85°)
 * so looking straight up or down never flips the camera upside down.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// 1. Three.js Renderer, Scene & Perspective Camera Setup
// ---------------------------------------------------------------------------
const BASE_FOV_DEG = 75;
const BASE_MOUSE_SENSITIVITY = 0.0022;

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  BASE_FOV_DEG,
  window.innerWidth / window.innerHeight,
  0.1,
  150
);
// Tight near plane so first-person viewmodels and low slide-cam geometry never clip.
camera.near = 0.05;
camera.updateProjectionMatrix();
// YXZ Euler order applies yaw (around world Y) before pitch (around local X),
// preventing camera roll/tilt when looking diagonally in an FPS.
camera.rotation.order = 'YXZ';
// Crucial: add the camera to the scene so child meshes attached to it
// (such as our first-person weapon viewmodels) are rendered!
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  frozenDrawn = false; // resizing clears the canvas: redraw the frozen backdrop once
});

// ---------------------------------------------------------------------------
// 2. Arena, Match Manager, Arsenal, Abilities, Crosshair, Map Maker & Audio
// ---------------------------------------------------------------------------
buildArenaScene(scene, loadSavedCustomMapGrid() ?? undefined);

const player = createInitialPlayerState(PLAYER_SPAWN);
const sfx = createSoundEngine();
const weapon = createWeaponSystem(camera, scene, player.colorId);
const abilities = createAbilitySystem(scene);
const match = createMatchManager(scene, abilities, weapon, sfx);
const crosshair = createCrosshairController();
const minimap = createMinimapController();

// While Agent Select is up (or before the very first LOCK IN) the simulation is frozen
// and the main scene is drawn only once (`frozenDrawn`), so the stage owns the GPU.
let frozenDrawn = false;
let gameStarted = false;

const INPUT_BUFFER_SEC = 0.14;
let jumpHeld = false;
let jumpBufferTimer = 0;
let fireBufferTimer = 0;
let eyeOffsetSmoothed = 0;
let slideTiltSmoothed = 0;
let interactHeld = false;
let dropSpikePressed = false;
let unownedHintTimer = 0;

let lastAbilityFeedback: AbilityFrameFeedback | null = null;
let thirdPerson = false;
let lastHudPhase: RoundPhase = 'buy';
let lastRoundNumber = 1;
let lastPlayerSide: TacticalSide = 'attacker';
let lastSpikeHud: SpikeHudState | null = null;

// Plain input snapshot polled each simulation tick.
const input: InputState = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  walk: false,
  jump: false,
  fire: false,
  fireJustPressed: false,
  ads: false,
  reload: false,
  interact: false,
  dropSpike: false,
  yaw: 0,
  pitch: 0,
};

// ---------------------------------------------------------------------------
// 3. HUD DOM References & State Helpers
// ---------------------------------------------------------------------------
const overlayEl = document.getElementById('overlay') as HTMLDivElement;
const openXhairFromOverlayBtn = document.getElementById(
  'open-xhair-from-overlay'
) as HTMLButtonElement;
const openMapFromOverlayBtn = document.getElementById(
  'open-map-from-overlay'
) as HTMLButtonElement;
const screenFxEl = document.getElementById('screen-fx') as HTMLDivElement;
const scopeOverlayEl = document.getElementById('scope-overlay') as HTMLDivElement;
const crosshairEl = document.getElementById('crosshair') as HTMLDivElement;
const headshotRingEl = document.getElementById('headshot-ring') as HTMLDivElement;

const allyScoreEl = document.getElementById('ally-score') as HTMLDivElement;
const enemyScoreEl = document.getElementById('enemy-score') as HTMLDivElement;
const hudTopEl = document.getElementById('hud-top') as HTMLDivElement;
const sideBadgeEl = document.getElementById('side-badge') as HTMLDivElement;
const spikeTopPillEl = document.getElementById('spike-top-pill') as HTMLDivElement;
const spikeTopSiteEl = document.getElementById('spike-top-site') as HTMLSpanElement;
const roundPhaseLabelEl = document.getElementById('round-phase-label') as HTMLDivElement;
const roundClockEl = document.getElementById('round-clock') as HTMLDivElement;
const allyDotsEl = document.getElementById('ally-dots') as HTMLDivElement;
const enemyDotsEl = document.getElementById('enemy-dots') as HTMLDivElement;

const killfeedEl = document.getElementById('killfeed') as HTMLDivElement;
const roundBannerEl = document.getElementById('round-banner') as HTMLDivElement;
const roundBannerTitleEl = document.getElementById('round-banner-title') as HTMLDivElement;
const roundBannerSubEl = document.getElementById('round-banner-sub') as HTMLDivElement;
const spikeInteractHudEl = document.getElementById('spike-interact-hud') as HTMLDivElement;
const spikeInteractLabelEl = document.getElementById('spike-interact-label') as HTMLDivElement;
const spikeProgressTrackEl = document.getElementById('spike-progress-track') as HTMLDivElement;
const spikeProgressFillEl = document.getElementById('spike-progress-fill') as HTMLDivElement;
const spikeHalfwayNotchEl = document.getElementById('spike-halfway-notch') as HTMLDivElement;
const spikeHalfwayTagEl = document.getElementById('spike-halfway-tag') as HTMLDivElement;

const creditsEl = document.getElementById('hud-credits') as HTMLDivElement;
const armorEl = document.getElementById('hud-armor') as HTMLDivElement;
const hpEl = document.getElementById('hud-hp') as HTMLDivElement;
const spikeBadgeEl = document.getElementById('hud-spike-badge') as HTMLDivElement;
const abilityQEl = document.getElementById('ability-q') as HTMLDivElement;
const abilityEEl = document.getElementById('ability-e') as HTMLDivElement;
const ammoEl = document.getElementById('hud-ammo') as HTMLDivElement;
const speedEl = document.getElementById('hud-speed') as HTMLDivElement;
const hintBuyEl = document.getElementById('hint-buy') as HTMLDivElement;
const hint3pEl = document.getElementById('hint-3p') as HTMLDivElement;
const hintXhairEl = document.getElementById('hint-xhair') as HTMLDivElement;
const hintMapEl = document.getElementById('hint-map') as HTMLDivElement;
const hintAgentsEl = document.getElementById('hint-agents') as HTMLDivElement;
const damageArcEl = document.getElementById('damage-arc') as HTMLDivElement;
const killMedalEl = document.getElementById('kill-medal') as HTMLDivElement;
const killMedalTitleEl = document.getElementById('kill-medal-title') as HTMLDivElement;
const killMedalStreakEl = document.getElementById('kill-medal-streak') as HTMLDivElement;
const controlStripEl = document.getElementById('control-strip') as HTMLDivElement;

const agentPills = Array.from(document.querySelectorAll<HTMLDivElement>('.pill'));
const weaponPills = Array.from(document.querySelectorAll<HTMLDivElement>('.wpn-pill'));

let headshotFlashTimer = 0;

function switchAgentColor(colorId: AgentColorId): void {
  player.colorId = colorId;
  weapon.setAgentColor(colorId);
  document.documentElement.style.setProperty('--accent', AGENT_PALETTES[colorId].css);

  for (const pill of agentPills) {
    pill.classList.toggle('active', pill.dataset.color === colorId);
  }
}

function syncWeaponPills(weaponId: WeaponId): void {
  const ownedPrimary = match.getPlayerOwnedPrimary();
  for (const pill of weaponPills) {
    const wpn = pill.dataset.weapon as WeaponId | undefined;
    const isOwned = wpn === 'pistol' || wpn === ownedPrimary;
    pill.classList.toggle('active', wpn === weaponId);
    pill.classList.toggle('unowned', !isOwned);
  }
}

function tryEquipOwnedWeapon(weaponId: WeaponId): void {
  if (!isPointerLocked() || isAnyModalOpen() || !match.getPlayerCombatant().alive) return;
  if (weaponId !== 'pistol' && match.getPlayerOwnedPrimary() !== weaponId) {
    sfx.playBuyError();
    if (lastHudPhase === 'buy') {
      unownedHintTimer = 1.4;
    }
    return;
  }
  weapon.equipWeapon(weaponId);
  input.ads = weapon.isScoped;
  syncWeaponPills(weapon.currentWeaponId);
}

function syncLocalPlayerFromCombatant(): void {
  const c = match.getPlayerCombatant();
  player.position.x = c.position.x;
  player.position.y = c.position.y;
  player.position.z = c.position.z;
  player.velocity.x = c.velocity.x;
  player.velocity.y = c.velocity.y;
  player.velocity.z = c.velocity.z;
  player.grounded = c.grounded;
  player.health = c.health;
  player.maxHealth = c.maxHealth;
  player.colorId = c.colorId;
  input.yaw = c.yaw;
  input.pitch = c.pitch;

  switchAgentColor(c.colorId);
  lastPlayerSide = match.getPlayerSide();
  if (weapon.currentWeaponId !== c.weaponId) {
    weapon.equipWeapon(c.weaponId);
  }
  syncWeaponPills(weapon.currentWeaponId);
}

// Initialize local player state and HUD accent to match the starting combatant.
syncLocalPlayerFromCombatant();

const mapEditor = createMapEditorController(scene, () => {
  match.onMapRebuilt();
  syncLocalPlayerFromCombatant();
});

// ---------------------------------------------------------------------------
// 4. Pointer Lock, Mouse Look (Focal-Length Zoom Scaling) & Input Bindings
// ---------------------------------------------------------------------------
function isPointerLocked(): boolean {
  return document.pointerLockElement === canvas;
}

function isAnyModalOpen(): boolean {
  return crosshair.isOpen() || mapEditor.isOpen() || agentSelect.isOpen() || buyMenu.isOpen();
}

function syncOverlayVisibility(): void {
  // Keep `#overlay` (Pause / Resume) hidden while playing (pointer locked) OR in any modal.
  overlayEl.classList.toggle('hidden', isPointerLocked() || isAnyModalOpen());
  hintBuyEl.classList.toggle('active', buyMenu.isOpen());
  hintXhairEl.classList.toggle('active', crosshair.isOpen());
  hintMapEl.classList.toggle('active', mapEditor.isOpen());
  hintAgentsEl.classList.toggle('active', agentSelect.isOpen());
}

function clearHeldInputs(): void {
  input.forward = false;
  input.backward = false;
  input.left = false;
  input.right = false;
  input.walk = false;
  input.jump = false;
  input.fire = false;
  input.fireJustPressed = false;
  input.reload = false;
  input.interact = false;
  input.dropSpike = false;
  interactHeld = false;
  dropSpikePressed = false;
  jumpHeld = false;
  jumpBufferTimer = 0;
  fireBufferTimer = 0;
}

/** Opens Buyout Shop (releases pointer so cursor can click weapons/shields). */
function openBuyMenu(): void {
  if (lastHudPhase !== 'buy') return;
  if (isPointerLocked()) document.exitPointerLock();
  clearHeldInputs();
  crosshair.close();
  mapEditor.close();
  buyMenu.open();
  syncOverlayVisibility();
}

/** Opens Agent Select (releases the pointer so the cursor can click cards). */
function openAgentSelect(): void {
  if (isPointerLocked()) document.exitPointerLock();
  clearHeldInputs();
  frozenDrawn = false;
  agentSelect.open(match.getPlayerCombatant().colorId);
  buyMenu.close();
  crosshair.close();
  mapEditor.close();
  syncOverlayVisibility();
}

const buyMenu = createBuyMenuController({
  getCurrentWeaponId: () => weapon.currentWeaponId,
  getOwnedPrimary: () => match.getPlayerOwnedPrimary(),
  onBuyWeapon: (weaponId: WeaponId) => {
    const ok = match.buyWeapon(weaponId);
    if (ok) {
      input.ads = weapon.isScoped;
      syncWeaponPills(weapon.currentWeaponId);
    }
    return ok;
  },
  onRefundWeapon: () => {
    const ok = match.refundCurrentRoundWeapon();
    if (ok) {
      input.ads = weapon.isScoped;
      syncWeaponPills(weapon.currentWeaponId);
    }
    return ok;
  },
  onBuyShield: (tier) => match.buyShield(tier),
  onOpenAgentSelect: () => {
    openAgentSelect();
  },
  onSwapSides: () => {
    match.swapSides();
    syncLocalPlayerFromCombatant();
  },
  onClose: () => {
    syncOverlayVisibility();
    if (!isAnyModalOpen()) {
      canvas.requestPointerLock();
    }
  },
});

const agentSelect = createAgentSelectController({
  getCurrentAgent: () => match.getPlayerCombatant().colorId,
  canDismiss: () => gameStarted,
  onDifficultyChange: (diff: AiDifficulty) => {
    match.setDifficulty(diff);
  },
  onClose: () => {
    syncOverlayVisibility();
  },
  onLockIn: (colorId: AgentColorId, diff: AiDifficulty) => {
    sfx.unlock();
    sfx.playUiLockIn();
    match.setDifficulty(diff);
    match.selectPlayerAgent(colorId);
    syncLocalPlayerFromCombatant();
    gameStarted = true;
    frozenDrawn = false;
    syncOverlayVisibility();
    // LOCK IN is a user gesture (click / Enter): lock the pointer and start immediately.
    canvas.requestPointerLock();
  },
});
match.setDifficulty(agentSelect.getDifficulty());
// Launch straight into Agent Select (the plain `#overlay` stays a Pause/Resume menu on [Esc]).
agentSelect.open(match.getPlayerCombatant().colorId);
syncOverlayVisibility();

crosshair.setOnClose(() => {
  syncOverlayVisibility();
  if (!isAnyModalOpen()) {
    canvas.requestPointerLock();
  }
});

mapEditor.setOnClose(() => {
  syncOverlayVisibility();
  if (!isAnyModalOpen()) {
    canvas.requestPointerLock();
  }
});

overlayEl.addEventListener('click', () => {
  if (isAnyModalOpen()) return;
  sfx.unlock();
  canvas.requestPointerLock();
});

openXhairFromOverlayBtn.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  sfx.unlock();
  crosshair.open();
  syncOverlayVisibility();
});

openMapFromOverlayBtn.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  sfx.unlock();
  mapEditor.open();
  syncOverlayVisibility();
});

canvas.addEventListener('click', () => {
  if (isAnyModalOpen()) return;
  sfx.unlock();
  if (!isPointerLocked()) {
    canvas.requestPointerLock();
  }
});

document.addEventListener('pointerlockchange', () => {
  const locked = isPointerLocked();
  syncOverlayVisibility();

  // Clear held movement/fire inputs when unlocking so keys never get stuck.
  if (!locked) {
    clearHeldInputs();
  }
});

document.addEventListener('mousemove', (e: MouseEvent) => {
  if (!isPointerLocked() || isAnyModalOpen()) return;

  /**
   * Focal-Length Zoomed Mouse Sensitivity Scaling:
   * In a perspective projection, screen-space distance from center for angle θ is
   * proportional to tan(θ) / tan(fov / 2). Therefore, to keep a 1-pixel mouse
   * delta moving the world by the exact same number of screen pixels at 24° Sniper
   * zoom as at 75° hipfire (1:1 focal-length sensitivity), we scale angular mouse
   * sensitivity by:
   *     tan(camera.fov * π / 360) / tan(75° * π / 360)
   * Note that `fov * π / 360` is `(fov / 2)` converted from degrees to radians.
   */
  const adsFov = WEAPON_SPECS[weapon.currentWeaponId].adsFovDeg;
  const zoomScale =
    weapon.isScoped && adsFov !== null
      ? Math.tan((camera.fov * Math.PI) / 360) /
        Math.tan((BASE_FOV_DEG * Math.PI) / 360)
      : 1.0;

  const sens = BASE_MOUSE_SENSITIVITY * zoomScale;
  input.yaw -= e.movementX * sens;
  input.pitch = clamp(input.pitch - e.movementY * sens, -1.48, 1.48);
});

window.addEventListener('contextmenu', (e: MouseEvent) => {
  e.preventDefault();
});

window.addEventListener('mousedown', (e: MouseEvent) => {
  if (!isPointerLocked() || isAnyModalOpen()) return;
  sfx.unlock();

  if (e.button === 0) {
    input.fire = true;
    input.fireJustPressed = true;
    fireBufferTimer = INPUT_BUFFER_SEC; // 140ms semi-auto fire buffer
  } else if (e.button === 2) {
    if (match.getPlayerCombatant().alive) {
      weapon.toggleScope();
      input.ads = weapon.isScoped;
    }
  }
});

window.addEventListener('mouseup', (e: MouseEvent) => {
  if (e.button === 0) {
    input.fire = false;
  }
});

window.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    if (!isPointerLocked() || isAnyModalOpen()) return;
    if (!match.getPlayerCombatant().alive) return;
    const dir = Math.sign(e.deltaY);
    if (dir !== 0) {
      const ownedPrimary = match.getPlayerOwnedPrimary();
      if (ownedPrimary) {
        const nextWeapon: WeaponId =
          weapon.currentWeaponId === 'pistol' ? ownedPrimary : 'pistol';
        weapon.equipWeapon(nextWeapon);
        input.ads = weapon.isScoped;
        syncWeaponPills(weapon.currentWeaponId);
      }
    }
  },
  { passive: true }
);

function handleKey(code: string, isDown: boolean): void {
  switch (code) {
    case 'KeyW':
      input.forward = isDown;
      break;
    case 'KeyS':
      input.backward = isDown;
      break;
    case 'KeyA':
      input.left = isDown;
      break;
    case 'KeyD':
      input.right = isDown;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      input.walk = isDown;
      break;
    case 'Space':
      jumpHeld = isDown;
      input.jump = isDown;
      if (isDown) jumpBufferTimer = INPUT_BUFFER_SEC; // 140ms jump buffer
      break;
    case 'KeyR':
      input.reload = isDown;
      break;
    case 'KeyF':
      interactHeld = isDown;
      input.interact = isDown;
      break;
    case 'Digit1':
      if (isDown) tryEquipOwnedWeapon('pistol');
      break;
    case 'Digit2':
      if (isDown) tryEquipOwnedWeapon('smg');
      break;
    case 'Digit3':
      if (isDown) tryEquipOwnedWeapon('ar');
      break;
    case 'Digit4':
      if (isDown) tryEquipOwnedWeapon('sniper');
      break;
  }
}

window.addEventListener('keydown', (e: KeyboardEvent) => {
  sfx.unlock();

  // Keys already consumed by Agent Select / Buy Menu never reach gameplay.
  if (e.defaultPrevented) return;

  if (
    e.code === 'Space' ||
    e.code === 'Tab' ||
    e.code === 'F1' ||
    e.code === 'F2' ||
    e.code === 'F3' ||
    e.code === 'F4' ||
    e.code === 'F5'
  ) {
    e.preventDefault();
  }

  if (agentSelect.isOpen()) {
    // [H] closes Agent Select again; [B] hops back to Buyout Shop during Buy phase.
    if (e.code === 'KeyH' && !e.repeat && gameStarted) {
      agentSelect.close();
      canvas.requestPointerLock();
    } else if (e.code === 'KeyB' && !e.repeat && gameStarted && lastHudPhase === 'buy') {
      agentSelect.close();
      openBuyMenu();
    }
    return;
  }

  if (!e.repeat) {
    // [B] opens/closes Buyout Shop during the Buy phase (never overlaps Crosshair/MapMaker).
    if (
      e.code === 'KeyB' &&
      gameStarted &&
      lastHudPhase === 'buy' &&
      !crosshair.isOpen() &&
      !mapEditor.isOpen()
    ) {
      if (buyMenu.isOpen()) buyMenu.close();
      else openBuyMenu();
      return;
    }

    // [H] opens 3D Agent Select during the Buy phase.
    if (
      e.code === 'KeyH' &&
      gameStarted &&
      lastHudPhase === 'buy' &&
      !crosshair.isOpen() &&
      !mapEditor.isOpen() &&
      !buyMenu.isOpen()
    ) {
      openAgentSelect();
      return;
    }

    // [C] Crosshair Customizer modal toggle
    if (e.code === 'KeyC') {
      const wasMapOpen = mapEditor.isOpen();
      const wasBuyOpen = buyMenu.isOpen();
      const nowOpen = crosshair.toggle();
      if (wasMapOpen) mapEditor.close();
      if (wasBuyOpen) buyMenu.close();
      if (nowOpen && isPointerLocked()) {
        document.exitPointerLock();
      }
      syncOverlayVisibility();
      return;
    }

    // [M] Killhouse Map Maker modal toggle
    if (e.code === 'KeyM') {
      const wasCrosshairOpen = crosshair.isOpen();
      const wasBuyOpen = buyMenu.isOpen();
      const nowOpen = mapEditor.toggle();
      if (wasCrosshairOpen) crosshair.close();
      if (wasBuyOpen) buyMenu.close();
      if (nowOpen && isPointerLocked()) {
        document.exitPointerLock();
      }
      syncOverlayVisibility();
      return;
    }

    if (e.code === 'Escape' && isAnyModalOpen()) {
      crosshair.close();
      mapEditor.close();
      buyMenu.close();
      syncOverlayVisibility();
      return;
    }

    if (isAnyModalOpen()) {
      return;
    }

    // [F1..F5] Switch active Agent (Blaze, Mist, Pulse, Umbra, Volt)
    const fKey = /^F([1-5])$/.exec(e.code);
    if (fKey) {
      const targetColor = AGENT_ORDER[Number(fKey[1]) - 1];
      match.selectPlayerAgent(targetColor);
      syncLocalPlayerFromCombatant();
      return;
    }

    // [Tab] Take over a living ally bot after player death
    if (e.code === 'Tab') {
      if (!match.getPlayerCombatant().alive) {
        const taken = match.tryTakeoverAlly();
        if (taken) {
          syncLocalPlayerFromCombatant();
        }
      }
      return;
    }

    // [Enter] Restart match once 'match_over' is reached
    if (e.code === 'Enter' && lastHudPhase === 'match_over') {
      match.restartMatch();
      syncLocalPlayerFromCombatant();
      openAgentSelect(); // fresh draft: pick your agent for the new match
      return;
    }

    if (isPointerLocked()) {
      // [G] Drop carried Spike
      if (e.code === 'KeyG') {
        dropSpikePressed = true;
      }

      // [V] Toggle 1st-Person vs 3rd-Person over-the-shoulder camera
      if (e.code === 'KeyV') {
        thirdPerson = !thirdPerson;
        match.setThirdPersonMode(thirdPerson);
        weapon.setViewmodelVisible(!thirdPerson && match.getPlayerCombatant().alive);
        hint3pEl.classList.toggle('active', thirdPerson);
      }

      // [Space] during Buy phase skips buy countdown cleanly
      if (e.code === 'Space' && lastHudPhase === 'buy') {
        match.skipBuyPhase();
      }

      // [Q] / [E] Cast tactical abilities when alive
      if (match.getPlayerCombatant().alive) {
        if (e.code === 'KeyQ') {
          abilities.cast('q', player, input);
        } else if (e.code === 'KeyE') {
          abilities.cast('e', player, input);
        }
      }
    }
  }

  handleKey(e.code, true);
});

window.addEventListener('keyup', (e: KeyboardEvent) => {
  handleKey(e.code, false);
});

// ---------------------------------------------------------------------------
// 5. Ability, Screen FX & Match HUD Render Helpers
// ---------------------------------------------------------------------------
function syncAbilitySlot(
  el: HTMLDivElement,
  keyLabel: 'Q' | 'E',
  slot: AbilityHudSlotState
): void {
  const activeTimer = slot.activeTimer ?? 0;
  el.classList.toggle('ready', slot.ready);
  el.classList.toggle('active-fx', activeTimer > 0);
  const pct = slot.ready
    ? 100
    : clamp((1 - slot.cooldownRemaining / Math.max(slot.cooldownTotal, 0.001)) * 100, 0, 100);
  el.style.setProperty('--cd-pct', `${pct.toFixed(1)}%`);

  // Multi-charge pill (e.g. Umbra's 2/2 Void Shroud) or active-duration timer (Volt Overdrive).
  let extra = '';
  if ((slot.maxCharges ?? 0) > 1) {
    extra = `<span class="ab-charges" id="${el.id}-charges">${slot.charges ?? 0}/${slot.maxCharges}</span>`;
  } else if (activeTimer > 0) {
    extra = `<span class="ab-charges timer" id="${el.id}-charges">${activeTimer.toFixed(1)}s</span>`;
  }

  const label = slot.ready ? slot.shortTag : `${slot.cooldownRemaining.toFixed(1)}s`;
  const html = `<span class="ab-key">[${keyLabel}]</span>${label}${extra}`;
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

function syncScreenFx(feedback: AbilityFrameFeedback): void {
  const layers: string[] = [];

  if (feedback.flashAlpha > 0.001) {
    const a = clamp(feedback.flashAlpha, 0, 1).toFixed(3);
    layers.push(`linear-gradient(rgba(242, 255, 248, ${a}), rgba(242, 255, 248, ${a}))`);
  }

  if (feedback.insideSmokeFactor > 0.001) {
    const a = clamp(feedback.insideSmokeFactor, 0, 0.98).toFixed(3);
    layers.push(`linear-gradient(rgba(8, 38, 54, ${a}), rgba(8, 38, 54, ${a}))`);
  }

  if (feedback.dashAlpha > 0.001) {
    const a = clamp(feedback.dashAlpha * 0.38, 0, 0.45).toFixed(3);
    layers.push(`radial-gradient(circle at center, transparent 52%, rgba(255, 59, 92, ${a}) 100%)`);
  }

  // Volt Overdrive: electric purple -> gold edge vignette.
  if (feedback.overdriveAlpha > 0.001) {
    const a = clamp(feedback.overdriveAlpha, 0, 1);
    layers.push(
      `radial-gradient(circle at center, transparent 46%, rgba(168, 85, 247, ${(a * 0.26).toFixed(3)}) 76%, rgba(250, 204, 21, ${(a * 0.42).toFixed(3)}) 100%)`
    );
  }

  // Relay Shock concussion: washed-out gold-white shimmer.
  if (feedback.concussAlpha > 0.001) {
    const a = clamp(feedback.concussAlpha, 0, 1);
    layers.push(
      `radial-gradient(circle at center, rgba(255, 244, 190, ${(a * 0.1).toFixed(3)}) 0%, rgba(250, 204, 21, ${(a * 0.34).toFixed(3)}) 100%)`
    );
  }

  if (feedback.stimActive) {
    layers.push('radial-gradient(circle at center, transparent 58%, rgba(46, 204, 113, 0.24) 100%)');
  }

  screenFxEl.style.background = layers.length > 0 ? layers.join(', ') : 'none';
}

function formatClock(phase: RoundPhase, timerSec: number): string {
  const safe = Math.max(0, timerSec);
  if (phase === 'combat') {
    if (safe < 10) {
      return `${safe.toFixed(1)}s`;
    }
    const mins = Math.floor(safe / 60);
    const secs = Math.floor(safe % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
  return `${safe.toFixed(1)}s`;
}

let lastKillfeedSignature = '';

/** Rebuilds the scoreboard dots whenever the drafted roster changes, then updates states. */
function syncTeamDots(
  container: HTMLDivElement,
  team: 'ally' | 'enemy',
  states: Array<{ colorId: AgentColorId; alive: boolean; isPlayer?: boolean }>
): void {
  const sig = states.map((s) => s.colorId).join('|');
  if (container.dataset.sig !== sig) {
    container.dataset.sig = sig;
    container.replaceChildren();
    for (const st of states) {
      const dot = document.createElement('div');
      dot.className = 'agent-dot';
      dot.dataset.team = team;
      dot.dataset.color = st.colorId;
      dot.title = `${team === 'ally' ? 'Ally' : 'Enemy'} ${AGENT_PALETTES[st.colorId].name}`;
      container.appendChild(dot);
    }
  }
  const dots = container.children;
  for (let i = 0; i < dots.length && i < states.length; i++) {
    dots[i].classList.toggle('dead', !states[i].alive);
    dots[i].classList.toggle('is-player', Boolean(states[i].isPlayer));
  }
}

// --- Elimination medal & directional damage arc ---
const ARC_FADE_SEC = 0.9;
const MULTI_KILL_WINDOW_MS = 4000;
let lastSeenKillId = 0;
let playerKillTimes: number[] = [];
let lastDamageSeqSeen = 0;
let damageArcAngleRad = 0;
let damageArcTimer = 0;
let combatSecondsPlayed = 0;

function triggerKillMedal(headshot: boolean, streak: number): void {
  killMedalTitleEl.textContent = headshot ? 'HEADSHOT' : 'ELIMINATED';
  killMedalStreakEl.textContent = streak >= 2 ? `x${streak}` : '';
  killMedalEl.classList.toggle('headshot', headshot);
  killMedalEl.classList.remove('show');
  void killMedalEl.offsetWidth; // restart the CSS pop animation
  killMedalEl.classList.add('show');
}

function syncKillMedal(hud: MatchHudState): void {
  const fresh = hud.killFeed.filter((k) => k.id > lastSeenKillId).sort((a, b) => a.id - b.id);
  for (const k of fresh) {
    lastSeenKillId = Math.max(lastSeenKillId, k.id);
    if (k.killerName !== 'YOU' || k.killerTeam !== 'ally') continue;
    const now = performance.now();
    playerKillTimes = playerKillTimes.filter((ts) => now - ts <= MULTI_KILL_WINDOW_MS);
    playerKillTimes.push(now);
    triggerKillMedal(k.headshot, playerKillTimes.length);
  }
}

function syncDamageArc(hud: MatchHudState, dt: number, health: number): void {
  const seq = hud.lastDamageSeq ?? 0;
  if (seq !== lastDamageSeqSeen) {
    lastDamageSeqSeen = seq;
    if (hud.lastDamageAngleRad != null) {
      damageArcAngleRad = hud.lastDamageAngleRad;
      damageArcTimer = ARC_FADE_SEC;
    }
  }
  if (damageArcTimer > 0) {
    damageArcTimer = Math.max(0, damageArcTimer - dt);
    // Camera forward angle in the same atan2(x, z) convention is (yaw + PI); the wedge sits at
    // 12 o'clock for "ahead" and sweeps clockwise toward the attacker as they move to the right.
    const rotDeg = ((input.yaw + Math.PI - damageArcAngleRad) * 180) / Math.PI;
    const life = damageArcTimer / ARC_FADE_SEC;
    damageArcEl.style.setProperty('--arc-rot', `${rotDeg.toFixed(1)}deg`);
    damageArcEl.style.opacity = (life * life * 0.4 + life * 0.6).toFixed(3);
    damageArcEl.classList.toggle('critical', health < 30);
  } else if (damageArcEl.style.opacity !== '0') {
    damageArcEl.style.opacity = '0';
  }
}

function syncSpikeAndEconomyHud(hud: MatchHudState): void {
  const side = hud.playerSide ?? 'attacker';
  sideBadgeEl.textContent = side === 'attacker' ? 'ATK' : 'DEF';
  sideBadgeEl.classList.toggle('atk', side === 'attacker');
  sideBadgeEl.classList.toggle('def', side === 'defender');

  const spike = hud.spike;
  const planted = spike?.status === 'planted';
  hudTopEl.classList.toggle('spike-planted', Boolean(planted));
  spikeTopPillEl.classList.toggle('hidden', !planted);
  if (planted && spike?.plantedSite) {
    spikeTopSiteEl.textContent = `SITE ${spike.plantedSite}`;
  }

  const credits = hud.credits ?? 0;
  const armor = hud.armor ?? 0;
  creditsEl.textContent = `¤ ${credits}`;
  armorEl.textContent = `🛡 ${armor}`;
  armorEl.classList.toggle('empty', armor <= 0);
  spikeBadgeEl.classList.toggle('hidden', !spike?.playerHasSpike);

  // Contextual center [F] Plant / Defuse prompt + 50% halfway checkpoint bar
  const canPlant = Boolean(
    hud.phase === 'combat' &&
      spike &&
      spike.status === 'carried' &&
      spike.playerHasSpike &&
      spike.canPlantNow !== null
  );
  const canDefuse = Boolean(
    hud.phase === 'combat' && spike && spike.status === 'planted' && spike.canDefuseNow
  );

  if (canPlant && spike) {
    const pct = Math.round(spike.plantProgress * 100);
    spikeInteractHudEl.classList.remove('hidden', 'defuse');
    spikeInteractHudEl.classList.add('plant');
    spikeInteractLabelEl.textContent =
      spike.plantProgress > 0
        ? `PLANTING SPIKE — SITE ${spike.canPlantNow} (${pct}%)`
        : `[F] PLANT SPIKE — SITE ${spike.canPlantNow}`;
    spikeProgressTrackEl.classList.toggle('hidden', spike.plantProgress <= 0);
    spikeProgressFillEl.style.width = `${(spike.plantProgress * 100).toFixed(1)}%`;
    spikeHalfwayNotchEl.classList.add('hidden');
    spikeHalfwayTagEl.classList.add('hidden');
  } else if (canDefuse && spike) {
    const pct = Math.round(spike.defuseProgress * 100);
    const activeDefuse = interactHeld && spike.defuseProgress > 0;
    spikeInteractHudEl.classList.remove('hidden', 'plant');
    spikeInteractHudEl.classList.add('defuse');
    spikeInteractLabelEl.textContent = activeDefuse
      ? `DEFUSING SPIKE (${pct}%)`
      : '[F] DEFUSE SPIKE';
    const showBar = spike.defuseProgress > 0 || spike.halfwayCheckpoint;
    spikeProgressTrackEl.classList.toggle('hidden', !showBar);
    spikeProgressFillEl.style.width = `${(spike.defuseProgress * 100).toFixed(1)}%`;
    spikeHalfwayNotchEl.classList.toggle('hidden', !showBar);
    spikeHalfwayTagEl.classList.toggle('hidden', !spike.halfwayCheckpoint);
  } else if (unownedHintTimer > 0 && hud.phase === 'buy') {
    spikeInteractHudEl.classList.remove('hidden', 'plant', 'defuse');
    spikeInteractLabelEl.textContent = 'WEAPON NOT OWNED — PRESS [B] BUY SHOP';
    spikeProgressTrackEl.classList.add('hidden');
    spikeHalfwayNotchEl.classList.add('hidden');
    spikeHalfwayTagEl.classList.add('hidden');
  } else {
    spikeInteractHudEl.classList.add('hidden');
  }
}

function syncMatchHud(hud: MatchHudState): void {
  allyScoreEl.textContent = String(hud.allyScore);
  enemyScoreEl.textContent = String(hud.enemyScore);

  const phaseText =
    hud.phase === 'buy'
      ? `ROUND ${hud.roundNumber} • BUY`
      : hud.phase === 'combat'
        ? `ROUND ${hud.roundNumber} • COMBAT`
        : hud.phase === 'round_end'
          ? `ROUND ${hud.roundNumber} • END`
          : 'MATCH OVER';
  roundPhaseLabelEl.textContent = phaseText;
  roundClockEl.textContent =
    hud.phase === 'match_over' ? 'FINAL' : formatClock(hud.phase, hud.phaseTimerSec);

  syncSpikeAndEconomyHud(hud);

  syncTeamDots(allyDotsEl, 'ally', hud.allyStates);
  syncTeamDots(enemyDotsEl, 'enemy', hud.enemyStates);

  for (const pill of agentPills) {
    const color = pill.dataset.color as AgentColorId | undefined;
    const st = hud.allyStates.find((a) => a.colorId === color);
    pill.classList.toggle('offteam', !st);
    pill.classList.toggle('dead', Boolean(st) && !st?.alive);
  }

  // Round callout & takeover banner
  if (hud.bannerTitle) {
    roundBannerEl.classList.remove('hidden');
    roundBannerTitleEl.textContent = hud.bannerTitle;
    roundBannerSubEl.textContent = hud.bannerSubtitle ?? '';
  } else if (hud.canTakeoverBot) {
    roundBannerEl.classList.remove('hidden');
    roundBannerTitleEl.textContent = 'ELIMINATED';
    roundBannerSubEl.textContent = '[TAB] TAKE OVER LIVING ALLY';
  } else {
    roundBannerEl.classList.add('hidden');
  }

  // Compact fading killfeed (only rebuild DOM when entries or quantized fade change)
  const sig = hud.killFeed
    .map((k) => `${k.id}:${Math.round(clamp(1 - Math.max(0, k.age - 3.5) / 2.5, 0.2, 1) * 20)}`)
    .join('|');
  if (sig !== lastKillfeedSignature) {
    lastKillfeedSignature = sig;
    killfeedEl.replaceChildren();
    for (const entry of hud.killFeed) {
      const row = document.createElement('div');
      row.className = 'kf-row';
      const fade = clamp(1 - Math.max(0, entry.age - 3.5) / 2.5, 0.2, 1);
      row.style.opacity = fade.toFixed(2);

      const killerSpan = document.createElement('span');
      killerSpan.textContent = entry.killerName;
      killerSpan.style.color = AGENT_PALETTES[entry.killerColor].css;

      const wpnSpan = document.createElement('span');
      wpnSpan.className = 'kf-wpn';
      wpnSpan.textContent = entry.weaponTag;

      const victimSpan = document.createElement('span');
      victimSpan.textContent = entry.victimName;
      victimSpan.style.color = AGENT_PALETTES[entry.victimColor].css;

      row.appendChild(killerSpan);
      row.appendChild(wpnSpan);
      if (entry.headshot) {
        const hsSpan = document.createElement('span');
        hsSpan.className = 'kf-hs';
        hsSpan.textContent = 'HS';
        row.appendChild(hsSpan);
      }
      row.appendChild(victimSpan);
      killfeedEl.appendChild(row);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Main Simulation & Render Loop
// ---------------------------------------------------------------------------
let lastTime = performance.now();

function tick(now: number): void {
  requestAnimationFrame(tick);

  // Clamp dt to 50ms so tab-switching or frame hitches never tunnel through walls.
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  // -------------------------------------------------------------------------
  // Frozen state: Agent Select is open (or the match has not started yet).
  // The simulation is paused, the Agent Select stage renders ONLY while open,
  // and the main scene is drawn once as a static backdrop.
  // -------------------------------------------------------------------------
  if (agentSelect.isOpen() || !gameStarted) {
    if (agentSelect.isOpen()) {
      agentSelect.render(dt);
    }
    if (!frozenDrawn) {
      const pc = match.getPlayerCombatant();
      camera.position.set(player.position.x, player.position.y + EYE_HEIGHT, player.position.z);
      camera.rotation.y = pc.yaw;
      camera.rotation.x = 0;
      camera.rotation.z = 0;
      const frozenHud = match.update(0, player, camera.position, []);
      syncMatchHud(frozenHud);
      minimap.update(frozenHud, match.combatants, player, pc.yaw);
      renderer.render(scene, camera);
      frozenDrawn = true;
    }
    input.fireJustPressed = false;
    return;
  }
  frozenDrawn = false;

  if (unownedHintTimer > 0) {
    unownedHintTimer = Math.max(0, unownedHintTimer - dt);
  }

  const playerCombatant = match.getPlayerCombatant();
  const isAlive = playerCombatant.alive;
  const activeSpec = WEAPON_SPECS[weapon.currentWeaponId];

  // 140ms input buffers: a jump pressed just before landing still fires on touchdown.
  jumpBufferTimer = Math.max(0, jumpBufferTimer - dt);
  input.jump = jumpHeld || jumpBufferTimer > 0;

  // Apply 0.25x movement speed multiplier while actively channeling Spike plant/defuse.
  const canChannelSpike = Boolean(
    lastHudPhase === 'combat' &&
      lastSpikeHud &&
      ((lastSpikeHud.status === 'carried' &&
        lastSpikeHud.playerHasSpike &&
        lastSpikeHud.canPlantNow !== null) ||
        (lastSpikeHud.status === 'planted' && lastSpikeHud.canDefuseNow))
  );
  const isChannelingSpike = Boolean(isAlive && interactHeld && canChannelSpike);

  // Combine ability movement modifiers (Dash / Cryo Slow / Overdrive) with active weapon mobility.
  const baseMove = lastAbilityFeedback?.movement;
  const moveModifiers: MovementModifiers = {
    dashActive: baseMove?.dashActive ?? false,
    dashVelocity: baseMove?.dashVelocity ?? { x: 0, y: 0, z: 0 },
    speedMultiplier:
      (baseMove?.speedMultiplier ?? 1.0) *
      activeSpec.moveSpeedMult *
      (isChannelingSpike ? 0.25 : 1.0),
    suppressJump: baseMove?.suppressJump,
    externalVelocity: baseMove?.externalVelocity,
    slideActive: baseMove?.slideActive,
  };

  // Step player movement only while alive; enforce side-aware Buy-Phase Spawn Fence.
  if (isAlive) {
    updatePlayerMovement(player, input, ARENA_COLLIDERS, dt, moveModifiers);

    if (lastHudPhase === 'buy') {
      const spawns = getArenaSpawns();
      if (lastPlayerSide === 'defender') {
        if (player.position.z > spawns.buyMaxDefenderZ) {
          player.position.z = spawns.buyMaxDefenderZ;
          if (player.velocity.z > 0) player.velocity.z = 0;
        }
      } else {
        if (player.position.z < spawns.buyMinAllyZ) {
          player.position.z = spawns.buyMinAllyZ;
          if (player.velocity.z < 0) player.velocity.z = 0;
        }
      }
      const maxBuyX = 23.0;
      if (player.position.x < -maxBuyX) {
        player.position.x = -maxBuyX;
        if (player.velocity.x < 0) player.velocity.x = 0;
      } else if (player.position.x > maxBuyX) {
        player.position.x = maxBuyX;
        if (player.velocity.x > 0) player.velocity.x = 0;
      }
    }
  } else if (weapon.isScoped) {
    // Automatically drop sniper/ADS zoom upon death so spectator camera is unobstructed.
    weapon.toggleScope(false);
    input.ads = false;
  }

  // Step abilities across all 6 combatants (projectiles, persistent zones, flashes).
  const prevHealth = player.health;
  const feedback = abilities.update(
    dt,
    player,
    input,
    ARENA_COLLIDERS,
    match.allTargetsView,
    match.combatants
  );
  lastAbilityFeedback = feedback;

  for (const ev of feedback.audioEvents) {
    sfx.playAbility(ev);
  }

  // Smooth eye-height lerp (Power-Slide camera drop) + slide tilt.
  const eyeAlpha = 1 - Math.exp(-16 * dt);
  eyeOffsetSmoothed += ((feedback.eyeHeightOffset ?? 0) - eyeOffsetSmoothed) * eyeAlpha;
  const slideTiltTarget = feedback.slideActive ? -0.038 : 0;
  slideTiltSmoothed += (slideTiltTarget - slideTiltSmoothed) * (1 - Math.exp(-14 * dt));

  // Target FOV: smooth optical zoom when scoped with an ADS-capable weapon,
  // otherwise hipfire 75° + Crimson Dash punch, or a wide 85° during Power-Slide.
  const adsFov = activeSpec.adsFovDeg;
  const targetFov =
    isAlive && weapon.isScoped && adsFov != null
      ? adsFov
      : feedback.slideActive
        ? 85
        : BASE_FOV_DEG + feedback.dashAlpha * 15;

  if (Math.abs(camera.fov - targetFov) > 0.01) {
    const alpha = 1 - Math.exp(-18 * dt);
    camera.fov += (targetFov - camera.fov) * alpha;
    if (Math.abs(camera.fov - targetFov) < 0.05) {
      camera.fov = targetFov;
    }
    camera.updateProjectionMatrix();
  }

  const effectivePitch = clamp(
    input.pitch + weapon.state.recoilAccumulator * 0.06,
    -1.48,
    1.48
  );
  camera.rotation.y = input.yaw;
  camera.rotation.x = effectivePitch;
  camera.rotation.z = slideTiltSmoothed;

  // Camera Positioning: 1st-Person vs Wall-Clamped 3rd-Person Over-the-Shoulder
  const useThirdPersonCamera = thirdPerson || !isAlive;
  weapon.setViewmodelVisible(!useThirdPersonCamera);

  if (!useThirdPersonCamera) {
    camera.position.set(
      player.position.x,
      player.position.y + EYE_HEIGHT + eyeOffsetSmoothed,
      player.position.z
    );
  } else {
    /**
     * Wall-Clamped 3rd-Person Over-the-Shoulder Camera Math:
     * 1. Construct the camera's horizontal right vector orthogonal to yaw forward:
     *    With Three.js YXZ yaw, forward = (-sin(yaw), 0, -cos(yaw)),
     *    so right = forward × up(0,1,0) = (cos(yaw), 0, -sin(yaw)).
     * 2. Place a shoulder anchor 0.48m to the right and 1.68m above feet.
     * 3. Cast a ray backward along `-lookDir` up to 2.8m against `ARENA_COLLIDERS`
     *    via `raycastAABB`. Pull the camera forward by 0.25m from any wall hit
     *    (clamped to at least 0.35m from the shoulder) so walls never occlude the player.
     */
    const rightX = Math.cos(input.yaw);
    const rightZ = -Math.sin(input.yaw);
    const anchor = {
      x: player.position.x + rightX * 0.48,
      y: player.position.y + 1.68 + eyeOffsetSmoothed,
      z: player.position.z + rightZ * 0.48,
    };

    const lookDir = getLookDirection(input.yaw, effectivePitch);
    const backDir = { x: -lookDir.x, y: -lookDir.y, z: -lookDir.z };

    let hitDist = 2.8;
    for (const box of ARENA_COLLIDERS) {
      const hit = raycastAABB(anchor, backDir, box, hitDist);
      if (hit && hit.distance < hitDist) {
        hitDist = hit.distance;
      }
    }
    const camDist = Math.max(0.35, hitDist - 0.25);
    camera.position.set(
      anchor.x + backDir.x * camDist,
      anchor.y + backDir.y * camDist,
      anchor.z + backDir.z * camDist
    );
  }

  // Step weapon cooldowns, spread, hitscan raycast & tracers (only while player is alive).
  const wasReloading = weapon.state.reloading;
  let firedThisFrame = false;

  if (isAlive) {
    // Semi-auto fire buffer: a click during cooldown/reload still fires within 140ms.
    if (fireBufferTimer > 0) input.fireJustPressed = true;

    const shot = weapon.update(
      dt,
      player,
      input,
      ARENA_COLLIDERS,
      match.enemyTargetsView,
      feedback.fireRateMultiplier,
      feedback.recoilMultiplier,
      feedback.moveSpreadMultiplier,
      feedback.eyeHeightOffset
    );
    firedThisFrame = shot.fired;
    fireBufferTimer = shot.fired ? 0 : Math.max(0, fireBufferTimer - dt);

    if (!wasReloading && weapon.state.reloading) {
      sfx.playReload();
    }

    if (shot.fired) {
      sfx.playWeaponShot(weapon.currentWeaponId, feedback.stimActive, 0);

      // Low-ammo warning click on the last few rounds of a magazine.
      const lowThreshold = Math.min(5, Math.ceil(activeSpec.maxAmmo * 0.3));
      if (weapon.state.ammo > 0 && weapon.state.ammo <= lowThreshold) {
        sfx.playLowAmmoClick();
      }

      if (shot.hitType === 'head') {
        sfx.playHeadshot();
        headshotFlashTimer = 0.16;
        crosshairEl.classList.add('headshot');
        headshotRingEl.classList.add('active');
      } else if (shot.hitType === 'body') {
        sfx.playBodyHit();
      }
    }
  } else {
    fireBufferTimer = 0;
  }

  // Push local player physics/aim/S&D state into match manager & advance 3v3 bots/round clock.
  match.syncPlayerFromPhysics(
    player,
    input.yaw,
    input.pitch,
    weapon.currentWeaponId,
    firedThisFrame,
    interactHeld,
    dropSpikePressed
  );
  dropSpikePressed = false;
  const hud = match.update(dt, player, camera.position, feedback.activeSmokes);

  // When a new round begins, snap local orientation & UI highlights cleanly to the spawned agent.
  if (hud.roundNumber !== lastRoundNumber || (lastHudPhase === 'match_over' && hud.phase === 'buy')) {
    const c = match.getPlayerCombatant();
    input.yaw = c.yaw;
    input.pitch = c.pitch;
    switchAgentColor(c.colorId);
    syncWeaponPills(weapon.currentWeaponId);
  }
  lastHudPhase = hud.phase;
  lastRoundNumber = hud.roundNumber;
  lastPlayerSide = hud.playerSide ?? 'attacker';
  lastSpikeHud = hud.spike ?? null;

  if (buyMenu.isOpen()) {
    if (hud.phase !== 'buy') {
      buyMenu.close();
    } else {
      buyMenu.sync(hud);
    }
  }
  minimap.update(hud, match.combatants, player, input.yaw);

  // Update health, abilities, screen FX, match scoreboard, killfeed & banners.
  const isHealing =
    isAlive &&
    (player.health > prevHealth + 0.0001 ||
      (feedback.stimActive && player.health < player.maxHealth));
  const isLowHp = isAlive && player.health < 40;
  hpEl.textContent = isAlive ? `${Math.ceil(player.health)} HP` : 'DEAD';
  hpEl.classList.toggle('healing', isHealing);
  hpEl.classList.toggle('low', !isHealing && isLowHp);
  hpEl.classList.toggle('dead', !isAlive);

  syncAbilitySlot(abilityQEl, 'Q', feedback.qHud);
  syncAbilitySlot(abilityEEl, 'E', feedback.eHud);
  syncScreenFx(feedback);
  syncMatchHud(hud);
  syncKillMedal(hud);
  syncDamageArc(hud, dt, player.health);

  // Beginner control strip fades after ~25s of live combat.
  if (hud.phase === 'combat') {
    combatSecondsPlayed += dt;
    if (combatSecondsPlayed > 25) controlStripEl.classList.add('faded');
  }

  // Sniper scope overlay vs CSS-variable reactive hipfire crosshair.
  const isScopedSniper =
    isAlive && weapon.isScoped && weapon.currentWeaponId === 'sniper';
  scopeOverlayEl.classList.toggle('hidden', !isScopedSniper);
  crosshair.applyFrame(
    weapon.state.currentSpread,
    AGENT_PALETTES[player.colorId].css,
    isScopedSniper
  );

  if (headshotFlashTimer > 0) {
    headshotFlashTimer -= dt;
    if (headshotFlashTimer <= 0) {
      crosshairEl.classList.remove('headshot');
      headshotRingEl.classList.remove('active');
    }
  }

  // Update horizontal speed readout (highlights when counter-strafed accurate).
  const speed = getHorizontalSpeed(player.velocity);
  speedEl.textContent = `${speed.toFixed(1)} m/s`;
  speedEl.classList.toggle('accurate', speed < 0.45 && player.grounded);

  // Update ammo readout (low / empty warning tint) and active weapon pill.
  syncWeaponPills(weapon.currentWeaponId);
  const ammoNow = weapon.state.ammo;
  const lowAmmoThreshold = Math.min(5, Math.ceil(activeSpec.maxAmmo * 0.3));
  ammoEl.classList.toggle('low', !weapon.state.reloading && ammoNow > 0 && ammoNow <= lowAmmoThreshold);
  ammoEl.classList.toggle('empty', !weapon.state.reloading && ammoNow <= 0);
  if (weapon.state.reloading) {
    ammoEl.innerHTML = `<span class="muted">RELOAD...</span>`;
  } else {
    ammoEl.innerHTML = `${ammoNow} <span class="muted">/ ${activeSpec.maxAmmo}</span>`;
  }

  renderer.render(scene, camera);

  // Clear one-frame semi-auto trigger flag at the end of the tick.
  input.fireJustPressed = false;
}

requestAnimationFrame(tick);
