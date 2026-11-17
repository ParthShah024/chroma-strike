import type { CrosshairSettings } from '../core/types';

const STORAGE_KEY = 'chroma_strike_xhair_v1';

const COLOR_MAP: Record<Exclude<CrosshairSettings['colorMode'], 'agent'>, string> = {
  cyan: '#00e5ff',
  green: '#39ff14',
  white: '#ffffff',
  yellow: '#ffe600',
  pink: '#ff5ce6',
};

const DEFAULT_SETTINGS: CrosshairSettings = {
  colorMode: 'agent',
  centerDot: false,
  dotSizePx: 3,
  lineLengthPx: 7,
  lineThicknessPx: 2,
  baseGapPx: 4,
  outline: true,
  dynamicSpread: true,
};

const PRESETS: Record<'pro-dot' | 'classic' | 'dynamic', CrosshairSettings> = {
  'pro-dot': {
    colorMode: 'cyan',
    centerDot: true,
    dotSizePx: 4,
    lineLengthPx: 0,
    lineThicknessPx: 2,
    baseGapPx: 4,
    outline: true,
    dynamicSpread: false,
  },
  classic: {
    colorMode: 'agent',
    centerDot: false,
    dotSizePx: 2,
    lineLengthPx: 7,
    lineThicknessPx: 2,
    baseGapPx: 4,
    outline: true,
    dynamicSpread: true,
  },
  dynamic: {
    colorMode: 'green',
    centerDot: true,
    dotSizePx: 2,
    lineLengthPx: 10,
    lineThicknessPx: 2,
    baseGapPx: 6,
    outline: true,
    dynamicSpread: true,
  },
};

export interface CrosshairController {
  getSettings(): CrosshairSettings;
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): boolean;
  setOnClose(cb: () => void): void;
  applyFrame(spreadRad: number, agentCssColor: string, isScopedSniper: boolean): void;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, num));
}

function loadSettings(): CrosshairSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<CrosshairSettings>;
    const validModes: CrosshairSettings['colorMode'][] = [
      'agent',
      'cyan',
      'green',
      'white',
      'yellow',
      'pink',
    ];
    const colorMode = validModes.includes(parsed.colorMode as CrosshairSettings['colorMode'])
      ? (parsed.colorMode as CrosshairSettings['colorMode'])
      : DEFAULT_SETTINGS.colorMode;

    return {
      colorMode,
      centerDot: typeof parsed.centerDot === 'boolean' ? parsed.centerDot : DEFAULT_SETTINGS.centerDot,
      dotSizePx: clampInt(parsed.dotSizePx, 1, 10, DEFAULT_SETTINGS.dotSizePx),
      lineLengthPx: clampInt(parsed.lineLengthPx, 0, 20, DEFAULT_SETTINGS.lineLengthPx),
      lineThicknessPx: clampInt(parsed.lineThicknessPx, 1, 6, DEFAULT_SETTINGS.lineThicknessPx),
      baseGapPx: clampInt(parsed.baseGapPx, 0, 18, DEFAULT_SETTINGS.baseGapPx),
      outline: typeof parsed.outline === 'boolean' ? parsed.outline : DEFAULT_SETTINGS.outline,
      dynamicSpread:
        typeof parsed.dynamicSpread === 'boolean'
          ? parsed.dynamicSpread
          : DEFAULT_SETTINGS.dynamicSpread,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: CrosshairSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota or private-browsing failures cleanly.
  }
}

/**
 * Resolves the active CSS color for the crosshair.
 * In `'agent'` mode, the reticle automatically tracks the player's active
 * Agent palette (`#ff3b5c` Red, `#00d2ff` Blue, `#2ecc71` Green).
 */
function resolveColor(mode: CrosshairSettings['colorMode'], agentCssColor: string): string {
  if (mode === 'agent') return agentCssColor;
  return COLOR_MAP[mode];
}

/**
 * Applies CSS custom properties to a crosshair DOM root (`#crosshair` or `#xhair-preview-crosshair`).
 *
 * Why CSS Variable Reactive Crosshairs?
 * 1. Zero DOM structural churn: instead of mutating 5 child elements' `width`, `height`,
 *    `left`, `top`, `background`, and `boxShadow` inline styles every frame (20+ style writes),
 *    we push just 5 CSS custom properties (`--ch-color`, `--ch-len`, `--ch-thick`, `--ch-gap`,
 *    `--ch-dot-size`) on the parent container and let the browser's CSS cascade update all
 *    reticle primitives in one unified style recalc pass.
 * 2. Single source of truth: the live HUD reticle (`#crosshair`) and the customizer mini-preview
 *    (`#xhair-preview-crosshair`) share the exact same CSS rules and custom property contract.
 */
function applyVariablesToElement(
  el: HTMLElement | null,
  settings: CrosshairSettings,
  gapPx: number,
  colorCss: string
): void {
  if (!el) return;

  el.style.setProperty('--ch-color', colorCss);
  el.style.setProperty('--ch-len', `${settings.lineLengthPx}px`);
  el.style.setProperty('--ch-thick', `${settings.lineThicknessPx}px`);
  el.style.setProperty('--ch-gap', `${gapPx.toFixed(1)}px`);
  el.style.setProperty('--ch-dot-size', `${settings.dotSizePx}px`);
  el.style.setProperty(
    '--ch-outline',
    settings.outline ? '0 0 0 1px rgba(0, 0, 0, 0.9), 0 0 5px rgba(0, 0, 0, 0.85)' : 'none'
  );

  el.classList.toggle('show-dot', settings.centerDot);
  el.classList.toggle('show-lines', settings.lineLengthPx > 0);
}

/**
 * Creates the reactive crosshair controller and binds all interactive controls
 * inside `#crosshair-modal` (presets, color swatches, sliders, toggles, live preview).
 */
export function createCrosshairController(): CrosshairController {
  let settings: CrosshairSettings = loadSettings();
  let openState = false;
  let lastAgentColor = '#ff3b5c';
  let onCloseCallback: (() => void) | null = null;

  const crosshairEl = document.getElementById('crosshair') as HTMLDivElement | null;
  const modalEl = document.getElementById('crosshair-modal') as HTMLDivElement | null;
  const previewCrosshairEl = document.getElementById('xhair-preview-crosshair') as HTMLDivElement | null;
  const closeBtn = document.getElementById('xhair-close-btn') as HTMLButtonElement | null;

  const centerDotInput = document.getElementById('xhair-center-dot') as HTMLInputElement | null;
  const outlineInput = document.getElementById('xhair-outline') as HTMLInputElement | null;
  const dynamicSpreadInput = document.getElementById('xhair-dynamic-spread') as HTMLInputElement | null;

  const dotSizeInput = document.getElementById('xhair-dot-size') as HTMLInputElement | null;
  const dotSizeVal = document.getElementById('xhair-dot-size-val') as HTMLSpanElement | null;

  const lineLenInput = document.getElementById('xhair-line-len') as HTMLInputElement | null;
  const lineLenVal = document.getElementById('xhair-line-len-val') as HTMLSpanElement | null;

  const lineThickInput = document.getElementById('xhair-line-thick') as HTMLInputElement | null;
  const lineThickVal = document.getElementById('xhair-line-thick-val') as HTMLSpanElement | null;

  const baseGapInput = document.getElementById('xhair-base-gap') as HTMLInputElement | null;
  const baseGapVal = document.getElementById('xhair-base-gap-val') as HTMLSpanElement | null;

  const swatchButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-xhair-color]')
  );
  const presetButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-xhair-preset]')
  );

  function syncModalControls(): void {
    if (centerDotInput) centerDotInput.checked = settings.centerDot;
    if (outlineInput) outlineInput.checked = settings.outline;
    if (dynamicSpreadInput) dynamicSpreadInput.checked = settings.dynamicSpread;

    if (dotSizeInput) dotSizeInput.value = String(settings.dotSizePx);
    if (dotSizeVal) dotSizeVal.textContent = `${settings.dotSizePx}px`;

    if (lineLenInput) lineLenInput.value = String(settings.lineLengthPx);
    if (lineLenVal) lineLenVal.textContent = `${settings.lineLengthPx}px`;

    if (lineThickInput) lineThickInput.value = String(settings.lineThicknessPx);
    if (lineThickVal) lineThickVal.textContent = `${settings.lineThicknessPx}px`;

    if (baseGapInput) baseGapInput.value = String(settings.baseGapPx);
    if (baseGapVal) baseGapVal.textContent = `${settings.baseGapPx}px`;

    for (const btn of swatchButtons) {
      btn.classList.toggle('active', btn.dataset.xhairColor === settings.colorMode);
    }

    const previewColor = resolveColor(settings.colorMode, lastAgentColor);
    applyVariablesToElement(previewCrosshairEl, settings, settings.baseGapPx, previewColor);
  }

  function updateSettings(patch: Partial<CrosshairSettings>): void {
    settings = { ...settings, ...patch };
    saveSettings(settings);
    syncModalControls();
  }

  for (const btn of swatchButtons) {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.xhairColor as CrosshairSettings['colorMode'] | undefined;
      if (mode) updateSettings({ colorMode: mode });
    });
  }

  for (const btn of presetButtons) {
    btn.addEventListener('click', () => {
      const presetId = btn.dataset.xhairPreset as keyof typeof PRESETS | undefined;
      if (presetId && PRESETS[presetId]) {
        settings = { ...PRESETS[presetId] };
        saveSettings(settings);
        syncModalControls();
      }
    });
  }

  centerDotInput?.addEventListener('change', () => {
    updateSettings({ centerDot: centerDotInput.checked });
  });

  outlineInput?.addEventListener('change', () => {
    updateSettings({ outline: outlineInput.checked });
  });

  dynamicSpreadInput?.addEventListener('change', () => {
    updateSettings({ dynamicSpread: dynamicSpreadInput.checked });
  });

  dotSizeInput?.addEventListener('input', () => {
    updateSettings({ dotSizePx: clampInt(Number(dotSizeInput.value), 1, 10, settings.dotSizePx) });
  });

  lineLenInput?.addEventListener('input', () => {
    updateSettings({
      lineLengthPx: clampInt(Number(lineLenInput.value), 0, 20, settings.lineLengthPx),
    });
  });

  lineThickInput?.addEventListener('input', () => {
    updateSettings({
      lineThicknessPx: clampInt(Number(lineThickInput.value), 1, 6, settings.lineThicknessPx),
    });
  });

  baseGapInput?.addEventListener('input', () => {
    updateSettings({ baseGapPx: clampInt(Number(baseGapInput.value), 0, 18, settings.baseGapPx) });
  });

  function open(): void {
    openState = true;
    syncModalControls();
    modalEl?.classList.remove('hidden');
  }

  function close(): void {
    if (!openState) return;
    openState = false;
    modalEl?.classList.add('hidden');
    onCloseCallback?.();
  }

  function toggle(): boolean {
    if (openState) {
      close();
    } else {
      open();
    }
    return openState;
  }

  closeBtn?.addEventListener('click', () => {
    close();
  });

  // Initialize modal values and live preview immediately on load.
  syncModalControls();

  return {
    getSettings(): CrosshairSettings {
      return { ...settings };
    },
    isOpen(): boolean {
      return openState;
    },
    open,
    close,
    toggle,
    setOnClose(cb: () => void): void {
      onCloseCallback = cb;
    },
    applyFrame(spreadRad: number, agentCssColor: string, isScopedSniper: boolean): void {
      lastAgentColor = agentCssColor;

      if (crosshairEl) {
        // When the Rail Sniper optical scope overlay is active, hide the hipfire reticle
        // so `#scope-overlay` owns the center of the viewport cleanly.
        crosshairEl.style.display = isScopedSniper ? 'none' : 'block';
      }

      const colorCss = resolveColor(settings.colorMode, agentCssColor);
      const dynamicSpreadPx = settings.dynamicSpread ? spreadRad * 450 : 0;
      const gapPx = settings.baseGapPx + dynamicSpreadPx;

      applyVariablesToElement(crosshairEl, settings, gapPx, colorCss);

      if (openState) {
        applyVariablesToElement(previewCrosshairEl, settings, settings.baseGapPx, colorCss);
      }
    },
  };
}
