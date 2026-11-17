import * as THREE from 'three';
import {
  AGENT_PALETTES,
  AbilityFrameFeedback,
  AbilityHudSlotState,
  AgentColorId,
  InputState,
  MatchHudState,
  MovementModifiers,
  RoundPhase,
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
import { ARENA_COLLIDERS, PLAYER_SPAWN, buildArenaScene } from './arena/map';
import { WEAPON_SPECS } from './combat/arsenal';
import { createWeaponSystem } from './combat/weapons';
import { createAbilitySystem } from './abilities/system';
import { createSoundEngine } from './audio/sfx';
import { createMatchManager } from './match/roundManager';
import { createCrosshairController } from './ui/crosshair';

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
// YXZ Euler order applies yaw (around world Y) before pitch (around local X),
// preventing camera roll/tilt when looking diagonally in an FPS.
camera.rotation.order = 'YXZ';
// Crucial: add the camera to the scene so child meshes attached to it
// (such as our first-person weapon viewmodels) are rendered!
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// 2. Arena, Match Manager, Arsenal, Abilities, Crosshair & Audio Integration
// ---------------------------------------------------------------------------
buildArenaScene(scene);

const player = createInitialPlayerState(PLAYER_SPAWN);
const sfx = createSoundEngine();
const weapon = createWeaponSystem(camera, scene, player.colorId);
const abilities = createAbilitySystem(scene);
const match = createMatchManager(scene, abilities, weapon, sfx);
const crosshair = createCrosshairController();

let lastAbilityFeedback: AbilityFrameFeedback | null = null;
let thirdPerson = false;
let lastHudPhase: RoundPhase = 'buy';
let lastRoundNumber = 1;

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
const screenFxEl = document.getElementById('screen-fx') as HTMLDivElement;
const scopeOverlayEl = document.getElementById('scope-overlay') as HTMLDivElement;
const crosshairEl = document.getElementById('crosshair') as HTMLDivElement;
const headshotRingEl = document.getElementById('headshot-ring') as HTMLDivElement;

const allyScoreEl = document.getElementById('ally-score') as HTMLDivElement;
const enemyScoreEl = document.getElementById('enemy-score') as HTMLDivElement;
const roundPhaseLabelEl = document.getElementById('round-phase-label') as HTMLDivElement;
const roundClockEl = document.getElementById('round-clock') as HTMLDivElement;
const allyDots = Array.from(
  document.querySelectorAll<HTMLDivElement>('#ally-dots .agent-dot')
);
const enemyDots = Array.from(
  document.querySelectorAll<HTMLDivElement>('#enemy-dots .agent-dot')
);

const killfeedEl = document.getElementById('killfeed') as HTMLDivElement;
const roundBannerEl = document.getElementById('round-banner') as HTMLDivElement;
const roundBannerTitleEl = document.getElementById('round-banner-title') as HTMLDivElement;
const roundBannerSubEl = document.getElementById('round-banner-sub') as HTMLDivElement;

const hpEl = document.getElementById('hud-hp') as HTMLDivElement;
const abilityQEl = document.getElementById('ability-q') as HTMLDivElement;
const abilityEEl = document.getElementById('ability-e') as HTMLDivElement;
const ammoEl = document.getElementById('hud-ammo') as HTMLDivElement;
const speedEl = document.getElementById('hud-speed') as HTMLDivElement;
const hint3pEl = document.getElementById('hint-3p') as HTMLDivElement;
const hintXhairEl = document.getElementById('hint-xhair') as HTMLDivElement;

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
  for (const pill of weaponPills) {
    pill.classList.toggle('active', pill.dataset.weapon === weaponId);
  }
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
  if (weapon.currentWeaponId !== c.weaponId) {
    weapon.equipWeapon(c.weaponId);
  }
  syncWeaponPills(weapon.currentWeaponId);
}

// Initialize local player state and HUD accent to match the starting combatant.
syncLocalPlayerFromCombatant();

// ---------------------------------------------------------------------------
// 4. Pointer Lock, Mouse Look (Focal-Length Zoom Scaling) & Input Bindings
// ---------------------------------------------------------------------------
function isPointerLocked(): boolean {
  return document.pointerLockElement === canvas;
}

function syncOverlayVisibility(): void {
  // Keep `#overlay` hidden while either playing (pointer locked) OR editing crosshair.
  overlayEl.classList.toggle('hidden', isPointerLocked() || crosshair.isOpen());
  hintXhairEl.classList.toggle('active', crosshair.isOpen());
}

crosshair.setOnClose(() => {
  syncOverlayVisibility();
  canvas.requestPointerLock();
});

overlayEl.addEventListener('click', () => {
  if (crosshair.isOpen()) return;
  sfx.unlock();
  canvas.requestPointerLock();
});

openXhairFromOverlayBtn.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  sfx.unlock();
  crosshair.open();
  syncOverlayVisibility();
});

canvas.addEventListener('click', () => {
  if (crosshair.isOpen()) return;
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
    input.forward = false;
    input.backward = false;
    input.left = false;
    input.right = false;
    input.walk = false;
    input.jump = false;
    input.fire = false;
    input.fireJustPressed = false;
    input.reload = false;
  }
});

document.addEventListener('mousemove', (e: MouseEvent) => {
  if (!isPointerLocked() || crosshair.isOpen()) return;

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
  if (!isPointerLocked() || crosshair.isOpen()) return;
  sfx.unlock();

  if (e.button === 0) {
    input.fire = true;
    input.fireJustPressed = true;
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
    if (!isPointerLocked() || crosshair.isOpen()) return;
    if (!match.getPlayerCombatant().alive) return;
    const dir = Math.sign(e.deltaY);
    if (dir !== 0) {
      weapon.cycleWeapon(dir);
      input.ads = weapon.isScoped;
      syncWeaponPills(weapon.currentWeaponId);
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
      input.jump = isDown;
      break;
    case 'KeyR':
      input.reload = isDown;
      break;
    case 'Digit1':
      if (isDown && isPointerLocked() && match.getPlayerCombatant().alive) {
        weapon.equipWeapon('pistol');
        input.ads = weapon.isScoped;
        syncWeaponPills(weapon.currentWeaponId);
      }
      break;
    case 'Digit2':
      if (isDown && isPointerLocked() && match.getPlayerCombatant().alive) {
        weapon.equipWeapon('smg');
        input.ads = weapon.isScoped;
        syncWeaponPills(weapon.currentWeaponId);
      }
      break;
    case 'Digit3':
      if (isDown && isPointerLocked() && match.getPlayerCombatant().alive) {
        weapon.equipWeapon('ar');
        input.ads = weapon.isScoped;
        syncWeaponPills(weapon.currentWeaponId);
      }
      break;
    case 'Digit4':
      if (isDown && isPointerLocked() && match.getPlayerCombatant().alive) {
        weapon.equipWeapon('sniper');
        input.ads = weapon.isScoped;
        syncWeaponPills(weapon.currentWeaponId);
      }
      break;
  }
}

window.addEventListener('keydown', (e: KeyboardEvent) => {
  sfx.unlock();

  if (
    e.code === 'Space' ||
    e.code === 'Tab' ||
    e.code === 'F1' ||
    e.code === 'F2' ||
    e.code === 'F3'
  ) {
    e.preventDefault();
  }

  if (!e.repeat) {
    // [C] Crosshair Customizer modal toggle
    if (e.code === 'KeyC') {
      const nowOpen = crosshair.toggle();
      if (nowOpen) {
        if (isPointerLocked()) {
          document.exitPointerLock();
        }
      }
      syncOverlayVisibility();
      return;
    }

    if (crosshair.isOpen()) {
      return;
    }

    // [F1..F3] Switch active Agent
    if (e.code === 'F1' || e.code === 'F2' || e.code === 'F3') {
      const targetColor: AgentColorId =
        e.code === 'F1' ? 'red' : e.code === 'F2' ? 'blue' : 'green';
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
      return;
    }

    if (isPointerLocked()) {
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
  el.classList.toggle('ready', slot.ready);
  const pct = slot.ready
    ? 100
    : clamp((1 - slot.cooldownRemaining / Math.max(slot.cooldownTotal, 0.001)) * 100, 0, 100);
  el.style.setProperty('--cd-pct', `${pct.toFixed(1)}%`);

  if (slot.ready) {
    el.innerHTML = `<span class="ab-key">[${keyLabel}]</span>${slot.shortTag}`;
  } else {
    el.innerHTML = `<span class="ab-key">[${keyLabel}]</span>${slot.cooldownRemaining.toFixed(1)}s`;
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

  for (const dot of allyDots) {
    const color = dot.dataset.color as AgentColorId | undefined;
    const st = hud.allyStates.find((a) => a.colorId === color);
    dot.classList.toggle('dead', !st?.alive);
    dot.classList.toggle('is-player', Boolean(st?.isPlayer));
  }

  for (const dot of enemyDots) {
    const color = dot.dataset.color as AgentColorId | undefined;
    const st = hud.enemyStates.find((e) => e.colorId === color);
    dot.classList.toggle('dead', !st?.alive);
  }

  for (const pill of agentPills) {
    const color = pill.dataset.color as AgentColorId | undefined;
    const st = hud.allyStates.find((a) => a.colorId === color);
    pill.classList.toggle('dead', !st?.alive);
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

  const playerCombatant = match.getPlayerCombatant();
  const isAlive = playerCombatant.alive;
  const activeSpec = WEAPON_SPECS[weapon.currentWeaponId];

  // Combine ability movement modifiers (Dash / Cryo Slow) with active weapon mobility.
  const baseMove = lastAbilityFeedback?.movement;
  const moveModifiers: MovementModifiers = {
    dashActive: baseMove?.dashActive ?? false,
    dashVelocity: baseMove?.dashVelocity ?? { x: 0, y: 0, z: 0 },
    speedMultiplier: (baseMove?.speedMultiplier ?? 1.0) * activeSpec.moveSpeedMult,
    suppressJump: baseMove?.suppressJump,
  };

  // Step player movement only while alive; clamp inside attacker spawn box during Buy phase.
  if (isAlive) {
    updatePlayerMovement(player, input, ARENA_COLLIDERS, dt, moveModifiers);

    if (lastHudPhase === 'buy') {
      if (player.position.z < 16.5) {
        player.position.z = 16.5;
        if (player.velocity.z < 0) player.velocity.z = 0;
      } else if (player.position.z > 24.5) {
        player.position.z = 24.5;
        if (player.velocity.z > 0) player.velocity.z = 0;
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

  // Target FOV: smooth optical zoom when scoped with an ADS-capable weapon,
  // otherwise hipfire 75° + Crimson Dash FOV punch.
  const adsFov = activeSpec.adsFovDeg;
  const targetFov =
    isAlive && weapon.isScoped && adsFov != null
      ? adsFov
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

  // Camera Positioning: 1st-Person vs Wall-Clamped 3rd-Person Over-the-Shoulder
  const useThirdPersonCamera = thirdPerson || !isAlive;
  weapon.setViewmodelVisible(!useThirdPersonCamera);

  if (!useThirdPersonCamera) {
    camera.position.set(
      player.position.x,
      player.position.y + EYE_HEIGHT,
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
      y: player.position.y + 1.68,
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
    const shot = weapon.update(
      dt,
      player,
      input,
      ARENA_COLLIDERS,
      match.enemyTargetsView,
      feedback.fireRateMultiplier,
      feedback.recoilMultiplier
    );
    firedThisFrame = shot.fired;

    if (!wasReloading && weapon.state.reloading) {
      sfx.playReload();
    }

    if (shot.fired) {
      sfx.playWeaponShot(weapon.currentWeaponId, feedback.stimActive, 0);
      if (shot.hitType === 'head') {
        sfx.playHeadshot();
        headshotFlashTimer = 0.16;
        crosshairEl.classList.add('headshot');
        headshotRingEl.classList.add('active');
      } else if (shot.hitType === 'body') {
        sfx.playBodyHit();
      }
    }
  }

  // Push local player physics/aim state into match manager & advance 3v3 bots/round clock.
  match.syncPlayerFromPhysics(
    player,
    input.yaw,
    input.pitch,
    weapon.currentWeaponId,
    firedThisFrame
  );
  const hud = match.update(dt, player, camera.position, feedback.activeSmokes);

  // When a new round begins, snap local orientation & UI highlights cleanly to the spawned agent.
  if (hud.roundNumber !== lastRoundNumber || (lastHudPhase === 'match_over' && hud.phase === 'buy')) {
    const c = match.getPlayerCombatant();
    input.yaw = c.yaw;
    input.pitch = c.pitch;
    switchAgentColor(player.colorId);
    syncWeaponPills(weapon.currentWeaponId);
  }
  lastHudPhase = hud.phase;
  lastRoundNumber = hud.roundNumber;

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

  // Update ammo readout and active weapon pill.
  syncWeaponPills(weapon.currentWeaponId);
  if (weapon.state.reloading) {
    ammoEl.innerHTML = `<span class="muted">RELOAD...</span>`;
  } else {
    ammoEl.innerHTML = `${weapon.state.ammo} <span class="muted">/ ${activeSpec.maxAmmo}</span>`;
  }

  renderer.render(scene, camera);

  // Clear one-frame semi-auto trigger flag at the end of the tick.
  input.fireJustPressed = false;
}

requestAnimationFrame(tick);
