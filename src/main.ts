import * as THREE from 'three';
import {
  AGENT_ORDER,
  AGENT_PALETTES,
  AbilityFrameFeedback,
  AbilityHudSlotState,
  AgentColorId,
  AiDifficulty,
  Combatant,
  GameSettings,
  InputState,
  MatchHudState,
  MovementModifiers,
  RoundCombatReportEntry,
  RoundPhase,
  SmokeSphere,
  SpikeHudState,
  TacticalSide,
  Vec3,
  WeaponId,
} from './core/types';
import {
  EYE_HEIGHT,
  createInitialPlayerState,
  getHorizontalSpeed,
  getLookDirection,
  raycastAABB,
  raycastSphere,
  updatePlayerMovement,
} from './physics/movement';
import {
  ARENA_COLLIDERS,
  ARENA_WIDTH_M,
  PLAYER_SPAWN,
  buildArenaScene,
  findNearbyDoorSwitch,
  getArenaDoors,
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
import { createSettingsController, formatBindLabel } from './ui/settings';
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
  0.08,
  230
);
// Tighter near/far ratio eliminates far-plane wall Z-fighting while covering 84x92m diagonals.
camera.near = 0.08;
camera.far = 230;
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
const overlaySurrenderBtn = document.getElementById(
  'overlay-surrender-btn'
) as HTMLButtonElement;
const fpsCounterEl = document.getElementById('fps-counter') as HTMLDivElement;
const screenFxEl = document.getElementById('screen-fx') as HTMLDivElement;
const scopeOverlayEl = document.getElementById('scope-overlay') as HTMLDivElement;
const crosshairEl = document.getElementById('crosshair') as HTMLDivElement;
const headshotRingEl = document.getElementById('headshot-ring') as HTMLDivElement;
const hitmarkerEl = document.getElementById('hitmarker') as HTMLDivElement;
const targetIdLabelEl = document.getElementById('target-id-label') as HTMLDivElement;
const spectatorBarEl = document.getElementById('spectator-bar') as HTMLDivElement;
const combatReportEl = document.getElementById('combat-report') as HTMLDivElement;

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
  overlaySurrenderBtn.classList.toggle('hidden', lastHudPhase === 'match_over');
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
let spectateTargetId: string | null = null;
let overlaySurrenderArmed = false;
let overlaySurrenderTimer: ReturnType<typeof setTimeout> | null = null;

function resetOverlaySurrenderConfirm(): void {
  if (overlaySurrenderTimer !== null) {
    clearTimeout(overlaySurrenderTimer);
    overlaySurrenderTimer = null;
  }
  overlaySurrenderArmed = false;
  overlaySurrenderBtn.textContent = 'SURRENDER';
  overlaySurrenderBtn.classList.remove('confirming');
}

function triggerLocalSurrender(): void {
  if (!gameStarted || lastHudPhase === 'match_over') return;
  match.surrenderMatch();
  if (net.isOnline()) {
    net.sendSurrender();
  }
}

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

  match.setPlayerName(s.playerName);
  net.setPlayerName(s.playerName);

  match.setMatchConfig({
    difficulty: s.difficulty,
    winTarget: s.winTarget,
  });

  if (!syncingLobbySettings) {
    syncingLobbySettings = true;
    lobby.setCallsign(s.playerName);
    if (!gameStarted && !net.isOnline()) {
      net.setConfig({
        difficulty: s.difficulty,
        winTarget: s.winTarget,
      });
    }
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
    match.setPlayerName(callsign);
    net.setPlayerName(callsign);
    if (!syncingLobbySettings) {
      syncingLobbySettings = true;
      settings.applyPatch({ playerName: callsign });
      syncingLobbySettings = false;
    }
    if (!gameStarted && !net.isOnline()) {
      net.connect(callsign);
    }
  },
  onRetryConnect: (callsign: string) => {
    net.connect(callsign);
  },
  onConnectCustomServer: (url: string) => {
    net.connect(lobby.getCallsign(), url);
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

function returnToLobbyFromMatch(): void {
  if (isPointerLocked()) document.exitPointerLock();
  clearHeldInputs();
  weapon.setAdsActive(false);
  input.ads = false;
  resetOverlaySurrenderConfirm();
  gameStarted = false;
  frozenDrawn = false;
  spectateTargetId = null;
  spectatorBarEl.classList.add('hidden');
  combatReportEl.classList.add('hidden');
  targetIdLabelEl.classList.add('hidden');
  if (net.isOnline() && !net.isHost()) {
    net.reconnect();
  } else {
    net.returnToLobby();
  }
  lobby.open();
  syncOverlayVisibility();
}

async function refreshLanInviteUrl(): Promise<void> {
  const candidates: string[] = ['/health'];
  if (typeof window !== 'undefined' && window.location?.port === '5173') {
    const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
    candidates.unshift(`${proto}//${window.location.hostname}:5174/health`);
  }
  for (const healthUrl of candidates) {
    try {
      const res = await fetch(healthUrl, { cache: 'no-store' });
      if (!res.ok) continue;
      const data = (await res.json()) as { lanUrls?: string[] };
      if (Array.isArray(data.lanUrls) && data.lanUrls.length > 0 && typeof data.lanUrls[0] === 'string') {
        lobby.setInviteUrl(data.lanUrls[0]);
        return;
      }
    } catch {
      // Try next candidate
    }
  }
}

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

  spectateTargetId = null;
  lastSeenKillId = 0;
  playerKillTimes = [];

  match.startNewMatch({
    startingSide,
    playerAgent: chosenAgent,
    difficulty: snapshot.difficulty,
    winTarget: snapshot.winTarget,
    playerName: currentSettings.playerName,
    teamHumanSlots: snapshot.players,
    localPlayerId: localId,
  });
  syncLocalPlayerFromCombatant();

  gameStarted = true;
  frozenDrawn = false;
  resetOverlaySurrenderConfirm();
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

net.onDamage((ev) => {
  if (!gameStarted || ev.fromId === net.getLocalPlayerId()) return;
  const rawTarget = ev.targetPlayerId ?? ev.targetSlotId;
  if (!rawTarget) return;
  const victimKey = rawTarget === net.getLocalPlayerId() ? 'local' : rawTarget;
  match.applyRemoteDamage(victimKey, ev.damage, ev.headshot, ev.fromId, ev.weaponTag);
});

net.onSurrender(() => {
  if (!gameStarted) return;
  match.surrenderMatch();
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

settings.setOnSurrender(() => {
  triggerLocalSurrender();
  settings.close();
  syncOverlayVisibility();
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
void refreshLanInviteUrl();
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
  resetOverlaySurrenderConfirm();
  sfx.unlock();
  canvas.requestPointerLock();
});

openSettingsFromOverlayBtn.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  resetOverlaySurrenderConfirm();
  sfx.unlock();
  minimap.setExpanded(false);
  crosshair.syncControls();
  settings.open('controls');
  syncOverlayVisibility();
});

openXhairFromOverlayBtn.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  resetOverlaySurrenderConfirm();
  sfx.unlock();
  minimap.setExpanded(false);
  crosshair.syncControls();
  settings.open('crosshair');
  syncOverlayVisibility();
});

openMapFromOverlayBtn.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  resetOverlaySurrenderConfirm();
  sfx.unlock();
  minimap.setExpanded(false);
  mapViewer.open();
  syncOverlayVisibility();
});

overlaySurrenderBtn.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  if (!gameStarted || lastHudPhase === 'match_over') return;
  if (!overlaySurrenderArmed) {
    overlaySurrenderArmed = true;
    overlaySurrenderBtn.textContent = 'CONFIRM SURRENDER?';
    overlaySurrenderBtn.classList.add('confirming');
    if (overlaySurrenderTimer !== null) clearTimeout(overlaySurrenderTimer);
    overlaySurrenderTimer = setTimeout(() => {
      resetOverlaySurrenderConfirm();
    }, 3500);
    return;
  }
  resetOverlaySurrenderConfirm();
  triggerLocalSurrender();
  canvas.requestPointerLock();
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

  // Clear held movement/fire/ADS inputs when unlocking so keys or Hold-ADS never get stuck.
  if (!locked) {
    clearHeldInputs();
    weapon.setAdsActive(false);
    input.ads = false;
  } else {
    resetOverlaySurrenderConfirm();
  }
});

window.addEventListener('blur', () => {
  clearHeldInputs();
  if (currentSettings.adsMode === 'hold' || isPointerLocked()) {
    weapon.setAdsActive(false);
    input.ads = false;
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

function mapMouseBindCode(button: number): string | null {
  if (button === 1) return 'Mouse3';
  if (button === 3) return 'Mouse4';
  if (button === 4) return 'Mouse5';
  return null;
}

function isCodeBoundToAbility(code: string): boolean {
  const b = currentSettings.keybinds;
  return b.abilityQ === code || b.abilityE === code || b.abilityX === code;
}

let lastMouseAbilityAtMs = 0;

function triggerAbilityByBindCode(code: string): boolean {
  if (!isPointerLocked() || isAnyModalOpen() || lastHudPhase !== 'combat') return false;
  if (!match.getPlayerCombatant().alive) return false;
  const binds = currentSettings.keybinds;
  if (code === binds.abilityQ) {
    abilities.cast('q', player, input);
    return true;
  }
  if (code === binds.abilityE) {
    abilities.cast('e', player, input);
    return true;
  }
  if (code === binds.abilityX) {
    match.tryCastPlayerUltimate(player, input);
    return true;
  }
  return false;
}

function cycleSpectateTarget(delta: 1 | -1): void {
  const teammates = match.getLivingTeammates();
  if (teammates.length === 0) {
    spectateTargetId = null;
    return;
  }
  const idx = teammates.findIndex((t) => t.id === spectateTargetId);
  const nextIdx =
    idx < 0
      ? 0
      : (idx + delta + teammates.length) % teammates.length;
  spectateTargetId = teammates[nextIdx].id;
}

window.addEventListener('pointerdown', (e: PointerEvent) => {
  const mouseBind = mapMouseBindCode(e.button);
  if (!mouseBind) return;
  if (isPointerLocked() || settings.isOpen()) {
    e.preventDefault();
  }
  if (isPointerLocked() && !isAnyModalOpen()) {
    sfx.unlock();
    const now = performance.now();
    if (now - lastMouseAbilityAtMs > 35) {
      lastMouseAbilityAtMs = now;
      triggerAbilityByBindCode(mouseBind);
    }
  }
});

window.addEventListener('pointerup', (e: PointerEvent) => {
  if (e.button === 1 || e.button === 3 || e.button === 4) {
    if (isPointerLocked() || settings.isOpen()) {
      e.preventDefault();
    }
  }
});

window.addEventListener('mousedown', (e: MouseEvent) => {
  const mouseBind = mapMouseBindCode(e.button);
  if (mouseBind) {
    if (isPointerLocked() || settings.isOpen()) {
      e.preventDefault();
    }
    if (isPointerLocked() && !isAnyModalOpen()) {
      sfx.unlock();
      const now = performance.now();
      if (now - lastMouseAbilityAtMs > 35) {
        lastMouseAbilityAtMs = now;
        triggerAbilityByBindCode(mouseBind);
      }
    }
    return;
  }

  if (!isPointerLocked() || isAnyModalOpen()) return;
  sfx.unlock();

  const alive = match.getPlayerCombatant().alive;
  if (!alive) {
    if (lastHudPhase === 'combat') {
      if (e.button === 0) cycleSpectateTarget(1);
      else if (e.button === 2) cycleSpectateTarget(-1);
    }
    return;
  }

  if (e.button === 0) {
    input.fire = true;
    input.fireJustPressed = true;
    fireBufferTimer = INPUT_BUFFER_SEC; // 140ms semi-auto fire buffer
  } else if (e.button === 2) {
    if (currentSettings.adsMode === 'hold') {
      weapon.setAdsActive(true);
    } else {
      weapon.setAdsActive(!weapon.isScoped);
    }
    input.ads = weapon.isScoped;
  }
});

window.addEventListener('mouseup', (e: MouseEvent) => {
  if (e.button === 1 || e.button === 3 || e.button === 4) {
    if (isPointerLocked() || settings.isOpen()) {
      e.preventDefault();
    }
    return;
  }
  if (e.button === 0) {
    input.fire = false;
  } else if (e.button === 2) {
    if (currentSettings.adsMode === 'hold' && weapon.isScoped) {
      weapon.setAdsActive(false);
      input.ads = weapon.isScoped;
    }
  }
});

window.addEventListener('auxclick', (e: MouseEvent) => {
  if (e.button === 1 || e.button === 3 || e.button === 4) {
    if (isPointerLocked() || settings.isOpen()) {
      e.preventDefault();
    }
  }
});

window.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    if (!isPointerLocked() || isAnyModalOpen()) return;
    if (!match.getPlayerCombatant().alive) return;
    const wheelCode = e.deltaY < 0 ? 'WheelUp' : e.deltaY > 0 ? 'WheelDown' : null;
    if (wheelCode && isCodeBoundToAbility(wheelCode)) {
      e.preventDefault();
      sfx.unlock();
      triggerAbilityByBindCode(wheelCode);
      return;
    }
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
  { passive: false }
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

    // [F1..F6] Switch active Agent (Blaze, Mist, Pulse, Umbra, Volt, Windy)
    const fKey = /^F([1-6])$/.exec(e.code);
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
          spectateTargetId = null;
          match.setSpectatedCombatantId(null);
          syncLocalPlayerFromCombatant();
        }
      }
      return;
    }

    // [Enter] Restart match once 'match_over' is reached; [L] returns to Lobby
    if (e.code === 'Enter' && lastHudPhase === 'match_over') {
      match.restartMatch();
      syncLocalPlayerFromCombatant();
      openAgentSelect(); // fresh draft: pick your agent for the new match
      return;
    }
    if (e.code === 'KeyL' && lastHudPhase === 'match_over') {
      returnToLobbyFromMatch();
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

      // [Space] during Buy phase skips buy countdown cleanly
      if (e.code === 'Space' && lastHudPhase === 'buy') {
        match.skipBuyPhase();
      }

      // Custom ability / ultimate binds (Key / Mouse3/4/5 / BrowserBack/Forward / Wheel) — ONLY during combat!
      const normalizedAbilityCode =
        e.code === 'BrowserBack' ? 'Mouse4' : e.code === 'BrowserForward' ? 'Mouse5' : e.code;
      if (normalizedAbilityCode === 'Mouse4' || normalizedAbilityCode === 'Mouse5') {
        e.preventDefault();
        const now = performance.now();
        if (now - lastMouseAbilityAtMs > 35) {
          lastMouseAbilityAtMs = now;
          triggerAbilityByBindCode(normalizedAbilityCode);
        }
      } else {
        triggerAbilityByBindCode(normalizedAbilityCode);
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
  bindCode: string,
  slot: AbilityHudSlotState
): void {
  const activeTimer = slot.activeTimer ?? 0;
  const maxCharges = slot.maxCharges ?? 2;
  const charges = clamp(slot.charges ?? (slot.ready ? maxCharges : 0), 0, maxCharges);
  const hasCharges = charges > 0;
  el.classList.toggle('ready', slot.ready && hasCharges);
  el.classList.toggle('active-fx', activeTimer > 0);

  const pct = !hasCharges
    ? 0
    : slot.ready
      ? 100
      : clamp((1 - slot.cooldownRemaining / Math.max(slot.cooldownTotal, 0.001)) * 100, 0, 100);
  el.style.setProperty('--cd-pct', `${pct.toFixed(1)}%`);

  // 2 crisp per-round charge pips + optional active-duration timer (e.g. Volt Overdrive / Bio-Stim).
  let extra = '';
  if (maxCharges > 1) {
    let pips = '<span class="ab-pips">';
    for (let i = 0; i < maxCharges; i++) {
      pips += `<span class="ab-pip${i < charges ? ' lit' : ''}"></span>`;
    }
    pips += '</span>';
    extra += pips;
  }
  if (activeTimer > 0) {
    extra += `<span class="ab-charges timer" id="${el.id}-charges">${activeTimer.toFixed(1)}s</span>`;
  }

  const keyLabel = formatBindLabel(bindCode);
  const label = !hasCharges
    ? '0/2'
    : slot.ready
      ? slot.shortTag
      : `${slot.cooldownRemaining.toFixed(1)}s`;
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

  const keyLabel = formatBindLabel(currentSettings.keybinds.abilityX);
  const timerHtml =
    activeTimer > 0
      ? `<span class="ab-charges timer">${activeTimer.toFixed(1)}s</span>`
      : '';
  const html = `<span class="ab-key">[${keyLabel}]</span>${shortTag}${pipsHtml}${timerHtml}`;
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

  if ((feedback.windDashAlpha ?? 0) > 0.001) {
    const a = clamp((feedback.windDashAlpha ?? 0) * 0.36, 0, 0.42).toFixed(3);
    layers.push(`radial-gradient(circle at center, transparent 50%, rgba(124, 232, 255, ${a}) 100%)`);
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

const CODENAME_SHORT: Record<AgentColorId, string> = {
  red: 'BLZ',
  blue: 'MST',
  green: 'PLS',
  violet: 'UMB',
  gold: 'VLT',
  cyan: 'WND',
};

/** Rebuilds Top-Bar Valorant teammate HP + Ult badges (no enemy HP ever displayed). */
function syncTopTeamCards(hud: MatchHudState): void {
  const syncSide = (
    container: HTMLDivElement,
    team: 'ally' | 'enemy',
    list: Array<{
      id: string;
      colorId: AgentColorId;
      displayName: string;
      alive: boolean;
      isPlayer?: boolean;
      hp?: number;
      maxHp?: number;
      ultReady: boolean;
      ultActive: boolean;
    }>
  ) => {
    const sig = list
      .map(
        (s) =>
          `${s.id}:${s.colorId}:${s.alive ? 1 : 0}:${s.isPlayer ? 1 : 0}:${s.hp ?? -1}:${s.ultReady ? 1 : 0}:${s.ultActive ? 1 : 0}`
      )
      .join('|');
    if (container.dataset.sig === sig) return;
    container.dataset.sig = sig;
    container.replaceChildren();

    for (const st of list) {
      const card = document.createElement('div');
      card.className = 'top-agent-card';
      if (!st.alive) card.classList.add('dead');
      if (st.isPlayer) card.classList.add('is-player');
      if (st.ultReady) card.classList.add('ult-ready');
      if (st.ultActive) card.classList.add('ult-active');
      card.dataset.team = team;
      card.dataset.color = st.colorId;
      card.style.setProperty('--card-color', AGENT_PALETTES[st.colorId].css);
      card.title = `${st.displayName} (${AGENT_PALETTES[st.colorId].name})${st.ultActive ? ' • ULT ACTIVE' : st.ultReady ? ' • ULT READY' : ''}`;

      const head = document.createElement('div');
      head.className = 'tac-head';

      const codeSpan = document.createElement('span');
      codeSpan.className = 'tac-code';
      codeSpan.textContent = CODENAME_SHORT[st.colorId];
      head.appendChild(codeSpan);

      if (st.ultActive || st.ultReady) {
        const ultBadge = document.createElement('span');
        ultBadge.className = st.ultActive ? 'tac-ult active' : 'tac-ult';
        ultBadge.textContent = 'ULT';
        head.appendChild(ultBadge);
      }
      card.appendChild(head);

      if (team === 'ally') {
        const hp = Math.max(0, st.hp ?? 0);
        const maxHp = Math.max(1, st.maxHp ?? 100);
        const hpPct = Math.round((hp / maxHp) * 100);

        const track = document.createElement('div');
        track.className = 'tac-hp-track';
        const fill = document.createElement('div');
        fill.className = 'tac-hp-fill';
        fill.style.width = `${st.alive ? hpPct : 0}%`;
        if (st.alive && hp < 40) fill.classList.add('low');
        track.appendChild(fill);

        const hpNum = document.createElement('div');
        hpNum.className = 'tac-hp-num';
        hpNum.textContent = st.alive ? `${hp}` : 'DEAD';

        card.append(track, hpNum);
      } else {
        const statusEl = document.createElement('div');
        statusEl.className = 'tac-enemy-state';
        statusEl.textContent = st.alive ? (st.ultActive ? 'ULTING' : 'ALIVE') : 'DEAD';
        card.appendChild(statusEl);
      }

      container.appendChild(card);
    }
  };

  syncSide(allyDotsEl, 'ally', hud.allyStates);
  syncSide(enemyDotsEl, 'enemy', hud.enemyStates);
}

// --- Elimination medal & directional damage arc ---
const ARC_FADE_SEC = 0.9;
const MULTI_KILL_WINDOW_MS = 4000;
let lastSeenKillId = 0;
let playerKillTimes: number[] = [];
let lastDamageSeqSeen = 0;
let damageArcAngleRad = 0;
let damageArcTimer = 0;
let hitmarkerTimer = 0;
let combatSecondsPlayed = 0;
let lastCombatReportSig = '';

function triggerKillMedal(headshot: boolean, streak: number): void {
  killMedalTitleEl.textContent = headshot ? 'HEADSHOT' : 'ELIMINATED';
  killMedalStreakEl.textContent = streak >= 2 ? `x${streak}` : '';
  killMedalEl.classList.toggle('headshot', headshot);
  killMedalEl.classList.remove('show');
  void killMedalEl.offsetWidth; // restart the CSS pop animation
  killMedalEl.classList.add('show');
}

function syncKillMedal(hud: MatchHudState): void {
  const myName = (match.getPlayerCombatant().displayName ?? 'YOU').toUpperCase();
  const fresh = hud.killFeed.filter((k) => k.id > lastSeenKillId).sort((a, b) => a.id - b.id);
  for (const k of fresh) {
    lastSeenKillId = Math.max(lastSeenKillId, k.id);
    if (k.killerName !== myName || k.killerTeam !== 'ally') continue;
    const now = performance.now();
    playerKillTimes = playerKillTimes.filter((ts) => now - ts <= MULTI_KILL_WINDOW_MS);
    playerKillTimes.push(now);
    triggerKillMedal(k.headshot, playerKillTimes.length);
  }
}

function updateTargetIdLabel(
  isAlive: boolean,
  effectivePitch: number,
  activeSmokes: SmokeSphere[]
): void {
  if (!isAlive || !gameStarted || isAnyModalOpen()) {
    targetIdLabelEl.classList.add('hidden');
    return;
  }

  const origin: Vec3 = {
    x: player.position.x,
    y: player.position.y + EYE_HEIGHT + eyeOffsetSmoothed,
    z: player.position.z,
  };
  const lookDir = getLookDirection(input.yaw, effectivePitch);

  let closestWallDist = 140;
  for (const box of ARENA_COLLIDERS) {
    const wallHit = raycastAABB(origin, lookDir, box, closestWallDist);
    if (wallHit && wallHit.distance < closestWallDist) {
      closestWallDist = wallHit.distance;
    }
  }

  let bestCombatant: Combatant | null = null;
  let bestDist = 140;

  for (const c of match.combatants) {
    if (c.isPlayer || !c.alive) continue;
    const maxTestDist = c.team === 'enemy' ? Math.min(bestDist, closestWallDist) : bestDist;
    const { head, body } = match.allTargetsView.getHitboxes(c);
    const headHit = raycastAABB(origin, lookDir, head, maxTestDist);
    const bodyHit = raycastAABB(origin, lookDir, body, maxTestDist);

    let hitDist: number | null = null;
    if (headHit && bodyHit) {
      hitDist = Math.min(headHit.distance, bodyHit.distance);
    } else if (headHit) {
      hitDist = headHit.distance;
    } else if (bodyHit) {
      hitDist = bodyHit.distance;
    }
    if (hitDist === null) continue;

    if (c.team === 'enemy' && activeSmokes.length > 0) {
      let smoked = false;
      for (const smoke of activeSmokes) {
        if (raycastSphere(origin, lookDir, smoke.center, smoke.radius, hitDist) !== null) {
          smoked = true;
          break;
        }
      }
      if (smoked) continue;
    }

    if (hitDist < bestDist) {
      bestDist = hitDist;
      bestCombatant = c;
    }
  }

  if (!bestCombatant) {
    targetIdLabelEl.classList.add('hidden');
    return;
  }

  const labelName = (
    bestCombatant.displayName ||
    AGENT_PALETTES[bestCombatant.colorId].name.split(' ')[0]
  ).toUpperCase();

  if (bestCombatant.team === 'enemy') {
    targetIdLabelEl.textContent = `ENEMY • ${labelName}`;
    targetIdLabelEl.classList.remove('hidden', 'ally');
    targetIdLabelEl.classList.add('enemy');
  } else {
    targetIdLabelEl.textContent = `ALLY • ${labelName} (FRIENDLY)`;
    targetIdLabelEl.classList.remove('hidden', 'enemy');
    targetIdLabelEl.classList.add('ally');
  }
}

function syncSpectatorBar(hud: MatchHudState, isAlive: boolean, target: Combatant | null): void {
  if (!gameStarted || isAnyModalOpen() || isAlive || hud.phase !== 'combat' || !target) {
    spectatorBarEl.classList.add('hidden');
    return;
  }
  const name = (
    target.displayName || AGENT_PALETTES[target.colorId].name.split(' ')[0]
  ).toUpperCase();
  const agent = AGENT_PALETTES[target.colorId].name.split(' ')[0].toUpperCase();
  const hp = Math.max(0, Math.ceil(target.health));
  const takeover = hud.canTakeoverBot ? ' • [TAB] TAKE OVER' : '';
  spectatorBarEl.textContent = `SPECTATING: ${name} • ${agent} • ${hp} HP • [LMB/RMB] NEXT${takeover}`;
  spectatorBarEl.classList.remove('hidden');
}

function syncCombatReport(hud: MatchHudState, isAlive: boolean): void {
  const show =
    gameStarted &&
    !isAnyModalOpen() &&
    hud.phase !== 'buy' &&
    (!isAlive || hud.phase === 'round_end');
  if (!show) {
    combatReportEl.classList.add('hidden');
    return;
  }

  combatReportEl.classList.remove('hidden');
  const entries: RoundCombatReportEntry[] = hud.combatReport ?? [];
  const sig = `${hud.roundNumber}|${entries
    .map(
      (e) =>
        `${e.opponentId}:${e.opponentName}:${e.damageOut}:${e.hitsOutHead}:${e.hitsOutBody}:${e.damageIn}:${e.hitsInHead}:${e.hitsInBody}:${e.killedOpponent}:${e.killedByOpponent}`
    )
    .join(';')}`;
  if (sig === lastCombatReportSig) return;
  lastCombatReportSig = sig;

  combatReportEl.replaceChildren();
  const head = document.createElement('div');
  head.className = 'cr-head';
  const titleSpan = document.createElement('span');
  titleSpan.textContent = `COMBAT REPORT • R${hud.roundNumber}`;
  const subSpan = document.createElement('span');
  subSpan.textContent = 'OUT / IN';
  head.appendChild(titleSpan);
  head.appendChild(subSpan);
  combatReportEl.appendChild(head);

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cr-empty';
    empty.textContent = 'No damage exchanged this round';
    combatReportEl.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'cr-row';

    const opp = document.createElement('div');
    opp.className = 'cr-opp';
    const dot = document.createElement('span');
    dot.className = 'cr-dot';
    const cssColor = AGENT_PALETTES[entry.opponentColor].css;
    dot.style.background = cssColor;
    dot.style.boxShadow = `0 0 6px ${cssColor}`;
    const nameEl = document.createElement('span');
    nameEl.className = 'cr-name';
    const statusMark = entry.killedOpponent ? ' [KILL]' : entry.killedByOpponent ? ' [KO]' : '';
    nameEl.textContent = `${entry.opponentName}${statusMark}`;
    opp.appendChild(dot);
    opp.appendChild(nameEl);

    const outCol = document.createElement('div');
    outCol.className = 'cr-stat';
    const outDmg = document.createElement('span');
    outDmg.className = 'cr-out';
    outDmg.textContent = `${entry.damageOut} OUT`;
    const outHits = document.createElement('span');
    outHits.className = 'cr-hits';
    outHits.textContent = `${entry.hitsOutHead}H ${entry.hitsOutBody}B`;
    outCol.appendChild(outDmg);
    outCol.appendChild(outHits);

    const inCol = document.createElement('div');
    inCol.className = 'cr-stat';
    const inDmg = document.createElement('span');
    inDmg.className = 'cr-in';
    inDmg.textContent = `${entry.damageIn} IN`;
    const inHits = document.createElement('span');
    inHits.className = 'cr-hits';
    inHits.textContent = `${entry.hitsInHead}H ${entry.hitsInBody}B`;
    inCol.appendChild(inDmg);
    inCol.appendChild(inHits);

    row.appendChild(opp);
    row.appendChild(outCol);
    row.appendChild(inCol);
    combatReportEl.appendChild(row);
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

  syncTopTeamCards(hud);

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

  // Combine ability movement modifiers (Dash / Updraft / Glide / Cryo Slow / Overdrive) with active weapon mobility.
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
    verticalImpulse: baseMove?.verticalImpulse,
    glideFallSpeed: baseMove?.glideFallSpeed,
  };

  // Step player movement only while alive; solid Buy-Barrier colliders inside ARENA_COLLIDERS gate chokes.
  if (isAlive) {
    updatePlayerMovement(player, input, ARENA_COLLIDERS, dt, moveModifiers);

    if (lastHudPhase === 'buy') {
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

  // Auto-Spectate Target Resolution (when dead during combat, follow a living teammate in 1st-person POV)
  let spectateTarget: Combatant | null = null;
  if (!isAlive && lastHudPhase === 'combat') {
    const teammates = match.getLivingTeammates();
    if (teammates.length > 0) {
      spectateTarget = teammates.find((t) => t.id === spectateTargetId) ?? teammates[0];
      spectateTargetId = spectateTarget.id;
    } else {
      spectateTargetId = null;
    }
  } else {
    spectateTargetId = null;
  }

  match.setSpectatedCombatantId(spectateTarget ? spectateTarget.id : null);
  weapon.setViewmodelVisible(isAlive && !spectateTarget);

  if (spectateTarget) {
    const specYaw = spectateTarget.yaw;
    const specPitch = clamp(spectateTarget.pitch, -1.48, 1.48);
    camera.rotation.y = specYaw;
    camera.rotation.x = specPitch;
    camera.rotation.z = 0;

    const specDrop = (spectateTarget.slideTimer ?? 0) > 0 ? -0.42 : 0;
    camera.position.set(
      spectateTarget.position.x,
      spectateTarget.position.y + EYE_HEIGHT + specDrop,
      spectateTarget.position.z
    );
  } else {
    camera.rotation.y = input.yaw;
    camera.rotation.x = effectivePitch;
    camera.rotation.z = slideTiltSmoothed;
    camera.position.set(
      player.position.x,
      player.position.y + EYE_HEIGHT + eyeOffsetSmoothed,
      player.position.z
    );
  }

  // Step weapon cooldowns, spread, hitscan raycast & tracers (only while player is alive).
  const wasReloading = weapon.state.reloading;
  let firedThisFrame = false;

  if (isAlive) {
    // Semi-auto fire buffer: a click during cooldown/reload still fires within 140ms.
    if (fireBufferTimer > 0) input.fireJustPressed = true;

    const remotePoolBefore = net.isOnline()
      ? new Map<string, number>(
          match.combatants
            .filter((c) => c.team === 'enemy' && c.isRemoteHuman && c.alive)
            .map((c) => [c.id, c.health + (c.armor ?? 0)])
        )
      : null;

    const shot = weapon.update(
      dt,
      player,
      input,
      ARENA_COLLIDERS,
      match.enemyTargetsView,
      feedback.fireRateMultiplier,
      feedback.recoilMultiplier,
      feedback.moveSpreadMultiplier,
      feedback.eyeHeightOffset,
      Boolean(feedback.ignoreAirSpread)
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

      if (shot.hitType === 'head' || shot.hitType === 'body') {
        const isHead = shot.hitType === 'head';
        if (isHead) {
          sfx.playHeadshot();
          headshotFlashTimer = 0.16;
          crosshairEl.classList.add('headshot');
          headshotRingEl.classList.add('active');
        } else {
          sfx.playBodyHit();
        }

        hitmarkerTimer = isHead ? 0.16 : 0.13;
        hitmarkerEl.classList.toggle('headshot', isHead);
        hitmarkerEl.classList.add('active');

        if (remotePoolBefore && shot.damageDealt > 0) {
          const hitRemote = match.combatants.find((c) => {
            const before = remotePoolBefore.get(c.id);
            return before !== undefined && c.health + (c.armor ?? 0) < before - 1e-4;
          });
          if (hitRemote) {
            net.sendDamage({
              targetPlayerId: hitRemote.remotePlayerId,
              targetSlotId: hitRemote.id,
              damage: shot.damageDealt,
              headshot: isHead,
              weaponTag: activeSpec.shortTag,
            });
          }
        }
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
    spectateTargetId = null;
    switchAgentColor(c.colorId);
    syncWeaponPills(weapon.currentWeaponId);
  }
  lastHudPhase = hud.phase;
  lastRoundNumber = hud.roundNumber;
  lastPlayerSide = hud.playerSide ?? 'attacker';
  lastSpikeHud = hud.spike ?? null;
  overlaySurrenderBtn.classList.toggle('hidden', hud.phase === 'match_over');

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

  syncAbilitySlot(abilityQEl, currentSettings.keybinds.abilityQ, feedback.qHud);
  syncAbilitySlot(abilityEEl, currentSettings.keybinds.abilityE, feedback.eHud);
  syncAbilityXSlot(hud, feedback.xHud);
  syncScreenFx(feedback);
  syncMatchHud(hud);
  syncKillMedal(hud);
  syncDamageArc(hud, dt, player.health);
  updateTargetIdLabel(isAlive, effectivePitch, feedback.activeSmokes);
  syncSpectatorBar(hud, isAlive, spectateTarget);
  syncCombatReport(hud, isAlive);

  // Beginner control strip fades after ~25s of live combat.
  if (hud.phase === 'combat') {
    combatSecondsPlayed += dt;
    if (combatSecondsPlayed > 25) controlStripEl.classList.add('faded');
  }

  // Sniper scope overlay vs CSS-variable reactive hipfire crosshair + smooth ADS fade.
  const isScopedSniper =
    isAlive && weapon.isScoped && weapon.currentWeaponId === 'sniper';
  scopeOverlayEl.classList.toggle('hidden', !isScopedSniper);
  crosshair.applyFrame(
    weapon.state.currentSpread,
    AGENT_PALETTES[player.colorId].css,
    isScopedSniper
  );

  const adsBlend = weapon.getAdsBlend();
  let crosshairOpacity = 1;
  if (!isAlive) {
    crosshairOpacity = 0;
  } else if (weapon.currentWeaponId !== 'sniper') {
    if (adsBlend > 0.65) {
      crosshairOpacity = 0;
    } else if (adsBlend > 0.25) {
      crosshairOpacity = clamp(1 - (adsBlend - 0.25) / 0.4, 0, 1);
    }
  }
  crosshairEl.style.opacity = crosshairOpacity.toFixed(3);

  if (headshotFlashTimer > 0) {
    headshotFlashTimer -= dt;
    if (headshotFlashTimer <= 0) {
      crosshairEl.classList.remove('headshot');
      headshotRingEl.classList.remove('active');
    }
  }

  if (hitmarkerTimer > 0) {
    hitmarkerTimer -= dt;
    if (hitmarkerTimer <= 0) {
      hitmarkerEl.classList.remove('active', 'headshot');
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
