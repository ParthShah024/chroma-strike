import type { AiDifficulty, GameSettings, TacticalSide } from '../core/types';

export type SettingsTabId = 'controls' | 'crosshair' | 'video' | 'audio' | 'match';

export const SETTINGS_STORAGE_KEY = 'chroma_strike_settings_v1';

export const DEFAULT_GAME_SETTINGS: GameSettings = {
  mouseSensitivity: 0.85,
  adsSensitivityMult: 0.75,
  invertY: false,
  fovDeg: 82,
  shadowsEnabled: true,
  minimapRotate: true,
  minimapSize: 'standard',
  showFps: false,
  masterVolume: 0.85,
  muted: false,
  difficulty: 'casual',
  defaultSide: 'attacker',
  winTarget: 10,
};

export interface SettingsController {
  getSettings(): GameSettings;
  isOpen(): boolean;
  open(tab?: SettingsTabId): void;
  close(): void;
  toggle(tab?: SettingsTabId): boolean;
  setActiveTab(tab: SettingsTabId): void;
  applyPatch(patch: Partial<GameSettings>): void;
  resetDefaults(): void;
  setOnChange(cb: (s: GameSettings) => void): void;
  setOnClose(cb: () => void): void;
}

const VALID_TABS: readonly SettingsTabId[] = ['controls', 'crosshair', 'video', 'audio', 'match'];
const VALID_MINIMAP_SIZES: readonly GameSettings['minimapSize'][] = [
  'compact',
  'standard',
  'large',
];
const VALID_DIFFICULTIES: readonly AiDifficulty[] = ['casual', 'tactical', 'pro'];
const VALID_SIDES: readonly TacticalSide[] = ['attacker', 'defender'];

function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, num));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, num));
}

function sanitizeSettings(raw: Partial<GameSettings> | null | undefined): GameSettings {
  const src = raw ?? {};
  return {
    mouseSensitivity: clampFloat(
      src.mouseSensitivity,
      0.05,
      5.0,
      DEFAULT_GAME_SETTINGS.mouseSensitivity
    ),
    adsSensitivityMult: clampFloat(
      src.adsSensitivityMult,
      0.1,
      2.0,
      DEFAULT_GAME_SETTINGS.adsSensitivityMult
    ),
    invertY: typeof src.invertY === 'boolean' ? src.invertY : DEFAULT_GAME_SETTINGS.invertY,
    fovDeg: clampInt(src.fovDeg, 60, 110, DEFAULT_GAME_SETTINGS.fovDeg),
    shadowsEnabled:
      typeof src.shadowsEnabled === 'boolean'
        ? src.shadowsEnabled
        : DEFAULT_GAME_SETTINGS.shadowsEnabled,
    minimapRotate:
      typeof src.minimapRotate === 'boolean'
        ? src.minimapRotate
        : DEFAULT_GAME_SETTINGS.minimapRotate,
    minimapSize: VALID_MINIMAP_SIZES.includes(src.minimapSize as GameSettings['minimapSize'])
      ? (src.minimapSize as GameSettings['minimapSize'])
      : DEFAULT_GAME_SETTINGS.minimapSize,
    showFps: typeof src.showFps === 'boolean' ? src.showFps : DEFAULT_GAME_SETTINGS.showFps,
    masterVolume: clampFloat(src.masterVolume, 0, 1, DEFAULT_GAME_SETTINGS.masterVolume),
    muted: typeof src.muted === 'boolean' ? src.muted : DEFAULT_GAME_SETTINGS.muted,
    difficulty: VALID_DIFFICULTIES.includes(src.difficulty as AiDifficulty)
      ? (src.difficulty as AiDifficulty)
      : DEFAULT_GAME_SETTINGS.difficulty,
    defaultSide: VALID_SIDES.includes(src.defaultSide as TacticalSide)
      ? (src.defaultSide as TacticalSide)
      : DEFAULT_GAME_SETTINGS.defaultSide,
    winTarget: src.winTarget === 6 || src.winTarget === 10 ? src.winTarget : DEFAULT_GAME_SETTINGS.winTarget,
  };
}

function loadSettings(): GameSettings {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_GAME_SETTINGS };
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GAME_SETTINGS };
    return sanitizeSettings(JSON.parse(raw) as Partial<GameSettings>);
  } catch {
    return { ...DEFAULT_GAME_SETTINGS };
  }
}

function saveSettings(settings: GameSettings): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota or private-browsing failures cleanly.
  }
}

function safeGetEl<T extends HTMLElement>(id: string): T | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id) as T | null;
}

/**
 * Creates the persistent Settings Modal controller (`#settings-modal`) managing
 * Controls, Crosshair host tab, Video & Minimap, Audio, and Match preferences.
 */
export function createSettingsController(): SettingsController {
  let settings: GameSettings = loadSettings();
  let openState = false;
  let activeTab: SettingsTabId = 'controls';
  let onChangeCallback: ((s: GameSettings) => void) | null = null;
  let onCloseCallback: (() => void) | null = null;

  const modalEl = safeGetEl<HTMLDivElement>('settings-modal');
  const closeBtn = safeGetEl<HTMLButtonElement>('settings-close-btn');
  const resetBtn = safeGetEl<HTMLButtonElement>('settings-reset-btn');

  const tabButtons =
    typeof document !== 'undefined'
      ? Array.from(document.querySelectorAll<HTMLElement>('[data-settings-tab]'))
      : [];
  const panels =
    typeof document !== 'undefined'
      ? Array.from(document.querySelectorAll<HTMLElement>('[data-settings-panel]'))
      : [];

  // Controls tab
  const mouseSensInput = safeGetEl<HTMLInputElement>('set-mouse-sens');
  const mouseSensVal = safeGetEl<HTMLElement>('set-mouse-sens-val');
  const adsSensInput = safeGetEl<HTMLInputElement>('set-ads-sens');
  const adsSensVal = safeGetEl<HTMLElement>('set-ads-sens-val');
  const invertYInput = safeGetEl<HTMLInputElement>('set-invert-y');

  // Video & Minimap tab
  const fovInput = safeGetEl<HTMLInputElement>('set-fov');
  const fovVal = safeGetEl<HTMLElement>('set-fov-val');
  const shadowsInput = safeGetEl<HTMLInputElement>('set-shadows');
  const minimapRotateInput = safeGetEl<HTMLInputElement>('set-minimap-rotate');
  const minimapSizeSelect = safeGetEl<HTMLSelectElement>('set-minimap-size');
  const showFpsInput = safeGetEl<HTMLInputElement>('set-show-fps');

  // Audio tab
  const masterVolInput = safeGetEl<HTMLInputElement>('set-master-vol');
  const masterVolVal = safeGetEl<HTMLElement>('set-master-vol-val');
  const mutedInput = safeGetEl<HTMLInputElement>('set-muted');

  // Match tab
  const difficultySelect = safeGetEl<HTMLSelectElement>('set-difficulty');
  const defaultSideSelect = safeGetEl<HTMLSelectElement>('set-default-side');
  const winTargetSelect = safeGetEl<HTMLSelectElement>('set-win-target');

  function syncTabs(): void {
    for (const btn of tabButtons) {
      const tab = btn.dataset.settingsTab as SettingsTabId | undefined;
      const isActive = tab === activeTab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
    for (const panel of panels) {
      const tab = panel.dataset.settingsPanel as SettingsTabId | undefined;
      const isActive = tab === activeTab;
      panel.classList.toggle('hidden', !isActive);
      panel.classList.toggle('active', isActive);
    }
  }

  function syncControls(): void {
    if (mouseSensInput) mouseSensInput.value = settings.mouseSensitivity.toFixed(2);
    if (mouseSensVal) mouseSensVal.textContent = settings.mouseSensitivity.toFixed(2);

    if (adsSensInput) adsSensInput.value = settings.adsSensitivityMult.toFixed(2);
    if (adsSensVal) adsSensVal.textContent = `${settings.adsSensitivityMult.toFixed(2)}x`;

    if (invertYInput) invertYInput.checked = settings.invertY;

    if (fovInput) fovInput.value = String(settings.fovDeg);
    if (fovVal) fovVal.textContent = `${settings.fovDeg}°`;

    if (shadowsInput) shadowsInput.checked = settings.shadowsEnabled;
    if (minimapRotateInput) minimapRotateInput.checked = settings.minimapRotate;
    if (minimapSizeSelect) minimapSizeSelect.value = settings.minimapSize;
    if (showFpsInput) showFpsInput.checked = settings.showFps;

    const volPct = Math.round(settings.masterVolume * 100);
    if (masterVolInput) masterVolInput.value = String(volPct);
    if (masterVolVal) masterVolVal.textContent = `${volPct}%`;
    if (mutedInput) mutedInput.checked = settings.muted;

    if (difficultySelect) difficultySelect.value = settings.difficulty;
    if (defaultSideSelect) defaultSideSelect.value = settings.defaultSide;
    if (winTargetSelect) winTargetSelect.value = String(settings.winTarget);
  }

  function applyPatch(patch: Partial<GameSettings>): void {
    settings = sanitizeSettings({ ...settings, ...patch });
    saveSettings(settings);
    syncControls();
    onChangeCallback?.({ ...settings });
  }

  function resetDefaults(): void {
    settings = { ...DEFAULT_GAME_SETTINGS };
    saveSettings(settings);
    syncControls();
    onChangeCallback?.({ ...settings });
  }

  function setActiveTab(tab: SettingsTabId): void {
    if (!VALID_TABS.includes(tab)) return;
    activeTab = tab;
    syncTabs();
  }

  function open(tab?: SettingsTabId): void {
    if (tab) {
      setActiveTab(tab);
    }
    openState = true;
    syncTabs();
    syncControls();
    modalEl?.classList.remove('hidden');
  }

  function close(): void {
    if (!openState) return;
    openState = false;
    modalEl?.classList.add('hidden');
    onCloseCallback?.();
  }

  function toggle(tab?: SettingsTabId): boolean {
    if (openState) {
      close();
    } else {
      open(tab);
    }
    return openState;
  }

  // Bind tab buttons
  for (const btn of tabButtons) {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.settingsTab as SettingsTabId | undefined;
      if (tab) setActiveTab(tab);
    });
  }

  // Modal actions
  closeBtn?.addEventListener('click', () => close());
  resetBtn?.addEventListener('click', () => resetDefaults());
  modalEl?.addEventListener('click', (e: MouseEvent) => {
    if (e.target === modalEl) {
      close();
    }
  });

  // Controls bindings
  mouseSensInput?.addEventListener('input', () => {
    const val = Number(mouseSensInput.value);
    if (Number.isFinite(val)) applyPatch({ mouseSensitivity: val });
  });

  adsSensInput?.addEventListener('input', () => {
    const val = Number(adsSensInput.value);
    if (Number.isFinite(val)) applyPatch({ adsSensitivityMult: val });
  });

  invertYInput?.addEventListener('change', () => {
    applyPatch({ invertY: invertYInput.checked });
  });

  // Video & Minimap bindings
  fovInput?.addEventListener('input', () => {
    const val = Number(fovInput.value);
    if (Number.isFinite(val)) applyPatch({ fovDeg: val });
  });

  shadowsInput?.addEventListener('change', () => {
    applyPatch({ shadowsEnabled: shadowsInput.checked });
  });

  minimapRotateInput?.addEventListener('change', () => {
    applyPatch({ minimapRotate: minimapRotateInput.checked });
  });

  minimapSizeSelect?.addEventListener('change', () => {
    applyPatch({ minimapSize: minimapSizeSelect.value as GameSettings['minimapSize'] });
  });

  showFpsInput?.addEventListener('change', () => {
    applyPatch({ showFps: showFpsInput.checked });
  });

  // Audio bindings
  masterVolInput?.addEventListener('input', () => {
    const pct = Number(masterVolInput.value);
    if (Number.isFinite(pct)) applyPatch({ masterVolume: pct / 100 });
  });

  mutedInput?.addEventListener('change', () => {
    applyPatch({ muted: mutedInput.checked });
  });

  // Match bindings
  difficultySelect?.addEventListener('change', () => {
    applyPatch({ difficulty: difficultySelect.value as AiDifficulty });
  });

  defaultSideSelect?.addEventListener('change', () => {
    applyPatch({ defaultSide: defaultSideSelect.value as TacticalSide });
  });

  winTargetSelect?.addEventListener('change', () => {
    applyPatch({ winTarget: Number(winTargetSelect.value) === 6 ? 6 : 10 });
  });

  // Initial sync
  syncTabs();
  syncControls();

  return {
    getSettings(): GameSettings {
      return { ...settings };
    },
    isOpen(): boolean {
      return openState;
    },
    open,
    close,
    toggle,
    setActiveTab,
    applyPatch,
    resetDefaults,
    setOnChange(cb: (s: GameSettings) => void): void {
      onChangeCallback = cb;
    },
    setOnClose(cb: () => void): void {
      onCloseCallback = cb;
    },
  };
}
