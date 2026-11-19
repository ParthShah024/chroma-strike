import * as THREE from 'three';
import {
  AGENT_ORDER,
  AGENT_PALETTES,
  AbilityFrameFeedback,
  AbilityHudSlotState,
  AgentColorId,
  AiDifficulty,
  GameSettings,
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
  ARENA_WIDTH_M,
  PLAYER_SPAWN,
  buildArenaScene,
  findNearbyDoorSwitch,
  getArenaDoors,
  getArenaSpawns,
  setArenaBuyBarriersVisible,
  toggleArenaDoor,
  updateArenaDoors,
} from './arena/map';
import { WEAPON_SPECS } from './combat/arsenal';
import { createWeaponSystem } from './combat/weapons';
import { AGENT_ABILITIES } from './abilities/definitions';
import { createAbilitySystem } from './abilities/system';
import { createSoundEngine } from './audio/sfx';
import { createMatchManager } from './match/roundManager';
import { createMultiplayerClient } from './net/multiplayer';
import { createCrosshairController } from './ui/crosshair';
import { createSettingsController } from './ui/settings';
import { createLobbyController } from './ui/lobby';
import { createAgentSelectController } from './ui/agentSelect';
import { createBuyMenuController } from './ui/buyMenu';
import { createMinimapController } from './ui/minimap';
import { createMapViewerController } from './ui/mapViewer';

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
const BASE_MOUSE_SENSITIVITY = 0.0022;

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  82,
  window.innerWidth / window.innerHeight,
  0.05,
  300
);
// Tight near plane so first-person viewmodels/slide-cam never clip; far=300 covers 84x92m diagonals.
camera.near = 0.05;
camera.far = 300;
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
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  frozenDrawn = false; // resizing clears the canvas: redraw the frozen backdrop once
});

// ---------------------------------------------------------------------------
// 2. Arena, Match Manager, Arsenal, Abilities, Crosshair, Map Viewer & Audio
// ---------------------------------------------------------------------------
buildArenaScene(scene);

const player = createInitialPlayerState(PLAYER_SPAWN);
const sfx = createSoundEngine();
const weapon = createWeaponSystem(camera, scene, player.colorId);
const abilities = createAbilitySystem(scene);
const match = createMatchManager(scene, abilities, weapon, sfx);
const net = createMultiplayerClient();
const crosshair = createCrosshairController();
const settings = createSettingsController();
crosshair.setModalDelegate({
  open: () => settings.open('crosshair'),
  close: () => settings.close(),
  isOpen: () => settings.isOpen(),
});
const minimap = createMinimapController();

let currentSettings: GameSettings = settings.getSettings();
let baseFovDeg = currentSettings.fovDeg;
let mouseSensMult = currentSettings.mouseSensitivity;
let adsSensMult = currentSettings.adsSensitivityMult;
let invertY = currentSettings.invertY;
let showFps = currentSettings.showFps;
let smoothedFps = 60;
let fpsLastUiMs = 0;

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
let capsHeld = false;
let unownedHintTimer = 0;

let lastAbilityFeedback: AbilityFrameFeedback | null = null;
let thirdPerson = false;
let lastHudPhase: RoundPhase = 'buy';
let lastRoundNumber = 1;
let lastPlayerSide: TacticalSide = 'attacker';
let lastSpikeHud: SpikeHudState | null = null;
let lastFrozenHud: MatchHudState | null = null;

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
const openSettingsFromOverlayBtn = document.getElementById(
  'open-settings-from-overlay'
) as HTMLButtonElement;
const openXhairFromOverlayBtn = document.getElementById(
  'open-xhair-from-overlay'
) as HTMLButtonElement;
const openMapFromOverlayBtn = document.getElementById(
  'open-map-from-overlay'
) as HTMLButtonElement;
const fpsCounterEl = document.getElementById('fps-counter') as HTMLDivElement;
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
const matchFormatLabelEl = document.getElementById('match-format-label') as HTMLDivElement;
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
const abilityXEl = document.getElementById('ability-x') as HTMLDivElement;
const ammoEl = document.getElementById('hud-ammo') as HTMLDivElement;
const speedEl = document.getElementById('hud-speed') as HTMLDivElement;
const hintBuyEl = document.getElementById('hint-buy') as HTMLDivElement;
const hint3pEl = document.getElementById('hint-3p') as HTMLDivElement;
const hintSettingsEl = document.getElementById('hint-settings') as HTMLDivElement;
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

const mapViewer = createMapViewerController(scene);

// ---------------------------------------------------------------------------
// 4. Pointer Lock, Mouse Look (Focal-Length Zoom Scaling) & Input Bindings
// ---------------------------------------------------------------------------
function isPointerLocked(): boolean {
  return document.pointerLockElement === canvas;
}

function isAnyModalOpen(): boolean {
  return (
    lobby.isOpen() ||
    settings.isOpen() ||
    crosshair.isOpen() ||
    mapViewer.isOpen() ||
    agentSelect.isOpen() ||
    buyMenu.isOpen()
  );
}

function syncOverlayVisibility(): void {
  const inFrontend = !gameStarted && (lobby.isOpen() || agentSelect.isOpen() || settings.isOpen());
  document.body.classList.toggle('in-frontend', inFrontend || !gameStarted);
  // Keep `#overlay` (Pause / Resume) hidden before game starts, while playing (pointer locked), OR in any modal.
  overlayEl.classList.toggle('hidden', !gameStarted || isPointerLocked() || isAnyModalOpen());
  hintBuyEl.classList.toggle('active', buyMenu.isOpen());
  hintSettingsEl.classList.toggle('active', settings.isOpen());
  hintXhairEl.classList.toggle('active', crosshair.isOpen());
  hintMapEl.classList.toggle('active', mapViewer.isOpen());
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
  minimap.setExpanded(false);
  settings.close();
  mapViewer.close();
  buyMenu.open();
  syncOverlayVisibility();
}

/** Opens Agent Select (releases the pointer so the cursor can click cards). */
function openAgentSelect(): void {
  if (isPointerLocked()) document.exitPointerLock();
  clearHeldInputs();
  frozenDrawn = false;
  minimap.setExpanded(false);
  settings.close();
  agentSelect.open(match.getPlayerCombatant().colorId);
  buyMenu.close();
  mapViewer.close();
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
    if (gameStarted && !isAnyModalOpen()) {
      canvas.requestPointerLock();
    }
  },
});

let syncingLobbySettings = false;

function applySettings(s: GameSettings): void {
  currentSettings = s;
  mouseSensMult = s.mouseSensitivity;
  adsSensMult = s.adsSensitivityMult;
  invertY = s.invertY;
  baseFovDeg = s.fovDeg;

  if (!weapon.isScoped && !lastAbilityFeedback?.slideActive) {
    camera.fov = baseFovDeg;
    camera.updateProjectionMatrix();
  }

  if (renderer.shadowMap.enabled !== s.shadowsEnabled) {
    renderer.shadowMap.enabled = s.shadowsEnabled;
    renderer.shadowMap.needsUpdate = true;
  }

  minimap.setRotateMode(s.minimapRotate);
  minimap.setSizePreset(s.minimapSize);
  sfx.setMasterVolume(s.masterVolume);
  sfx.setMuted(s.muted);

  showFps = s.showFps;
  fpsCounterEl.classList.toggle('hidden', !showFps);

  match.setMatchConfig({
    difficulty: s.difficulty,
    winTarget: s.winTarget,
  });

  if (!syncingLobbySettings && !gameStarted && !net.isOnline()) {
    syncingLobbySettings = true;
    net.setConfig({
      difficulty: s.difficulty,
      winTarget: s.winTarget,
    });
    syncingLobbySettings = false;
  }
}

const lobby = createLobbyController({
  initialDifficulty: currentSettings.difficulty,
  initialWinTarget: currentSettings.winTarget,
  initialSide: currentSettings.defaultSide,
  onJoinSide: (side: TacticalSide) => {
    net.switchSide(side);
  },
  onDifficultyChange: (diff: AiDifficulty) => {
    net.setConfig({ difficulty: diff });
    if (!syncingLobbySettings) {
      syncingLobbySettings = true;
      settings.applyPatch({ difficulty: diff });
      syncingLobbySettings = false;
    }
  },
  onWinTargetChange: (winTarget: 10 | 6) => {
    net.setConfig({ winTarget });
    if (!syncingLobbySettings) {
      syncingLobbySettings = true;
      settings.applyPatch({ winTarget });
      syncingLobbySettings = false;
    }
  },
  onCallsignChange: (callsign: string) => {
    if (!gameStarted) {
      net.connect(callsign);
    }
  },
  onRetryConnect: (callsign: string) => {
    net.connect(callsign);
  },
  onOpenSettings: () => {
    sfx.unlock();
    crosshair.syncControls();
    settings.open('controls');
    syncOverlayVisibility();
  },
  onStartMatch: () => {
    sfx.unlock();
    net.startAgentSelect();
  },
  onClose: () => {
    syncOverlayVisibility();
  },
});

const agentSelect = createAgentSelectController({
  getCurrentAgent: () => match.getPlayerCombatant().colorId,
  canDismiss: () => gameStarted,
  onSelectAgent: (colorId: AgentColorId) => {
    if (net.isOnline()) {
      net.selectAgent(colorId);
    }
  },
  onDifficultyChange: (diff: AiDifficulty) => {
    match.setDifficulty(diff);
    if (!gameStarted) {
      net.setConfig({ difficulty: diff });
    }
  },
  onBackToLobby: () => {
    if (gameStarted) return;
    if (!net.isOnline() || net.isHost()) {
      net.returnToLobby();
    } else {
      agentSelect.close();
      lobby.open();
      syncOverlayVisibility();
    }
  },
  onForceStart: () => {
    if (net.isOnline() && net.isHost()) {
      net.forceStartMatch();
    }
  },
  onClose: () => {
    syncOverlayVisibility();
  },
  onLockIn: (colorId: AgentColorId, diff: AiDifficulty) => {
    sfx.unlock();
    sfx.playUiLockIn();
    if (!gameStarted) {
      net.lockIn(colorId);
      return;
    }
    match.setDifficulty(diff);
    match.selectPlayerAgent(colorId);
    syncLocalPlayerFromCombatant();
    if (net.isOnline()) {
      net.selectAgent(colorId);
    }
    frozenDrawn = false;
    syncOverlayVisibility();
    canvas.requestPointerLock();
  },
});

net.onLobbyUpdate((snapshot) => {
  const localId = net.getLocalPlayerId();
  lobby.syncFromNetState(snapshot, localId);
  agentSelect.syncFromNetState(snapshot, localId);
  match.setMatchConfig({
    difficulty: snapshot.difficulty,
    winTarget: snapshot.winTarget,
  });

  if (!gameStarted) {
    if (snapshot.phase === 'agent_select' && lobby.isOpen()) {
      lobby.close();
      agentSelect.open(match.getPlayerCombatant().colorId);
    } else if (snapshot.phase === 'lobby' && agentSelect.isOpen()) {
      agentSelect.close();
      lobby.open();
    }
    syncOverlayVisibility();
  }
});

net.onMatchStart((snapshot) => {
  sfx.unlock();
  sfx.playUiLockIn();
  lobby.close();
  agentSelect.close();

  const localId = net.getLocalPlayerId();
  const localSlot = snapshot.players.find((p) => p.id === localId);
  const chosenAgent = localSlot?.agentColor ?? agentSelect.getPreviewAgent();
  const startingSide = localSlot?.side ?? lobby.getSelectedSide();

  match.startNewMatch({
    startingSide,
    playerAgent: chosenAgent,
    difficulty: snapshot.difficulty,
    winTarget: snapshot.winTarget,
    teamHumanSlots: snapshot.players,
    localPlayerId: localId,
  });
  syncLocalPlayerFromCombatant();

  gameStarted = true;
  frozenDrawn = false;
  syncOverlayVisibility();
  canvas.requestPointerLock();
});

net.onDoorEvent((ev) => {
  if (!gameStarted || ev.fromId === net.getLocalPlayerId()) return;
  const door = getArenaDoors().find((d) => d.id === ev.doorId);
  if (ev.action === 'toggle') {
    if (door && door.status !== 'broken' && ev.state && door.status !== ev.state) {
      const next = toggleArenaDoor(ev.doorId);
      if (next) sfx.playDoorToggle(next === 'closed');
    }
  } else if (ev.action === 'damage' || ev.action === 'break') {
    match.handleDoorShotHit(ev.doorId, ev.damage ?? 25);
  }
});

net.onError((err) => {
  lobby.showError(err.message);
  if (agentSelect.isOpen()) {
    agentSelect.showError(err.message);
  }
});

settings.setOnChange((s) => {
  applySettings(s);
});

settings.setOnClose(() => {
  syncOverlayVisibility();
  if (gameStarted && !isAnyModalOpen()) {
    canvas.requestPointerLock();
  }
});

// Apply persisted settings & launch into Custom Game Lobby first (`Lobby -> Agent Select -> Match`).
applySettings(currentSettings);
net.setConfig({
  difficulty: currentSettings.difficulty,
  winTarget: currentSettings.winTarget,
});
if (currentSettings.defaultSide !== 'attacker') {
  net.switchSide(currentSettings.defaultSide);
}
lobby.open();
net.connect(lobby.getCallsign());
syncOverlayVisibility();

crosshair.setOnClose(() => {
  syncOverlayVisibility();
  if (gameStarted && !isAnyModalOpen()) {
    canvas.requestPointerLock();
  }
});

mapViewer.setOnClose(() => {
  setArenaBuyBarriersVisible(lastHudPhase === 'buy');
  frozenDrawn = false;
  syncOverlayVisibility();
  if (gameStarted && !isAnyModalOpen()) {
    canvas.requestPointerLock();
  }
});

overlayEl.addEventListener('click', () => {
  if (!gameStarted || isAnyModalOpen()) return;
  sfx.unlock();
  canvas.requestPointerLock();
});

openSettingsFromOverlayBtn.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  sfx.unlock();
  minimap.setExpanded(false);
  crosshair.syncControls();
  settings.open('controls');
  syncOverlayVisibility();
});

openXhairFromOverlayBtn.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  sfx.unlock();
  minimap.setExpanded(false);
  crosshair.syncControls();
  settings.open('crosshair');
  syncOverlayVisibility();
});

openMapFromOverlayBtn.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  sfx.unlock();
  minimap.setExpanded(false);
  mapViewer.open();
  syncOverlayVisibility();
});

canvas.addEventListener('click', () => {
  if (!gameStarted || isAnyModalOpen()) return;
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
   * Focal-Length Zoomed Mouse Sensitivity Scaling + Live Settings Multiplier
   */
  const adsFov = WEAPON_SPECS[weapon.currentWeaponId].adsFovDeg;
  const isAds = weapon.isScoped && adsFov !== null;
  const zoomScale = isAds
    ? Math.tan((camera.fov * Math.PI) / 360) /
      Math.tan((baseFovDeg * Math.PI) / 360)
    : 1.0;

  const sens =
    BASE_MOUSE_SENSITIVITY *
    mouseSensMult *
    zoomScale *
    (isAds ? adsSensMult : 1.0);
  const ySign = invertY ? -1 : 1;
  input.yaw -= e.movementX * sens;
  input.pitch = clamp(input.pitch - e.movementY * sens * ySign, -1.48, 1.48);
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

  // Keys already consumed by Agent Select / Buy Menu / Callsign input never reach gameplay.
  if (e.defaultPrevented) return;
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') {
    if (e.code === 'Escape' && settings.isOpen()) {
      settings.close();
      syncOverlayVisibility();
    }
    return;
  }

  if (
    e.code === 'Space' ||
    e.code === 'Tab' ||
    e.code === 'CapsLock' ||
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
    // [O] Settings Modal toggle (Controls tab)
    if (e.code === 'KeyO') {
      minimap.setExpanded(false);
      const wasMapOpen = mapViewer.isOpen();
      const wasBuyOpen = buyMenu.isOpen();
      if (wasMapOpen) mapViewer.close();
      if (wasBuyOpen) buyMenu.close();
      crosshair.syncControls();
      const nowOpen = settings.toggle('controls');
      if (nowOpen && isPointerLocked()) {
        document.exitPointerLock();
      }
      syncOverlayVisibility();
      return;
    }

    // [C] Crosshair Customizer tab inside unified Settings Modal
    if (e.code === 'KeyC' && !lobby.isOpen()) {
      minimap.setExpanded(false);
      const wasMapOpen = mapViewer.isOpen();
      const wasBuyOpen = buyMenu.isOpen();
      if (wasMapOpen) mapViewer.close();
      if (wasBuyOpen) buyMenu.close();
      crosshair.syncControls();
      const nowOpen = settings.toggle('crosshair');
      if (nowOpen && isPointerLocked()) {
        document.exitPointerLock();
      }
      syncOverlayVisibility();
      return;
    }

    if (e.code === 'Escape' && settings.isOpen()) {
      settings.close();
      syncOverlayVisibility();
      return;
    }

    if (lobby.isOpen()) {
      return;
    }

    // [B] opens/closes Buyout Shop during the Buy phase (never overlaps Settings/MapViewer).
    if (
      e.code === 'KeyB' &&
      gameStarted &&
      lastHudPhase === 'buy' &&
      !settings.isOpen() &&
      !mapViewer.isOpen()
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
      !settings.isOpen() &&
      !mapViewer.isOpen() &&
      !buyMenu.isOpen()
    ) {
      openAgentSelect();
      return;
    }

    // [M] Ascent 2D Tactical Map & 3D Flyover Viewer toggle
    if (e.code === 'KeyM') {
      minimap.setExpanded(false);
      const wasSettingsOpen = settings.isOpen();
      const wasBuyOpen = buyMenu.isOpen();
      const nowOpen = mapViewer.toggle();
      if (wasSettingsOpen) settings.close();
      if (wasBuyOpen) buyMenu.close();
      if (nowOpen && isPointerLocked()) {
        document.exitPointerLock();
      }
      syncOverlayVisibility();
      return;
    }

    if (e.code === 'Escape' && isAnyModalOpen()) {
      settings.close();
      mapViewer.close();
      buyMenu.close();
      syncOverlayVisibility();
      return;
    }

    if (e.code === 'Escape' && minimap.isExpanded()) {
      capsHeld = false;
      minimap.setExpanded(false);
      return;
    }

    if (isAnyModalOpen()) {
      return;
    }

    // [N] Toggle Minimap Radar (player-centered) vs Fixed North-Up
    if (e.code === 'KeyN') {
      const rotateNow = minimap.toggleRotateMode();
      settings.applyPatch({ minimapRotate: rotateNow });
      return;
    }

    // [CapsLock] Hold / peek Full Tactical Map Overlay
    if (e.code === 'CapsLock') {
      capsHeld = true;
      minimap.setExpanded(true);
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
      // [F] Fresh press toggles nearby Blast Door switch (hold still plants/defuses Spike)
      if (e.code === 'KeyF' && match.getPlayerCombatant().alive) {
        const nearby = findNearbyDoorSwitch(player.position, 2.5);
        const toggled = match.tryInteractDoor(player);
        if (toggled && net.isOnline() && nearby) {
          const doorState = getArenaDoors().find((d) => d.id === nearby.doorId)?.status;
          net.sendDoorEvent({
            doorId: nearby.doorId,
            action: 'toggle',
            state: doorState,
          });
        }
      }

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

      // [Q] / [E] / [X] Cast tactical abilities & Ultimate when alive
      if (match.getPlayerCombatant().alive) {
        if (e.code === 'KeyQ') {
          abilities.cast('q', player, input);
        } else if (e.code === 'KeyE') {
          abilities.cast('e', player, input);
        } else if (e.code === 'KeyX') {
          match.tryCastPlayerUltimate(player, input);
        }
      }
    }
  }

  handleKey(e.code, true);
});

window.addEventListener('keyup', (e: KeyboardEvent) => {
  if (e.code === 'CapsLock' && capsHeld) {
    capsHeld = false;
    minimap.setExpanded(false);
  }
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

function syncAbilityXSlot(hud: MatchHudState, xHud?: AbilityHudSlotState): void {
  const maxPts = hud.maxUltPoints ?? xHud?.cooldownTotal ?? 5;
  const pts = clamp(hud.ultPoints ?? 0, 0, maxPts);
  const activeTimer = xHud?.activeTimer ?? 0;
  const isReady = xHud?.ready ?? pts >= maxPts;
  const shortTag = xHud?.shortTag ?? AGENT_ABILITIES[player.colorId].x.shortTag;

  abilityXEl.classList.toggle('ready', isReady);
  abilityXEl.classList.toggle('ult-ready', isReady);
  abilityXEl.classList.toggle('active-fx', activeTimer > 0);
  const pct = activeTimer > 0 ? 100 : clamp((pts / Math.max(maxPts, 1)) * 100, 0, 100);
  abilityXEl.style.setProperty('--cd-pct', `${pct.toFixed(1)}%`);

  let pipsHtml = '<span class="ult-pips">';
  for (let i = 0; i < maxPts; i++) {
    pipsHtml += `<span class="ult-pip${i < pts ? ' lit' : ''}"></span>`;
  }
  pipsHtml += '</span>';

  const timerHtml =
    activeTimer > 0
      ? `<span class="ab-charges timer">${activeTimer.toFixed(1)}s</span>`
      : '';
  const html = `<span class="ab-key">[X]</span>${shortTag}${pipsHtml}${timerHtml}`;
  if (abilityXEl.dataset.html !== html) {
    abilityXEl.dataset.html = html;
    abilityXEl.innerHTML = html;
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
    spikeInteractHudEl.classList.remove('hidden', 'defuse', 'door');
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
    spikeInteractHudEl.classList.remove('hidden', 'plant', 'door');
    spikeInteractHudEl.classList.add('defuse');
    spikeInteractLabelEl.textContent = activeDefuse
      ? `DEFUSING SPIKE (${pct}%)`
      : '[F] DEFUSE SPIKE';
    const showBar = spike.defuseProgress > 0 || spike.halfwayCheckpoint;
    spikeProgressTrackEl.classList.toggle('hidden', !showBar);
    spikeProgressFillEl.style.width = `${(spike.defuseProgress * 100).toFixed(1)}%`;
    spikeHalfwayNotchEl.classList.toggle('hidden', !showBar);
    spikeHalfwayTagEl.classList.toggle('hidden', !spike.halfwayCheckpoint);
  } else if (hud.nearbyDoorPrompt) {
    spikeInteractHudEl.classList.remove('hidden', 'plant', 'defuse');
    spikeInteractHudEl.classList.add('door');
    spikeInteractLabelEl.textContent = `[F] ${hud.nearbyDoorPrompt.action} ${hud.nearbyDoorPrompt.label}`;
    spikeProgressTrackEl.classList.add('hidden');
    spikeHalfwayNotchEl.classList.add('hidden');
    spikeHalfwayTagEl.classList.add('hidden');
  } else if (unownedHintTimer > 0 && hud.phase === 'buy') {
    spikeInteractHudEl.classList.remove('hidden', 'plant', 'defuse', 'door');
    spikeInteractLabelEl.textContent = 'WEAPON NOT OWNED — PRESS [B] BUY SHOP';
    spikeProgressTrackEl.classList.add('hidden');
    spikeHalfwayNotchEl.classList.add('hidden');
    spikeHalfwayTagEl.classList.add('hidden');
  } else {
    spikeInteractHudEl.classList.remove('door');
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
  const wt = hud.winTarget ?? 10;
  const sw = hud.swapInterval ?? 5;
  matchFormatLabelEl.textContent = `FT${wt} • ${sw} ATK / ${sw} DEF SWAP`;

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

  const rawDt = Math.max(0.001, (now - lastTime) / 1000);
  // Clamp dt to 50ms so tab-switching or frame hitches never tunnel through walls.
  const dt = Math.min(rawDt, 0.05);
  lastTime = now;

  if (showFps) {
    const instFps = Math.min(999, 1 / rawDt);
    smoothedFps = smoothedFps * 0.9 + instFps * 0.1;
    if (now - fpsLastUiMs >= 200) {
      fpsLastUiMs = now;
      fpsCounterEl.textContent = `${Math.round(smoothedFps)} FPS`;
    }
  }

  // -------------------------------------------------------------------------
  // Frozen state: Lobby or Agent Select is open (or the match has not started yet).
  // The simulation is paused, the Agent Select stage renders ONLY while open,
  // and the main scene is drawn once as a static backdrop.
  // -------------------------------------------------------------------------
  if (lobby.isOpen() || agentSelect.isOpen() || !gameStarted) {
    if (agentSelect.isOpen()) {
      agentSelect.render(dt);
    }
    if (!frozenDrawn || !lastFrozenHud) {
      const pc = match.getPlayerCombatant();
      camera.position.set(player.position.x, player.position.y + EYE_HEIGHT, player.position.z);
      camera.rotation.y = pc.yaw;
      camera.rotation.x = 0;
      camera.rotation.z = 0;
      const frozenHud = match.update(0, player, camera.position, []);
      lastFrozenHud = frozenHud;
      if (!(mapViewer.isOpen() && mapViewer.is3DViewActive())) {
        setArenaBuyBarriersVisible(frozenHud.phase === 'buy');
      }
      syncMatchHud(frozenHud);
      syncAbilityXSlot(frozenHud, lastAbilityFeedback?.xHud);
      minimap.update(frozenHud, match.combatants, player, pc.yaw, false);
      if (!mapViewer.isOpen()) {
        renderer.render(scene, camera);
      }
      frozenDrawn = true;
    }
    if (!lobby.isOpen() && !agentSelect.isOpen() && mapViewer.isOpen()) {
      if (mapViewer.is3DViewActive()) {
        updateArenaDoors(dt);
        mapViewer.render3D(renderer, scene);
      } else if (lastFrozenHud) {
        mapViewer.update2D(lastFrozenHud, match.combatants, player);
      }
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
      const maxBuyX = ARENA_WIDTH_M * 0.5 - 1.5;
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
  // otherwise configured base FOV + Crimson Dash punch, or wide FOV during Power-Slide.
  const adsFov = activeSpec.adsFovDeg;
  const targetFov =
    isAlive && weapon.isScoped && adsFov != null
      ? adsFov
      : feedback.slideActive
        ? Math.max(baseFovDeg + 6, 85)
        : baseFovDeg + feedback.dashAlpha * 15;

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

      if (shot.hitDoorId) {
        const dmg = shot.doorDamageDealt ?? 25;
        match.handleDoorShotHit(shot.hitDoorId, dmg);
        if (net.isOnline()) {
          const doorState = getArenaDoors().find((d) => d.id === shot.hitDoorId)?.status;
          net.sendDoorEvent({
            doorId: shot.hitDoorId,
            action: doorState === 'broken' ? 'break' : 'damage',
            state: doorState,
            damage: dmg,
          });
        }
      }

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
  if (net.isOnline() && gameStarted) {
    net.sendPlayerState({
      side: lastPlayerSide,
      agentColor: player.colorId,
      position: player.position,
      velocity: player.velocity,
      yaw: input.yaw,
      pitch: input.pitch,
      health: player.health,
      armor: player.armor ?? 0,
      alive: isAlive,
      weaponId: weapon.currentWeaponId,
      firing: firedThisFrame,
      sliding: Boolean(feedback.slideActive),
      ultActive: (playerCombatant.ultActiveTimer ?? 0) > 0,
    });
    match.applyRemotePlayers(net.getRemotePlayers());
  }
  const ultRevealActive = Boolean(lastAbilityFeedback?.ultRevealActive);
  const hud = match.update(dt, player, camera.position, feedback.activeSmokes, ultRevealActive);
  if (!(mapViewer.isOpen() && mapViewer.is3DViewActive())) {
    setArenaBuyBarriersVisible(hud.phase === 'buy');
  }

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
  minimap.update(hud, match.combatants, player, input.yaw, ultRevealActive);

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
  syncAbilityXSlot(hud, feedback.xHud);
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

  if (mapViewer.isOpen() && mapViewer.is3DViewActive()) {
    mapViewer.render3D(renderer, scene);
  } else {
    renderer.render(scene, camera);
    if (mapViewer.isOpen()) {
      mapViewer.update2D(hud, match.combatants, player);
    }
  }

  // Clear one-frame semi-auto trigger flag at the end of the tick.
  input.fireJustPressed = false;
}

requestAnimationFrame(tick);
