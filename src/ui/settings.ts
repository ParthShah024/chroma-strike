import type { AbilityKeybinds, AiDifficulty, GameSettings, TacticalSide } from '../core/types';

export type SettingsTabId = 'controls' | 'crosshair' | 'video' | 'audio' | 'match';

export const SETTINGS_STORAGE_KEY = 'chroma_strike_settings_v1';
export const CALLSIGN_STORAGE_KEY = 'chroma_strike_callsign_v1';

const DEFAULT_KEYBINDS: AbilityKeybinds = {
  abilityQ: 'KeyQ',
  abilityE: 'KeyE',
  abilityX: 'KeyX',
};

function sanitizeCallsign(raw: unknown, fallback = 'AGENT-1'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.trim().replace(/[^\w\s\-().]/g, '').slice(0, 20);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function loadInitialCallsignFallback(): string {
  try {
    if (typeof localStorage === 'undefined') return 'AGENT-1';
    const raw = localStorage.getItem(CALLSIGN_STORAGE_KEY);
    return sanitizeCallsign(raw, 'AGENT-1');
  } catch {
    return 'AGENT-1';
  }
}

function saveCallsignStorage(name: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(CALLSIGN_STORAGE_KEY, sanitizeCallsign(name));
  } catch {
    // Ignore storage failures in private browsing.
  }
}

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
  playerName: loadInitialCallsignFallback(),
  adsMode: 'hold',
  keybinds: { ...DEFAULT_KEYBINDS },
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
  setOnSurrender(cb: () => void): void;
}

const VALID_TABS: readonly SettingsTabId[] = ['controls', 'crosshair', 'video', 'audio', 'match'];
const VALID_MINIMAP_SIZES: readonly GameSettings['minimapSize'][] = [
  'compact',
  'standard',
  'large',
];
const VALID_DIFFICULTIES: readonly AiDifficulty[] = ['casual', 'tactical', 'pro'];
const VALID_SIDES: readonly TacticalSide[] = ['attacker', 'defender'];
const VALID_ADS_MODES: readonly GameSettings['adsMode'][] = ['hold', 'toggle'];

const ALLOWED_EXTRA_CODES = new Set([
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'Tab',
  'CapsLock',
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Mouse3',
  'Mouse4',
  'Mouse5',
  'WheelUp',
  'WheelDown',
]);

function isValidKeybindCode(code: unknown): code is string {
  if (typeof code !== 'string') return false;
  if (/^Key[A-Z]$/.test(code)) return true;
  if (/^Digit[0-9]$/.test(code)) return true;
  if (/^Numpad[0-9]$/.test(code)) return true;
  if (/^F([1-9]|1[0-2])$/.test(code)) return true;
  return ALLOWED_EXTRA_CODES.has(code);
}

const BIND_LABEL_MAP: Record<string, string> = {
  Mouse3: 'MMB',
  Mouse4: 'M4',
  Mouse5: 'M5',
  WheelUp: 'MWU',
  WheelDown: 'MWD',
  Space: 'SPC',
  ShiftLeft: 'SHF',
  ShiftRight: 'RSHF',
  ControlLeft: 'CTL',
  ControlRight: 'RCTL',
  AltLeft: 'ALT',
  AltRight: 'RALT',
  Tab: 'TAB',
  CapsLock: 'CAPS',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  ArrowUp: 'UP',
  ArrowDown: 'DN',
  ArrowLeft: 'LFT',
  ArrowRight: 'RGT',
};

/**
 * Converts a KeyboardEvent.code or mouse button code (`Mouse3`..`Mouse5`)
 * into a compact HUD keycap label (e.g. `KeyQ` -> `Q`, `Mouse4` -> `M4`).
 */
export function formatBindLabel(code: string): string {
  if (!code) return '?';
  if (BIND_LABEL_MAP[code]) return BIND_LABEL_MAP[code];
  if (/^Key([A-Z])$/.test(code)) return code.slice(3);
  if (/^Digit([0-9])$/.test(code)) return code.slice(5);
  if (/^Numpad([0-9])$/.test(code)) return `N${code.slice(6)}`;
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4) || '?';
}

function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, num));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, num));
}

function sanitizeKeybinds(raw: unknown): AbilityKeybinds {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<AbilityKeybinds>;
  return {
    abilityQ: isValidKeybindCode(src.abilityQ) ? src.abilityQ : DEFAULT_KEYBINDS.abilityQ,
    abilityE: isValidKeybindCode(src.abilityE) ? src.abilityE : DEFAULT_KEYBINDS.abilityE,
    abilityX: isValidKeybindCode(src.abilityX) ? src.abilityX : DEFAULT_KEYBINDS.abilityX,
  };
}

function cloneSettings(s: GameSettings): GameSettings {
  return {
    ...s,
    keybinds: { ...s.keybinds },
  };
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
    playerName: sanitizeCallsign(src.playerName, DEFAULT_GAME_SETTINGS.playerName),
    adsMode: VALID_ADS_MODES.includes(src.adsMode as GameSettings['adsMode'])
      ? (src.adsMode as GameSettings['adsMode'])
      : DEFAULT_GAME_SETTINGS.adsMode,
    keybinds: sanitizeKeybinds(src.keybinds),
  };
}

function loadSettings(): GameSettings {
  try {
    if (typeof localStorage === 'undefined') return cloneSettings(DEFAULT_GAME_SETTINGS);
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return cloneSettings(DEFAULT_GAME_SETTINGS);
    return sanitizeSettings(JSON.parse(raw) as Partial<GameSettings>);
  } catch {
    return cloneSettings(DEFAULT_GAME_SETTINGS);
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

function mapMouseButtonToBindCode(button: number): string | null {
  if (button === 1) return 'Mouse3';
  if (button === 3) return 'Mouse4';
  if (button === 4) return 'Mouse5';
  return null;
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
  let onSurrenderCallback: (() => void) | null = null;

  let listeningSlot: keyof AbilityKeybinds | null = null;
  let listeningStartedAt = 0;
  let suppressAuxUntilMs = 0;

  let surrenderArmed = false;
  let surrenderTimer: ReturnType<typeof setTimeout> | null = null;

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
  const adsModeSelect = safeGetEl<HTMLSelectElement>('set-ads-mode');
  const bindAbilityQBtn = safeGetEl<HTMLButtonElement>('bind-ability-q');
  const bindAbilityEBtn = safeGetEl<HTMLButtonElement>('bind-ability-e');
  const bindAbilityXBtn = safeGetEl<HTMLButtonElement>('bind-ability-x');
  const bindResetBtn = safeGetEl<HTMLButtonElement>('bind-reset-btn');
  const quickBindButtons =
    typeof document !== 'undefined'
      ? Array.from(document.querySelectorAll<HTMLButtonElement>('[data-quick-bind][data-bind-code]'))
      : [];

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
  const playerNameInput = safeGetEl<HTMLInputElement>('set-player-name');
  const difficultySelect = safeGetEl<HTMLSelectElement>('set-difficulty');
  const defaultSideSelect = safeGetEl<HTMLSelectElement>('set-default-side');
  const winTargetSelect = safeGetEl<HTMLSelectElement>('set-win-target');
  const surrenderBtn = safeGetEl<HTMLButtonElement>('set-surrender-btn');
  const defaultSurrenderLabel = surrenderBtn?.textContent?.trim() || 'SURRENDER MATCH';

  const bindButtons: Record<keyof AbilityKeybinds, HTMLButtonElement | null> = {
    abilityQ: bindAbilityQBtn,
    abilityE: bindAbilityEBtn,
    abilityX: bindAbilityXBtn,
  };

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

  function syncBindButtons(): void {
    const slots: (keyof AbilityKeybinds)[] = ['abilityQ', 'abilityE', 'abilityX'];
    for (const slot of slots) {
      const btn = bindButtons[slot];
      if (!btn) continue;
      const isListening = listeningSlot === slot;
      btn.classList.toggle('listening', isListening);
      btn.textContent = isListening
        ? 'PRESS KEY / MOUSE...'
        : formatBindLabel(settings.keybinds[slot]);
    }
    for (const qbtn of quickBindButtons) {
      const slot = qbtn.dataset.quickBind as keyof AbilityKeybinds | undefined;
      const code = qbtn.dataset.bindCode;
      qbtn.classList.toggle('active', Boolean(slot && code && settings.keybinds[slot] === code));
    }
  }

  function syncControls(): void {
    if (mouseSensInput) mouseSensInput.value = settings.mouseSensitivity.toFixed(2);
    if (mouseSensVal) mouseSensVal.textContent = settings.mouseSensitivity.toFixed(2);

    if (adsSensInput) adsSensInput.value = settings.adsSensitivityMult.toFixed(2);
    if (adsSensVal) adsSensVal.textContent = `${settings.adsSensitivityMult.toFixed(2)}x`;

    if (invertYInput) invertYInput.checked = settings.invertY;
    if (adsModeSelect) adsModeSelect.value = settings.adsMode;
    syncBindButtons();

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

    if (playerNameInput && typeof document !== 'undefined' && document.activeElement !== playerNameInput) {
      playerNameInput.value = settings.playerName;
    }
    if (difficultySelect) difficultySelect.value = settings.difficulty;
    if (defaultSideSelect) defaultSideSelect.value = settings.defaultSide;
    if (winTargetSelect) winTargetSelect.value = String(settings.winTarget);
  }

  function applyPatch(patch: Partial<GameSettings>): void {
    const merged: Partial<GameSettings> = {
      ...settings,
      ...patch,
      keybinds: patch.keybinds
        ? { ...settings.keybinds, ...patch.keybinds }
        : { ...settings.keybinds },
    };
    settings = sanitizeSettings(merged);
    saveSettings(settings);
    if (patch.playerName !== undefined) {
      saveCallsignStorage(settings.playerName);
    }
    syncControls();
    onChangeCallback?.(cloneSettings(settings));
  }

  function commitKeybind(slot: keyof AbilityKeybinds, code: string): void {
    const nextBinds: AbilityKeybinds = { ...settings.keybinds };
    const prevCode = nextBinds[slot];
    if (prevCode !== code) {
      const slots: (keyof AbilityKeybinds)[] = ['abilityQ', 'abilityE', 'abilityX'];
      for (const other of slots) {
        if (other !== slot && nextBinds[other] === code) {
          nextBinds[other] = prevCode;
        }
      }
      nextBinds[slot] = code;
      applyPatch({ keybinds: nextBinds });
    }
  }

  function stopListening(): void {
    if (listeningSlot === null) return;
    listeningSlot = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onRebindKeyDown, true);
      window.removeEventListener('pointerdown', onRebindMouseEvent, true);
      window.removeEventListener('mousedown', onRebindMouseEvent, true);
      window.removeEventListener('pointerup', onRebindAuxUp, true);
      window.removeEventListener('mouseup', onRebindAuxUp, true);
      window.removeEventListener('auxclick', onRebindAuxUp, true);
      window.removeEventListener('wheel', onRebindWheel, { capture: true });
    }
    syncBindButtons();
  }

  function startListening(slot: keyof AbilityKeybinds): void {
    if (listeningSlot === slot) {
      stopListening();
      return;
    }
    stopListening();
    listeningSlot = slot;
    listeningStartedAt = performance.now();
    syncBindButtons();
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', onRebindKeyDown, true);
      window.addEventListener('pointerdown', onRebindMouseEvent, true);
      window.addEventListener('mousedown', onRebindMouseEvent, true);
      window.addEventListener('pointerup', onRebindAuxUp, true);
      window.addEventListener('mouseup', onRebindAuxUp, true);
      window.addEventListener('auxclick', onRebindAuxUp, true);
      window.addEventListener('wheel', onRebindWheel, { capture: true, passive: false });
    }
  }

  function onRebindKeyDown(e: KeyboardEvent): void {
    if (listeningSlot === null) return;
    e.preventDefault();
    e.stopPropagation();
    const rawCode =
      e.code === 'BrowserBack' ? 'Mouse4' : e.code === 'BrowserForward' ? 'Mouse5' : e.code;
    if (rawCode === 'Escape') {
      stopListening();
      return;
    }
    if (isValidKeybindCode(rawCode)) {
      suppressAuxUntilMs = performance.now() + 500;
      const targetSlot = listeningSlot;
      stopListening();
      commitKeybind(targetSlot, rawCode);
    }
  }

  function onRebindMouseEvent(e: MouseEvent): void {
    if (listeningSlot === null) return;
    const mouseCode = mapMouseButtonToBindCode(e.button);
    if (mouseCode) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      suppressAuxUntilMs = performance.now() + 550;
      const targetSlot = listeningSlot;
      stopListening();
      commitKeybind(targetSlot, mouseCode);
      return;
    }
    if (e.button === 0) {
      const target = e.target as Node | null;
      const activeBtn = listeningSlot ? bindButtons[listeningSlot] : null;
      if (
        (activeBtn && target && activeBtn.contains(target)) ||
        performance.now() - listeningStartedAt < 80
      ) {
        return;
      }
    }
    if (e.button === 2) {
      e.preventDefault();
    }
    stopListening();
  }

  function onRebindAuxUp(e: MouseEvent): void {
    if (e.button !== 1 && e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onRebindWheel(e: WheelEvent): void {
    if (listeningSlot === null) return;
    const code = e.deltaY < 0 ? 'WheelUp' : e.deltaY > 0 ? 'WheelDown' : null;
    if (!code) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    const targetSlot = listeningSlot;
    stopListening();
    commitKeybind(targetSlot, code);
  }

  function onAuxMouseGuard(e: MouseEvent): void {
    if (e.button !== 1 && e.button !== 3 && e.button !== 4) return;
    if (openState || listeningSlot !== null || performance.now() <= suppressAuxUntilMs) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', onAuxMouseGuard, true);
    window.addEventListener('pointerup', onAuxMouseGuard, true);
    window.addEventListener('mousedown', onAuxMouseGuard, true);
    window.addEventListener('mouseup', onAuxMouseGuard, true);
    window.addEventListener('auxclick', onAuxMouseGuard, true);
  }

  function resetSurrenderConfirm(): void {
    if (surrenderTimer !== null) {
      clearTimeout(surrenderTimer);
      surrenderTimer = null;
    }
    surrenderArmed = false;
    if (surrenderBtn) {
      surrenderBtn.textContent = defaultSurrenderLabel;
      surrenderBtn.classList.remove('confirming');
    }
  }

  function resetDefaults(): void {
    stopListening();
    resetSurrenderConfirm();
    settings = cloneSettings(DEFAULT_GAME_SETTINGS);
    saveSettings(settings);
    saveCallsignStorage(settings.playerName);
    syncControls();
    onChangeCallback?.(cloneSettings(settings));
  }

  function setActiveTab(tab: SettingsTabId): void {
    if (!VALID_TABS.includes(tab)) return;
    if (tab !== activeTab) {
      stopListening();
      resetSurrenderConfirm();
    }
    activeTab = tab;
    syncTabs();
  }

  function open(tab?: SettingsTabId): void {
    if (tab) {
      setActiveTab(tab);
    }
    const latestCallsign = loadInitialCallsignFallback();
    if (latestCallsign !== settings.playerName) {
      settings = sanitizeSettings({ ...settings, playerName: latestCallsign });
      saveSettings(settings);
    }
    openState = true;
    syncTabs();
    syncControls();
    if (playerNameInput) {
      playerNameInput.value = settings.playerName;
    }
    modalEl?.classList.remove('hidden');
  }

  function close(): void {
    if (!openState) return;
    stopListening();
    resetSurrenderConfirm();
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

  adsModeSelect?.addEventListener('change', () => {
    applyPatch({ adsMode: adsModeSelect.value === 'toggle' ? 'toggle' : 'hold' });
  });

  bindAbilityQBtn?.addEventListener('click', () => startListening('abilityQ'));
  bindAbilityEBtn?.addEventListener('click', () => startListening('abilityE'));
  bindAbilityXBtn?.addEventListener('click', () => startListening('abilityX'));
  for (const qbtn of quickBindButtons) {
    qbtn.addEventListener('click', () => {
      const slot = qbtn.dataset.quickBind as keyof AbilityKeybinds | undefined;
      const code = qbtn.dataset.bindCode;
      if (slot && code && isValidKeybindCode(code)) {
        stopListening();
        commitKeybind(slot, code);
      }
    });
  }
  bindResetBtn?.addEventListener('click', () => {
    stopListening();
    applyPatch({ keybinds: { ...DEFAULT_KEYBINDS } });
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
  function commitPlayerName(): void {
    if (!playerNameInput) return;
    const nextName = sanitizeCallsign(playerNameInput.value, 'AGENT-1');
    playerNameInput.value = nextName;
    saveCallsignStorage(nextName);
    if (nextName !== settings.playerName) {
      applyPatch({ playerName: nextName });
    }
  }

  playerNameInput?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code === 'Enter') {
      e.preventDefault();
      commitPlayerName();
      playerNameInput.blur();
    }
    e.stopPropagation();
  });
  playerNameInput?.addEventListener('change', commitPlayerName);
  playerNameInput?.addEventListener('blur', commitPlayerName);

  difficultySelect?.addEventListener('change', () => {
    applyPatch({ difficulty: difficultySelect.value as AiDifficulty });
  });

  defaultSideSelect?.addEventListener('change', () => {
    applyPatch({ defaultSide: defaultSideSelect.value as TacticalSide });
  });

  winTargetSelect?.addEventListener('change', () => {
    applyPatch({ winTarget: Number(winTargetSelect.value) === 6 ? 6 : 10 });
  });

  surrenderBtn?.addEventListener('click', () => {
    if (!surrenderArmed) {
      surrenderArmed = true;
      surrenderBtn.textContent = 'CONFIRM SURRENDER?';
      surrenderBtn.classList.add('confirming');
      surrenderTimer = setTimeout(() => {
        resetSurrenderConfirm();
      }, 3000);
      return;
    }
    resetSurrenderConfirm();
    close();
    onSurrenderCallback?.();
  });

  // Initial sync
  syncTabs();
  syncControls();

  return {
    getSettings(): GameSettings {
      return cloneSettings(settings);
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
    setOnSurrender(cb: () => void): void {
      onSurrenderCallback = cb;
    },
  };
}
