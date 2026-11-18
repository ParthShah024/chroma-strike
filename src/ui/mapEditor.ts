import * as THREE from 'three';
import {
  DEFAULT_KILLHOUSE_GRID,
  GRID_COLS,
  GRID_ROWS,
  TileChar,
} from '../arena/skirmishAscii';
import { getCurrentGrid, rebuildArenaScene } from '../arena/map';

const STORAGE_KEY = 'chroma_strike_custom_map_sd_v2';

const VALID_TILES = new Set<string>([
  '#',
  'W',
  'O',
  '=',
  'D',
  'B',
  'P',
  '^',
  'v',
  '1',
  '2',
  'A',
  'E',
  '.',
]);

const TILE_CSS_CLASS: Record<TileChar, string> = {
  '#': 'tile-wall',
  W: 'tile-window',
  O: 'tile-arch',
  '=': 'tile-low',
  D: 'tile-dbox',
  B: 'tile-crate',
  P: 'tile-deck',
  '^': 'tile-stair',
  v: 'tile-stair',
  '1': 'tile-site-a',
  '2': 'tile-site-b',
  A: 'tile-ally',
  E: 'tile-enemy',
  '.': 'tile-floor',
};

const TILE_LABELS: Record<TileChar, string> = {
  '#': 'Tall Wall (3.6m)',
  W: 'Window (1.1-2.5m)',
  O: 'Archway',
  '=': 'Low Cover (1.26m)',
  D: 'Double Box (1.72m)',
  B: 'Tall Crate (2.25m)',
  P: 'Heaven Deck (0.90m)',
  '^': 'North Stairs (0.45m)',
  v: 'South Stairs (0.45m)',
  '1': 'Bomb Site A',
  '2': 'Bomb Site B',
  A: 'Attacker Spawn',
  E: 'Defender Spawn',
  '.': 'Open Floor',
};

export interface MapEditorController {
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): boolean;
  setOnClose(cb: () => void): void;
}

function isPerimeterCell(row: number, col: number): boolean {
  return row === 0 || row === GRID_ROWS - 1 || col === 0 || col === GRID_COLS - 1;
}

function normalizeGrid(rawGrid: readonly string[]): string[] {
  const rows: string[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    const srcRow = rawGrid[r] ?? '';
    let chars = '';
    for (let c = 0; c < GRID_COLS; c++) {
      if (isPerimeterCell(r, c)) {
        chars += '#';
      } else {
        const ch = srcRow[c] ?? '.';
        chars += VALID_TILES.has(ch) ? ch : '.';
      }
    }
    rows.push(chars);
  }
  return rows;
}

/**
 * Loads and validates any previously saved custom Killhouse map from `localStorage`.
 * Returns `null` if none is stored or if dimensions/characters fail validation.
 */
export function loadSavedCustomMapGrid(): string[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== GRID_ROWS) return null;
    for (const row of parsed) {
      if (typeof row !== 'string' || row.length !== GRID_COLS) return null;
      for (let i = 0; i < row.length; i++) {
        if (!VALID_TILES.has(row[i])) return null;
      }
    }
    return normalizeGrid(parsed as string[]);
  } catch {
    return null;
  }
}

function saveCustomMapGrid(grid: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(grid));
  } catch {
    // Ignore storage quota or private-browsing failures cleanly.
  }
}

function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard
      .writeText(text)
      .then(() => true)
      .catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Creates the interactive `[M]` Killhouse Map Maker modal controller.
 * Renders a 24x28 drag-paintable tile grid synced 1:1 with `skirmishAscii.ts`,
 * rebuilds the 3D Three.js arena & physics colliders live, and exports TypeScript code.
 */
export function createMapEditorController(
  scene: THREE.Scene,
  onApplied: () => void
): MapEditorController {
  let openState = false;
  let activeBrush: TileChar = '#';
  let paintMode: 'brush' | 'erase' | null = null;
  let onCloseCallback: (() => void) | null = null;
  let statusOverride: string | null = null;
  let copyResetTimer: number | null = null;

  let draftGrid: string[] = normalizeGrid(getCurrentGrid());

  const modalEl = document.getElementById('map-editor-modal') as HTMLDivElement | null;
  const gridEl = document.getElementById('map-editor-grid') as HTMLDivElement | null;
  const statusEl = document.getElementById('map-editor-status') as HTMLDivElement | null;
  const applyBtn = document.getElementById('map-apply-btn') as HTMLButtonElement | null;
  const resetBtn = document.getElementById('map-reset-btn') as HTMLButtonElement | null;
  const copyBtn = document.getElementById('map-copy-btn') as HTMLButtonElement | null;
  const closeBtn = document.getElementById('map-close-btn') as HTMLButtonElement | null;
  const brushButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-tile-brush]')
  );

  const cellEls: HTMLButtonElement[][] = [];

  function setTileAt(row: number, col: number, ch: TileChar): void {
    if (isPerimeterCell(row, col)) return;
    const prev = draftGrid[row];
    if (prev[col] === ch) return;
    draftGrid[row] = prev.slice(0, col) + ch + prev.slice(col + 1);
    statusOverride = null;
    updateCellElement(row, col);
    updateStatusText();
  }

  function updateCellElement(row: number, col: number): void {
    const cell = cellEls[row]?.[col];
    if (!cell) return;
    const ch = (draftGrid[row]?.[col] ?? '.') as TileChar;
    const locked = isPerimeterCell(row, col);

    cell.className = `map-cell ${TILE_CSS_CLASS[ch] ?? 'tile-floor'}${locked ? ' locked' : ''}`;
    cell.textContent = ch === '.' ? '' : ch;
    cell.title = locked
      ? `Locked Perimeter Wall (#) — (${col}, ${row})`
      : `${TILE_LABELS[ch] ?? 'Tile'} — (${col}, ${row})`;
  }

  function renderAllCells(): void {
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        updateCellElement(r, c);
      }
    }
    updateStatusText();
  }

  function updateStatusText(): void {
    if (!statusEl) return;
    if (statusOverride) {
      statusEl.textContent = statusOverride;
      return;
    }

    let allyCount = 0;
    let enemyCount = 0;
    let siteACount = 0;
    let siteBCount = 0;
    for (const row of draftGrid) {
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (ch === 'A') allyCount++;
        else if (ch === 'E') enemyCount++;
        else if (ch === '1') siteACount++;
        else if (ch === '2') siteBCount++;
      }
    }

    const spawnNote =
      allyCount === 0 || enemyCount === 0
        ? ' • Missing A/E spawns will use fallbacks'
        : '';
    statusEl.textContent = `Brush: ${TILE_LABELS[activeBrush]} • Spawns A:${allyCount}/E:${enemyCount} • Sites 1:${siteACount}/2:${siteBCount}${spawnNote}`;
  }

  function syncBrushButtons(): void {
    for (const btn of brushButtons) {
      btn.classList.toggle('active', btn.dataset.tileBrush === activeBrush);
    }
    updateStatusText();
  }

  // Build 14x17 grid cells once
  if (gridEl) {
    gridEl.replaceChildren();
    gridEl.addEventListener('contextmenu', (e: MouseEvent) => e.preventDefault());

    for (let r = 0; r < GRID_ROWS; r++) {
      const rowCells: HTMLButtonElement[] = [];
      for (let c = 0; c < GRID_COLS; c++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);

        cell.addEventListener('mousedown', (e: MouseEvent) => {
          e.preventDefault();
          if (isPerimeterCell(r, c)) return;
          if (e.button === 2) {
            paintMode = 'erase';
            setTileAt(r, c, '.');
          } else if (e.button === 0) {
            paintMode = 'brush';
            setTileAt(r, c, activeBrush);
          }
        });

        cell.addEventListener('mouseenter', () => {
          if (!paintMode || isPerimeterCell(r, c)) return;
          setTileAt(r, c, paintMode === 'erase' ? '.' : activeBrush);
        });

        gridEl.appendChild(cell);
        rowCells.push(cell);
      }
      cellEls.push(rowCells);
    }
  }

  window.addEventListener('mouseup', () => {
    paintMode = null;
  });

  for (const btn of brushButtons) {
    btn.addEventListener('click', () => {
      const brush = btn.dataset.tileBrush as TileChar | undefined;
      if (brush && VALID_TILES.has(brush)) {
        activeBrush = brush;
        syncBrushButtons();
      }
    });
  }

  applyBtn?.addEventListener('click', () => {
    const clean = normalizeGrid(draftGrid);
    draftGrid = clean;
    rebuildArenaScene(scene, clean);
    saveCustomMapGrid(clean);
    onApplied();
    statusOverride = 'Applied live to 3D Arena & saved locally!';
    renderAllCells();
  });

  resetBtn?.addEventListener('click', () => {
    draftGrid = normalizeGrid(DEFAULT_KILLHOUSE_GRID);
    statusOverride = 'Loaded Default Killhouse — click Apply Live to rebuild.';
    renderAllCells();
  });

  copyBtn?.addEventListener('click', () => {
    const clean = normalizeGrid(draftGrid);
    const code = [
      'export const DEFAULT_KILLHOUSE_GRID: string[] = [',
      ...clean.map((row) => `  '${row}',`),
      '];',
    ].join('\n');

    void copyTextToClipboard(code).then((ok) => {
      if (!copyBtn) return;
      if (copyResetTimer !== null) {
        window.clearTimeout(copyResetTimer);
      }
      const prevLabel = 'Copy TypeScript Code';
      copyBtn.textContent = ok ? 'Copied!' : 'Copy Failed';
      if (ok) {
        statusOverride = 'Copied DEFAULT_KILLHOUSE_GRID TypeScript array to clipboard!';
        updateStatusText();
      }
      copyResetTimer = window.setTimeout(() => {
        copyBtn.textContent = prevLabel;
        copyResetTimer = null;
      }, 1800);
    });
  });

  function open(): void {
    openState = true;
    draftGrid = normalizeGrid(getCurrentGrid());
    statusOverride = null;
    syncBrushButtons();
    renderAllCells();
    modalEl?.classList.remove('hidden');
  }

  function close(): void {
    if (!openState) return;
    openState = false;
    paintMode = null;
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

  syncBrushButtons();
  renderAllCells();

  return {
    isOpen(): boolean {
      return openState;
    },
    open,
    close,
    toggle,
    setOnClose(cb: () => void): void {
      onCloseCallback = cb;
    },
  };
}
