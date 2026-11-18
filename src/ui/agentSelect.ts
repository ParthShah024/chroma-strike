import * as THREE from 'three';
import {
  AGENT_ORDER,
  AGENT_PALETTES,
  AgentColorId,
  AiDifficulty,
} from '../core/types';
import { AGENT_ABILITIES } from '../abilities/definitions';
import { CharacterRig, createCharacterModel } from '../entities/characterModel';

/**
 * ============================================================================
 * Agent Select — Live 3D Turntable Stage + Roster + Difficulty
 * ============================================================================
 *
 * Layout (`#agent-select-modal`):
 *   - Left 55%  : `<canvas id="agent-select-canvas">` with its OWN compact
 *                 `THREE.WebGLRenderer` (alpha, ACES tone mapping), a 3-point rim
 *                 light rig, a glowing agent-coloured floor ring and the real
 *                 `createCharacterModel(stageScene, 'ally', colorId)` rig turning
 *                 at 0.45 rad/s. Swapping agents disposes the previous preview
 *                 rig and kicks a `triggerFireKick()` pose.
 *   - Right 45% : five colour-coded agent cards (`[1]..[5]`), a segmented
 *                 `CASUAL | TACTICAL | PRO` AI difficulty selector (persisted in
 *                 `localStorage`) and the `LOCK IN [ENTER]` call to action.
 *
 * Performance contract: the stage renderer is only driven from `render(dt)`,
 * and `render(dt)` is a strict no-op unless `isOpen() === true`, so GPU/CPU
 * cost while playing is zero. The preview rig is disposed on every swap so GPU
 * memory stays flat.
 */

export interface AgentSelectOptions {
  /** Agent currently piloted by the human (cards open pre-selected on it). */
  getCurrentAgent: () => AgentColorId;
  /** Fired on LOCK IN with the chosen agent and AI difficulty. */
  onLockIn: (colorId: AgentColorId, difficulty: AiDifficulty) => void;
  /** Fired live whenever the difficulty segmented control changes. */
  onDifficultyChange?: (difficulty: AiDifficulty) => void;
  /** Fired whenever the modal closes (lock-in, close button, Escape or toggle). */
  onClose?: () => void;
  /** Whether the modal may be dismissed without locking in (false on first launch). */
  canDismiss?: () => boolean;
}

export interface AgentSelectController {
  open(initial?: AgentColorId): void;
  close(): void;
  toggle(): boolean;
  isOpen(): boolean;
  /** Advances + draws the stage. Strict no-op while the modal is closed. */
  render(dt: number): void;
  getPreviewAgent(): AgentColorId;
  getDifficulty(): AiDifficulty;
  setDifficulty(diff: AiDifficulty): void;
  /** Programmatically trigger LOCK IN with the current preview agent. */
  lockIn(): void;
  dispose(): void;
}

const DIFFICULTY_STORAGE_KEY = 'chroma-strike.difficulty.v1';
const STAGE_TURN_RAD_PER_SEC = 0.45;
const STAGE_CAMERA_FOV_DEG = 30;
const STAGE_EXPOSURE = 1.12;

const DIFFICULTIES: readonly AiDifficulty[] = ['casual', 'tactical', 'pro'];

const ROLE_BLURB: Record<string, string> = {
  Duelist: 'Entry fragger',
  Controller: 'Zone & vision',
  Initiator: 'Opens fights',
};

export function loadSavedDifficulty(): AiDifficulty {
  try {
    const raw = window.localStorage.getItem(DIFFICULTY_STORAGE_KEY);
    if (raw === 'casual' || raw === 'tactical' || raw === 'pro') return raw;
  } catch {
    /* storage unavailable (private mode) — fall through to default */
  }
  return 'casual';
}

function saveDifficulty(diff: AiDifficulty): void {
  try {
    window.localStorage.setItem(DIFFICULTY_STORAGE_KEY, diff);
  } catch {
    /* ignore */
  }
}

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Agent Select: missing #${id} in index.html`);
  return el as T;
}

export function createAgentSelectController(options: AgentSelectOptions): AgentSelectController {
  const modal = requireEl<HTMLDivElement>('agent-select-modal');
  const canvas = requireEl<HTMLCanvasElement>('agent-select-canvas');
  const cardList = requireEl<HTMLDivElement>('agent-card-list');
  const lockInBtn = requireEl<HTMLButtonElement>('agent-lockin-btn');
  const closeBtn = requireEl<HTMLButtonElement>('agent-select-close');
  const stageNameEl = document.getElementById('agent-stage-name');
  const stageRoleEl = document.getElementById('agent-stage-role');
  const diffPills = Array.from(
    modal.querySelectorAll<HTMLButtonElement>('.diff-pill[data-diff]')
  );

  let open = false;
  let previewColor: AgentColorId = options.getCurrentAgent();
  let difficulty: AiDifficulty = loadSavedDifficulty();

  // -------------------------------------------------------------------------
  // Roster cards
  // -------------------------------------------------------------------------
  const cardById = new Map<AgentColorId, HTMLButtonElement>();

  AGENT_ORDER.forEach((id, index) => {
    const palette = AGENT_PALETTES[id];
    const abilities = AGENT_ABILITIES[id];
    const [codename, tag = ''] = palette.name.split(' ');

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'agent-card';
    card.dataset.color = id;
    card.style.setProperty('--card-accent', palette.css);
    card.innerHTML = `
      <span class="agent-card-bar"></span>
      <span class="agent-card-body">
        <span class="agent-card-head">
          <span class="agent-card-key">${index + 1}</span>
          <span class="agent-card-name">${codename}<em>${tag}</em></span>
          <span class="agent-role-badge">${palette.role}</span>
        </span>
        <span class="agent-ability-row">
          <span class="agent-ability-chip">Q</span>
          <span class="agent-ability-text"><b>${abilities.q.name}</b> ${abilities.q.description}</span>
        </span>
        <span class="agent-ability-row">
          <span class="agent-ability-chip">E</span>
          <span class="agent-ability-text"><b>${abilities.e.name}</b> ${abilities.e.description}</span>
        </span>
      </span>`;
    card.addEventListener('click', () => selectAgent(id, true));
    card.addEventListener('dblclick', () => lockIn());
    cardList.appendChild(card);
    cardById.set(id, card);
  });

  function syncCards(): void {
    for (const [id, card] of cardById) {
      card.classList.toggle('selected', id === previewColor);
      card.setAttribute('aria-pressed', id === previewColor ? 'true' : 'false');
    }
    const palette = AGENT_PALETTES[previewColor];
    modal.style.setProperty('--agent-accent', palette.css);
    if (stageNameEl) stageNameEl.textContent = palette.name.split(' ')[0].toUpperCase();
    if (stageRoleEl) {
      stageRoleEl.textContent = `${palette.role.toUpperCase()} • ${ROLE_BLURB[palette.role] ?? ''}`;
    }
  }

  function syncDifficultyPills(): void {
    for (const pill of diffPills) {
      const active = pill.dataset.diff === difficulty;
      pill.classList.toggle('active', active);
      pill.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function setDifficulty(diff: AiDifficulty): void {
    if (!DIFFICULTIES.includes(diff)) return;
    difficulty = diff;
    saveDifficulty(diff);
    syncDifficultyPills();
    options.onDifficultyChange?.(diff);
  }

  for (const pill of diffPills) {
    pill.addEventListener('click', () => {
      setDifficulty((pill.dataset.diff as AiDifficulty) ?? 'casual');
    });
  }

  // -------------------------------------------------------------------------
  // Live 3D stage (lazy: created on first open, driven only while open)
  // -------------------------------------------------------------------------
  let renderer: THREE.WebGLRenderer | null = null;
  let stageUnavailable = false;
  const stageScene = new THREE.Scene();
  const stageCamera = new THREE.PerspectiveCamera(STAGE_CAMERA_FOV_DEG, 1, 0.1, 40);
  stageCamera.position.set(0, 1.25, 5.1);
  stageCamera.lookAt(0, 0.98, 0);

  const hemi = new THREE.HemisphereLight(0x9fb2d6, 0x0b0e14, 0.7);
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.3);
  keyLight.position.set(2.6, 3.6, 3.8);
  const rimLeft = new THREE.DirectionalLight(0xffffff, 3.2);
  rimLeft.position.set(-3.2, 2.6, -2.8);
  const rimRight = new THREE.DirectionalLight(0xffffff, 2.2);
  rimRight.position.set(3.4, 1.9, -2.4);
  const floorGlow = new THREE.PointLight(0xffffff, 3.0, 5.5, 1.6);
  floorGlow.position.set(0, 0.25, 0);
  stageScene.add(hemi, keyLight, rimLeft, rimRight, floorGlow);

  const floorDisc = new THREE.Mesh(
    new THREE.CircleGeometry(1.7, 64),
    new THREE.MeshBasicMaterial({ color: 0x07090d, transparent: true, opacity: 0.62 })
  );
  floorDisc.rotation.x = -Math.PI / 2;
  floorDisc.position.y = 0.002;

  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const innerRing = new THREE.Mesh(new THREE.RingGeometry(1.02, 1.12, 96), ringMat);
  innerRing.rotation.x = -Math.PI / 2;
  innerRing.position.y = 0.006;

  const haloMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.28,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const outerHalo = new THREE.Mesh(new THREE.RingGeometry(1.3, 1.62, 96), haloMat);
  outerHalo.rotation.x = -Math.PI / 2;
  outerHalo.position.y = 0.004;
  stageScene.add(floorDisc, innerRing, outerHalo);

  let previewRig: CharacterRig | null = null;
  let stageYaw = 0.5;
  let stageTime = 0;
  let nextIdleKickSec = 3.2;
  let sizeW = 0;
  let sizeH = 0;

  function ensureRenderer(): boolean {
    if (renderer) return true;
    if (stageUnavailable) return false;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = STAGE_EXPOSURE;
      renderer.setClearColor(0x000000, 0);
      return true;
    } catch {
      stageUnavailable = true;
      renderer = null;
      return false;
    }
  }

  function resizeStage(): void {
    if (!renderer) return;
    const w = Math.max(2, canvas.clientWidth);
    const h = Math.max(2, canvas.clientHeight);
    if (w === sizeW && h === sizeH) return;
    sizeW = w;
    sizeH = h;
    renderer.setSize(w, h, false);
    stageCamera.aspect = w / h;
    // Keep the full figure framed on tall/narrow stages by widening the vertical FOV.
    stageCamera.fov = stageCamera.aspect < 0.85 ? STAGE_CAMERA_FOV_DEG / Math.max(0.55, stageCamera.aspect) : STAGE_CAMERA_FOV_DEG;
    stageCamera.updateProjectionMatrix();
  }

  function applyStageColors(colorId: AgentColorId): void {
    const hex = AGENT_PALETTES[colorId].hex;
    ringMat.color.setHex(hex);
    haloMat.color.setHex(hex);
    rimLeft.color.setHex(hex);
    floorGlow.color.setHex(hex);
    rimRight.color.set(0xbfe6ff).lerp(new THREE.Color(hex), 0.35);
  }

  function rebuildPreviewRig(colorId: AgentColorId, kick: boolean): void {
    if (previewRig) {
      previewRig.dispose(stageScene);
      previewRig = null;
    }
    previewRig = createCharacterModel(stageScene, 'ally', colorId);
    previewRig.setWeaponModel('ar');
    previewRig.setVisible(true);
    applyStageColors(colorId);
    if (kick) previewRig.triggerFireKick();
    nextIdleKickSec = stageTime + 3.2;
  }

  function selectAgent(colorId: AgentColorId, kick: boolean): void {
    const changed = colorId !== previewColor || previewRig === null;
    previewColor = colorId;
    syncCards();
    if (changed && open && ensureRenderer()) {
      rebuildPreviewRig(colorId, kick);
      // Brief accent wash on the stage when a new agent is picked.
      modal.classList.remove('agent-flash');
      void modal.offsetWidth; // restart CSS animation
      modal.classList.add('agent-flash');
    }
  }

  const STAGE_CAM_POS = { x: stageCamera.position.x, y: stageCamera.position.y, z: stageCamera.position.z };

  function render(dt: number): void {
    // Strict gate: zero GPU/CPU cost while the modal is closed.
    if (!open || !renderer) return;
    const step = Math.min(Math.max(dt, 0), 0.05);
    resizeStage();

    stageTime += step;
    stageYaw += STAGE_TURN_RAD_PER_SEC * step;

    if (previewRig) {
      if (stageTime >= nextIdleKickSec) {
        previewRig.triggerFireKick();
        nextIdleKickSec = stageTime + 3.6;
      }
      previewRig.update(
        step,
        {
          position: { x: 0, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
          yaw: stageYaw,
          pitch: 0,
          health: 100,
          maxHealth: 100,
          alive: true,
          slowTimer: 0,
          blindTimer: 0,
          occludedBySmoke: false,
          slideTimer: 0,
          concussTimer: 0,
        },
        STAGE_CAM_POS
      );
    }

    // Gentle breathing pulse on the neon floor rings.
    const pulse = 0.5 + 0.5 * Math.sin(stageTime * 2.2);
    ringMat.opacity = 0.78 + pulse * 0.22;
    haloMat.opacity = 0.16 + pulse * 0.16;
    const haloScale = 1 + pulse * 0.035;
    outerHalo.scale.set(haloScale, haloScale, 1);
    floorGlow.intensity = 2.4 + pulse * 1.2;

    renderer.render(stageScene, stageCamera);
  }

  // -------------------------------------------------------------------------
  // Open / close / lock-in
  // -------------------------------------------------------------------------
  function openModal(initial?: AgentColorId): void {
    previewColor = initial ?? options.getCurrentAgent();
    open = true;
    modal.classList.remove('hidden');
    closeBtn.classList.toggle('hidden', !(options.canDismiss?.() ?? true));
    syncCards();
    syncDifficultyPills();
    sizeW = 0;
    sizeH = 0;
    if (ensureRenderer()) {
      resizeStage();
      rebuildPreviewRig(previewColor, true);
    }
    modal.classList.remove('agent-flash');
    void modal.offsetWidth;
    modal.classList.add('agent-flash');
    lockInBtn.focus({ preventScroll: true });
  }

  function closeModal(): void {
    if (!open) return;
    open = false;
    modal.classList.add('hidden');
    // Free the preview rig so nothing GPU-side lingers while playing.
    if (previewRig) {
      previewRig.dispose(stageScene);
      previewRig = null;
    }
    options.onClose?.();
  }

  function lockIn(): void {
    if (!open) return;
    const chosen = previewColor;
    closeModal();
    options.onLockIn(chosen, difficulty);
  }

  lockInBtn.addEventListener('click', () => lockIn());
  closeBtn.addEventListener('click', () => {
    if (options.canDismiss?.() ?? true) closeModal();
  });

  // Keyboard: [1..5] pick, [Up/Down] cycle, [Enter] lock in, [Esc] dismiss (if allowed).
  // Consumed keys call `preventDefault()` so main.ts's global handler skips them.
  function onKeyDown(e: KeyboardEvent): void {
    if (!open) return;
    const digit = /^Digit([1-5])$/.exec(e.code);
    if (digit) {
      selectAgent(AGENT_ORDER[Number(digit[1]) - 1], true);
      e.preventDefault();
      return;
    }
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      const dir = e.code === 'ArrowDown' ? 1 : -1;
      const idx = AGENT_ORDER.indexOf(previewColor);
      selectAgent(AGENT_ORDER[(idx + dir + AGENT_ORDER.length) % AGENT_ORDER.length], true);
      e.preventDefault();
      return;
    }
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      const idx = DIFFICULTIES.indexOf(difficulty);
      const dir = e.code === 'ArrowRight' ? 1 : -1;
      setDifficulty(DIFFICULTIES[(idx + dir + DIFFICULTIES.length) % DIFFICULTIES.length]);
      e.preventDefault();
      return;
    }
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat) {
      lockIn();
      e.preventDefault();
      return;
    }
    if (e.code === 'Escape') {
      if (options.canDismiss?.() ?? true) closeModal();
      e.preventDefault();
      return;
    }
    if (e.code === 'Space' || e.code === 'Tab' || /^F[1-5]$/.test(e.code)) {
      e.preventDefault();
    }
  }
  window.addEventListener('keydown', onKeyDown);

  // Make sure we start in a consistent closed state.
  modal.classList.add('hidden');
  syncCards();
  syncDifficultyPills();

  function dispose(): void {
    window.removeEventListener('keydown', onKeyDown);
    if (previewRig) {
      previewRig.dispose(stageScene);
      previewRig = null;
    }
    floorDisc.geometry.dispose();
    (floorDisc.material as THREE.Material).dispose();
    innerRing.geometry.dispose();
    outerHalo.geometry.dispose();
    ringMat.dispose();
    haloMat.dispose();
    renderer?.dispose();
    renderer = null;
  }

  return {
    open: openModal,
    close: closeModal,
    toggle(): boolean {
      if (open) closeModal();
      else openModal();
      return open;
    },
    isOpen: () => open,
    render,
    getPreviewAgent: () => previewColor,
    getDifficulty: () => difficulty,
    setDifficulty,
    lockIn,
    dispose,
  };
}
