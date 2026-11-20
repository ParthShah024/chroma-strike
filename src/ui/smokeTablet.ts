import {
  AGENT_PALETTES,
  AgentColorId,
  Combatant,
  MatchHudState,
  PlayerState,
  SmokeSphere,
} from '../core/types';
import {
  CONTROLLER_SMOKE_RANGE_M,
  getControllerSmokeRadius,
} from '../abilities/system';
import { ARENA_WIDTH_M, ASCENT_CALLOUTS } from '../arena/map';
import {
  drawAscentBlueprintBase,
  drawAscentDynamicEntities,
  mapToWorldX,
  mapToWorldZ,
  worldToMapX,
  worldToMapY,
} from './minimap';

export interface SmokeTabletOptions {
  onPlaceSmoke: (worldX: number, worldZ: number) => void;
  onClose?: () => void;
}

export interface SmokeTabletController {
  isOpen(): boolean;
  open(colorId: AgentColorId, chargesLeft: number): void;
  close(notifyCallback?: boolean): void;
  render(
    hud: MatchHudState,
    combatants: readonly Combatant[],
    player: PlayerState,
    playerYaw: number,
    activeSmokes: readonly SmokeSphere[],
    chargesLeft: number
  ): void;
  dispose(): void;
}

const TABLET_W = 620;
const TABLET_H = 680;
const TABLET_DPR = 2;

function findNearestCallout(wx: number, wz: number): string {
  let bestName = '';
  let bestDist = Infinity;
  for (const c of ASCENT_CALLOUTS) {
    const d = Math.hypot(wx - c.x, wz - c.z);
    if (d < bestDist) {
      bestDist = d;
      bestName = c.name;
    }
  }
  return bestName;
}

/**
 * Brimstone-style Tactical Wristpad Tablet allowing any Controller agent
 * (`Mist`, `Umbra`) to place smokes cleanly on a large top-down map overview.
 */
export function createSmokeTabletController(
  options: SmokeTabletOptions
): SmokeTabletController {
  const modalEl = document.getElementById('smoke-tablet-modal') as HTMLDivElement | null;
  const titleEl = document.getElementById('smoke-tablet-title') as HTMLDivElement | null;
  const chargesEl = document.getElementById('smoke-tablet-charges') as HTMLSpanElement | null;
  const canvas = document.getElementById('smoke-tablet-canvas') as HTMLCanvasElement | null;
  const ctx = canvas?.getContext('2d') ?? null;
  const hintEl = document.getElementById('smoke-tablet-hint') as HTMLDivElement | null;
  const cancelBtn = document.getElementById('smoke-tablet-cancel') as HTMLButtonElement | null;

  if (canvas) {
    canvas.width = TABLET_W * TABLET_DPR;
    canvas.height = TABLET_H * TABLET_DPR;
  }

  const staticCanvas = document.createElement('canvas');
  staticCanvas.width = TABLET_W * TABLET_DPR;
  staticCanvas.height = TABLET_H * TABLET_DPR;
  const staticCtx = staticCanvas.getContext('2d');
  if (staticCtx) {
    staticCtx.setTransform(TABLET_DPR, 0, 0, TABLET_DPR, 0, 0);
    drawAscentBlueprintBase(staticCtx, {
      width: TABLET_W,
      height: TABLET_H,
      showCallouts: true,
      showSiteLabels: true,
      labelScale: (TABLET_W / 480) * 1.32,
    });
  }

  let openState = false;
  let activeColor: AgentColorId = 'blue';
  let activeCharges = 0;
  let cursorLogical: { x: number; y: number } | null = null;
  let lastPlayerPos: { x: number; z: number } = { x: 0, z: 0 };

  function syncHeader(chargesLeft: number): void {
    activeCharges = chargesLeft;
    const palette = AGENT_PALETTES[activeColor];
    const label = activeColor === 'violet' ? 'UMBRA — VOID SHROUD' : 'MIST — SMOKE DOME';
    if (titleEl) {
      titleEl.textContent = `TACTICAL TABLET • ${label}`;
      titleEl.style.color = palette.css;
    }
    if (chargesEl) {
      chargesEl.textContent = `${chargesLeft} / 2 CHARGES`;
    }
  }

  function clientToLogical(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * TABLET_W,
      y: ((clientY - rect.top) / rect.height) * TABLET_H,
    };
  }

  function open(colorId: AgentColorId, chargesLeft: number): void {
    activeColor = colorId;
    openState = true;
    cursorLogical = { x: TABLET_W * 0.5, y: TABLET_H * 0.42 };
    syncHeader(chargesLeft);
    modalEl?.classList.remove('hidden');
  }

  function close(notifyCallback = true): void {
    if (!openState) return;
    openState = false;
    cursorLogical = null;
    modalEl?.classList.add('hidden');
    if (notifyCallback) {
      options.onClose?.();
    }
  }

  function render(
    hud: MatchHudState,
    combatants: readonly Combatant[],
    player: PlayerState,
    playerYaw: number,
    activeSmokes: readonly SmokeSphere[],
    chargesLeft: number
  ): void {
    if (!openState || !canvas || !ctx) return;
    lastPlayerPos = { x: player.position.x, z: player.position.z };
    if (chargesLeft !== activeCharges) {
      syncHeader(chargesLeft);
    }

    const nowSec = performance.now() * 0.001;
    ctx.setTransform(TABLET_DPR, 0, 0, TABLET_DPR, 0, 0);
    ctx.clearRect(0, 0, TABLET_W, TABLET_H);
    ctx.drawImage(staticCanvas, 0, 0, TABLET_W, TABLET_H);

    drawAscentDynamicEntities(ctx, {
      width: TABLET_W,
      height: TABLET_H,
      hud,
      combatants,
      player,
      playerYaw,
      activeSmokes,
      nowSec,
      detailedDoors: true,
      drawSiteLabelsUpright: false,
      entityScale: 1.35,
    });

    // Player deployment range circle
    const px = worldToMapX(player.position.x, TABLET_W);
    const py = worldToMapY(player.position.z, TABLET_H);
    const pxPerMeter = TABLET_W / ARENA_WIDTH_M;
    const maxRangePx = CONTROLLER_SMOKE_RANGE_M * pxPerMeter;
    const smokeRadiusM = getControllerSmokeRadius(activeColor);
    const smokeRadiusPx = smokeRadiusM * pxPerMeter;
    const agentCss = AGENT_PALETTES[activeColor].css;

    ctx.save();
    ctx.fillStyle =
      activeColor === 'violet' ? 'rgba(168, 85, 247, 0.06)' : 'rgba(56, 189, 248, 0.05)';
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.44)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.arc(px, py, maxRangePx, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    if (cursorLogical) {
      const wx = mapToWorldX(cursorLogical.x, TABLET_W);
      const wz = mapToWorldZ(cursorLogical.y, TABLET_H);
      const dist = Math.hypot(wx - player.position.x, wz - player.position.z);
      const inRange = dist <= CONTROLLER_SMOKE_RANGE_M && chargesLeft > 0;
      const callout = findNearestCallout(wx, wz);

      ctx.fillStyle = inRange
        ? activeColor === 'violet'
          ? 'rgba(168, 85, 247, 0.30)'
          : 'rgba(0, 210, 255, 0.30)'
        : 'rgba(239, 68, 68, 0.24)';
      ctx.strokeStyle = inRange ? agentCss : '#ef4444';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(cursorLogical.x, cursorLogical.y, smokeRadiusPx, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Center crosshair dot
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cursorLogical.x, cursorLogical.y, 2.8, 0, Math.PI * 2);
      ctx.fill();

      // Crisp floating callout + distance tag right above preview circle
      const badgeLabel = inRange
        ? `${callout || 'TARGET'} • ${Math.round(dist)}m`
        : `OUT OF RANGE (${Math.round(dist)}m)`;
      ctx.font = '800 10.5px Inter, "Segoe UI", sans-serif';
      const tw = ctx.measureText(badgeLabel).width;
      const bw = tw + 14;
      const bh = 18;
      const bx = Math.max(8, Math.min(TABLET_W - bw - 8, cursorLogical.x - bw * 0.5));
      const by = Math.max(8, cursorLogical.y - smokeRadiusPx - bh - 6);
      ctx.fillStyle = 'rgba(9, 14, 23, 0.92)';
      ctx.strokeStyle = inRange ? agentCss : '#ef4444';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 5);
      ctx.fill();
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = inRange ? '#f8fafc' : '#fca5a5';
      ctx.fillText(badgeLabel, bx + bw * 0.5, by + bh * 0.5 + 0.5);

      if (hintEl) {
        hintEl.textContent = inRange
          ? `LEFT-CLICK PLACE SMOKE (${dist.toFixed(1)}m / ${CONTROLLER_SMOKE_RANGE_M}m) • RIGHT-CLICK / [Q] / [ESC] CANCEL`
          : `OUT OF RANGE (${dist.toFixed(1)}m > ${CONTROLLER_SMOKE_RANGE_M}m) • MOVE CURSOR INSIDE RING`;
        hintEl.classList.toggle('out-of-range', !inRange);
      }
    }
    ctx.restore();
  }

  const onCanvasMove = (e: MouseEvent) => {
    if (!openState) return;
    const pt = clientToLogical(e.clientX, e.clientY);
    if (pt) cursorLogical = pt;
  };

  const onCanvasMouseDown = (e: MouseEvent) => {
    if (!openState) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.button === 2) {
      close(true);
      return;
    }
    if (e.button !== 0 || activeCharges <= 0) return;
    const pt = clientToLogical(e.clientX, e.clientY) ?? cursorLogical;
    if (!pt) return;
    const wx = mapToWorldX(pt.x, TABLET_W);
    const wz = mapToWorldZ(pt.y, TABLET_H);
    const dist = Math.hypot(wx - lastPlayerPos.x, wz - lastPlayerPos.z);
    if (dist <= CONTROLLER_SMOKE_RANGE_M) {
      options.onPlaceSmoke(wx, wz);
    }
  };

  const onCanvasContextMenu = (e: MouseEvent) => {
    if (!openState) return;
    e.preventDefault();
    close(true);
  };

  const onCancelClick = (e: MouseEvent) => {
    e.stopPropagation();
    close(true);
  };

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === modalEl) {
      close(true);
    }
  };

  canvas?.addEventListener('mousemove', onCanvasMove);
  canvas?.addEventListener('mousedown', onCanvasMouseDown);
  canvas?.addEventListener('contextmenu', onCanvasContextMenu);
  cancelBtn?.addEventListener('click', onCancelClick);
  modalEl?.addEventListener('click', onBackdropClick);

  function dispose(): void {
    canvas?.removeEventListener('mousemove', onCanvasMove);
    canvas?.removeEventListener('mousedown', onCanvasMouseDown);
    canvas?.removeEventListener('contextmenu', onCanvasContextMenu);
    cancelBtn?.removeEventListener('click', onCancelClick);
    modalEl?.removeEventListener('click', onBackdropClick);
  }

  return {
    isOpen: () => openState,
    open,
    close,
    render,
    dispose,
  };
}
