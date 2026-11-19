import {
  AGENT_PALETTES,
  ArenaDoorHudState,
  Combatant,
  MatchHudState,
  PlayerState,
  SmokeSphere,
} from '../core/types';
import {
  ARENA_DEPTH_M,
  ARENA_WIDTH_M,
  ASCENT_CALLOUTS,
  ASCENT_MAP_DATA,
  getArenaDoors,
  getArenaMinimapData,
  getBombSites,
  getSpikeSpawnPos,
} from '../arena/map';

export type MinimapSizePreset = 'compact' | 'standard' | 'large';

export interface MinimapOptions {
  onOpenFullMap?: () => void;
}

export interface MinimapController {
  update(
    hud: MatchHudState,
    combatants: readonly Combatant[],
    player: PlayerState,
    playerYaw: number,
    ultRevealActive?: boolean,
    activeSmokes?: readonly SmokeSphere[]
  ): void;
  toggleRotateMode(): boolean;
  setRotateMode(rotate: boolean): void;
  isRotateMode(): boolean;
  setSizePreset(size: MinimapSizePreset): void;
  dispose(): void;
}

export interface BlueprintDrawConfig {
  width: number;
  height: number;
  showCallouts?: boolean;
  showSiteLabels?: boolean;
  labelScale?: number;
}

export interface DynamicDrawConfig {
  width: number;
  height: number;
  hud: MatchHudState;
  combatants: readonly Combatant[];
  player: PlayerState;
  playerYaw: number;
  ultRevealActive?: boolean;
  activeSmokes?: readonly SmokeSphere[];
  nowSec: number;
  detailedDoors?: boolean;
  undoRotationRad?: number;
  drawSiteLabelsUpright?: boolean;
  entityScale?: number;
}

const MINIMAP_W = 210;
const MINIMAP_H = 230;
const MINIMAP_DPR = 2;

const MINIMAP_SIZE_PRESETS: Record<MinimapSizePreset, { widthPx: number; heightPx: number }> = {
  compact: { widthPx: 175, heightPx: 192 },
  standard: { widthPx: 210, heightPx: 230 },
  large: { widthPx: 255, heightPx: 280 },
};

const RADAR_ZOOM = 1.32;
const ROTATE_STORAGE_KEY = 'chroma_strike_minimap_rotate_v1';

const HALF_W = ARENA_WIDTH_M * 0.5;
const HALF_D = ARENA_DEPTH_M * 0.5;

const WALKABLE_ORDER: Record<string, number> = {
  ground: 0,
  spawn_a: 1,
  spawn_d: 1,
  mid: 2,
  high: 3,
};

const WALL_ORDER: Record<string, number> = {
  roof: 0,
  cover: 1,
  wall: 2,
  window: 3,
};

export function worldToMapX(x: number, width: number): number {
  return ((x + HALF_W) / ARENA_WIDTH_M) * width;
}

export function worldToMapY(z: number, height: number): number {
  return ((z + HALF_D) / ARENA_DEPTH_M) * height;
}

export function mapToWorldX(mx: number, width: number): number {
  return (mx / width) * ARENA_WIDTH_M - HALF_W;
}

export function mapToWorldZ(my: number, height: number): number {
  return (my / height) * ARENA_DEPTH_M - HALF_D;
}

function drawWorldCallouts(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scale = 1
): void {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const c of ASCENT_CALLOUTS) {
    let cx = worldToMapX(c.x, width);
    let cy = worldToMapY(c.z, height);

    // Separate stacked two-story A Heaven (+3.0m) / A Hell (0.0m) callouts vertically in 2D
    if (c.name === 'A HEAVEN') {
      cy -= 6 * scale;
      cx += 3 * scale;
    } else if (c.name === 'A HELL') {
      cy += 7 * scale;
      cx -= 3 * scale;
    }

    const fontPx = Math.round((c.major ? 9.5 : 8) * scale);
    ctx.font = `${c.major ? 800 : 700} ${fontPx}px Inter, "Segoe UI", sans-serif`;

    ctx.lineWidth = 3 * scale;
    ctx.strokeStyle = 'rgba(7, 11, 18, 0.92)';
    ctx.strokeText(c.name, cx, cy);

    if (c.name === 'A HEAVEN') {
      ctx.fillStyle = '#fde047';
    } else if (c.name === 'A SITE') {
      ctx.fillStyle = '#ff9f5a';
    } else if (c.name === 'B SITE') {
      ctx.fillStyle = '#5cd1ff';
    } else {
      ctx.fillStyle = c.major ? '#e2e8f0' : 'rgba(203, 213, 225, 0.8)';
    }
    ctx.fillText(c.name, cx, cy);
  }
  ctx.restore();
}

export function drawBombSiteLabels(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  fontSizePx: number,
  undoRotationRad = 0
): void {
  const sites = getBombSites();
  const siteConfigs = [
    { site: sites.A, label: 'A', color: '#ff8a3d' },
    { site: sites.B, label: 'B', color: '#38bdf8' },
  ] as const;

  ctx.save();
  ctx.font = `900 ${fontSizePx}px Inter, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const cfg of siteConfigs) {
    const cx = worldToMapX(cfg.site.center.x, width);
    const cy = worldToMapY(cfg.site.center.z, height);
    ctx.save();
    ctx.translate(cx, cy);
    if (undoRotationRad !== 0) {
      ctx.rotate(undoRotationRad);
    }
    ctx.lineWidth = Math.max(2.5, fontSizePx * 0.24);
    ctx.strokeStyle = 'rgba(7, 11, 18, 0.92)';
    ctx.strokeText(cfg.label, 0, 0);
    ctx.fillStyle = cfg.color;
    ctx.fillText(cfg.label, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/**
 * Renders the crisp Valorant-style Ascent vector architectural blueprint purely
 * from `getArenaMinimapData()`, bomb sites, Spike pedestal, and callouts.
 */
export function drawAscentBlueprintBase(
  ctx: CanvasRenderingContext2D,
  cfg: BlueprintDrawConfig
): void {
  const { width, height } = cfg;
  const labelScale = cfg.labelScale ?? 1;
  const data = getArenaMinimapData();

  // 1. Deep tactical void + subtle 10m metric grid
  ctx.fillStyle = '#090e17';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.05)';
  ctx.lineWidth = 0.75;
  for (let wx = -40; wx <= 40; wx += 10) {
    const gx = worldToMapX(wx, width);
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, height);
    ctx.stroke();
  }
  for (let wz = -40; wz <= 40; wz += 10) {
    const gy = worldToMapY(wz, height);
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(width, gy);
    ctx.stroke();
  }

  // 2. Walkable floor rectangles sorted by elevation tier
  const sortedWalkables = [...data.walkableRects].sort(
    (a, b) => (WALKABLE_ORDER[a.level] ?? 0) - (WALKABLE_ORDER[b.level] ?? 0)
  );

  for (const r of sortedWalkables) {
    const x0 = worldToMapX(r.x0, width);
    const y0 = worldToMapY(r.z0, height);
    const w = worldToMapX(r.x1, width) - x0;
    const h = worldToMapY(r.z1, height) - y0;

    if (r.level === 'spawn_a') {
      ctx.fillStyle = '#142623';
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.28)';
      ctx.lineWidth = 0.9;
      ctx.strokeRect(x0, y0, w, h);
    } else if (r.level === 'spawn_d') {
      ctx.fillStyle = '#251720';
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.28)';
      ctx.lineWidth = 0.9;
      ctx.strokeRect(x0, y0, w, h);
    } else if (r.level === 'mid') {
      ctx.fillStyle = '#223146';
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
      ctx.lineWidth = 0.9;
      ctx.strokeRect(x0, y0, w, h);
    } else if (r.level === 'high') {
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1.5;
      ctx.fillStyle = '#2d3f5c';
      ctx.fillRect(x0, y0, w, h);
      ctx.restore();

      ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
      ctx.lineWidth = 1.1;
      ctx.strokeRect(x0, y0, w, h);
    } else {
      ctx.fillStyle = '#182232';
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
      ctx.lineWidth = 0.6;
      ctx.strokeRect(x0, y0, w, h);
    }
  }

  // 3. Bomb Site zones (translucent fill + crisp site perimeter)
  const sites = getBombSites();
  const siteConfigs = [
    { site: sites.A, fill: 'rgba(255, 138, 61, 0.17)', stroke: '#ff8a3d' },
    { site: sites.B, fill: 'rgba(56, 189, 248, 0.17)', stroke: '#38bdf8' },
  ] as const;

  for (const cfg of siteConfigs) {
    const sx0 = worldToMapX(cfg.site.minX, width);
    const sy0 = worldToMapY(cfg.site.minZ, height);
    const sw = worldToMapX(cfg.site.maxX, width) - sx0;
    const sh = worldToMapY(cfg.site.maxZ, height) - sy0;

    ctx.fillStyle = cfg.fill;
    ctx.fillRect(sx0, sy0, sw, sh);

    ctx.strokeStyle = cfg.stroke;
    ctx.lineWidth = 1.3;
    ctx.strokeRect(sx0 + 0.5, sy0 + 0.5, sw - 1, sh - 1);
  }

  // 4. Walls, cover, shoot-through windows, and sloped roofs
  const sortedWalls = [...data.wallRects].sort(
    (a, b) => (WALL_ORDER[a.kind] ?? 1) - (WALL_ORDER[b.kind] ?? 1)
  );

  for (const r of sortedWalls) {
    const x0 = worldToMapX(r.x0, width);
    const y0 = worldToMapY(r.z0, height);
    const w = Math.max(1.2, worldToMapX(r.x1, width) - x0);
    const h = Math.max(1.2, worldToMapY(r.z1, height) - y0);

    if (r.kind === 'roof') {
      ctx.save();
      ctx.fillStyle = 'rgba(71, 85, 105, 0.28)';
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.36)';
      ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(x0, y0, w, h);

      // Subtle architectural roof ridge hatch
      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
      const step = Math.max(4, Math.min(w, h) * 0.25);
      for (let d = -h; d < w; d += step) {
        ctx.moveTo(x0 + Math.max(0, d), y0 + Math.max(0, -d));
        ctx.lineTo(x0 + Math.min(w, d + h), y0 + Math.min(h, h - d));
      }
      ctx.clip();
      ctx.stroke();
      ctx.restore();
    } else if (r.kind === 'cover') {
      ctx.fillStyle = '#335968';
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = '#6ba3b8';
      ctx.lineWidth = 0.85;
      ctx.strokeRect(x0, y0, w, h);
    } else if (r.kind === 'window') {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(x0, y0, w, h);
      ctx.fillStyle = '#22d3ee';
      if (w >= h) {
        ctx.fillRect(x0 + 0.5, y0 + h * 0.3, Math.max(1, w - 1), Math.max(1.2, h * 0.4));
      } else {
        ctx.fillRect(x0 + w * 0.3, y0 + 0.5, Math.max(1.2, w * 0.4), Math.max(1, h - 1));
      }
    } else {
      // Crisp Valorant architectural wall + subtle drop shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
      ctx.fillRect(x0 + 1, y0 + 1, w, h);

      ctx.fillStyle = '#5c6a7e';
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.24)';
      ctx.lineWidth = 0.65;
      ctx.strokeRect(x0, y0, w, h);
    }
  }

  // 5. T-Spawn Spike Pedestal ('S')
  const ped = getSpikeSpawnPos();
  const px = worldToMapX(ped.x, width);
  const py = worldToMapY(ped.z, height);
  const pedR = Math.max(4, 4.8 * labelScale);

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = 'rgba(250, 204, 21, 0.26)';
  ctx.strokeStyle = '#facc15';
  ctx.lineWidth = 1.1;
  ctx.fillRect(-pedR, -pedR, pedR * 2, pedR * 2);
  ctx.strokeRect(-pedR, -pedR, pedR * 2, pedR * 2);
  ctx.restore();

  ctx.save();
  ctx.font = `900 ${Math.round(7.5 * labelScale)}px Inter, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fef08a';
  ctx.fillText('S', px, py + 0.4);
  ctx.restore();

  if (cfg.showSiteLabels !== false) {
    drawBombSiteLabels(ctx, width, height, Math.round(12 * labelScale));
  }

  if (cfg.showCallouts) {
    drawWorldCallouts(ctx, width, height, labelScale);
  }
}

function drawBlastDoors(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  doors: readonly ArenaDoorHudState[],
  detailed: boolean,
  undoRotationRad = 0
): void {
  for (const d of doors) {
    const x0 = worldToMapX(d.minX, width);
    const y0 = worldToMapY(d.minZ, height);
    const x1 = worldToMapX(d.maxX, width);
    const y1 = worldToMapY(d.maxZ, height);

    const rawW = x1 - x0;
    const rawH = y1 - y0;
    const cx = (x0 + x1) * 0.5;
    const cy = (y0 + y1) * 0.5;
    const drawW = Math.max(rawW, detailed ? 4.5 : 3.2);
    const drawH = Math.max(rawH, detailed ? 4.5 : 3.2);

    ctx.save();
    if (d.status === 'open') {
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = detailed ? 2.2 : 1.7;
      ctx.setLineDash([3, 2.5]);
      ctx.beginPath();
      if (rawH >= rawW) {
        ctx.moveTo(cx, y0);
        ctx.lineTo(cx, y1);
      } else {
        ctx.moveTo(x0, cy);
        ctx.lineTo(x1, cy);
      }
      ctx.stroke();
    } else if (d.status === 'closed') {
      ctx.fillStyle = '#f59e0b';
      ctx.strokeStyle = '#fef3c7';
      ctx.lineWidth = 0.85;
      ctx.shadowColor = 'rgba(245, 158, 11, 0.7)';
      ctx.shadowBlur = 4;
      ctx.fillRect(cx - drawW * 0.5, cy - drawH * 0.5, drawW, drawH);
      ctx.strokeRect(cx - drawW * 0.5, cy - drawH * 0.5, drawW, drawH);

      // Compact HP bar for closed armored Blast Door
      const hpFrac = Math.max(0, Math.min(1, d.hp / Math.max(1, d.maxHp)));
      const barW = detailed ? 24 : 16;
      const barH = detailed ? 3.5 : 2.6;
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.translate(cx, cy);
      if (undoRotationRad !== 0) ctx.rotate(undoRotationRad);
      const bx = -barW * 0.5;
      const by = (detailed ? -12 : -9);
      ctx.fillStyle = 'rgba(9, 14, 23, 0.88)';
      ctx.fillRect(bx - 0.5, by - 0.5, barW + 1, barH + 1);
      ctx.fillStyle = hpFrac > 0.45 ? '#f59e0b' : '#ef4444';
      ctx.fillRect(bx, by, barW * hpFrac, barH);
      if (detailed) {
        ctx.font = '800 8px Inter, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = '#fde68a';
        ctx.fillText(`${d.hp} HP`, 0, by - 1.5);
      }
      ctx.restore();
    } else {
      // Broken / shattered crimson doorway
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = detailed ? 2.0 : 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - 3.5, y0);
      ctx.lineTo(cx + 2.5, cy - 1);
      ctx.moveTo(cx - 2.5, cy + 1);
      ctx.lineTo(cx + 3.5, y1);
      ctx.moveTo(cx - 4, cy - 3);
      ctx.lineTo(cx + 4, cy + 3);
      ctx.moveTo(cx + 4, cy - 3);
      ctx.lineTo(cx - 4, cy + 3);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * Draws dynamic match elements (Buy Barriers, Blast Doors, Pulse Ult wave,
 * Spike, living allies, spotted enemies, and local player FOV/chevron).
 */
export function drawAscentDynamicEntities(
  ctx: CanvasRenderingContext2D,
  cfg: DynamicDrawConfig
): void {
  const {
    width,
    height,
    hud,
    combatants,
    player,
    playerYaw,
    ultRevealActive,
    activeSmokes,
    nowSec,
    detailedDoors = false,
    undoRotationRad = 0,
    entityScale = 1,
  } = cfg;

  // 1. Active Smoke Domes
  if (activeSmokes && activeSmokes.length > 0) {
    const pxPerMeter = width / ARENA_WIDTH_M;
    ctx.save();
    for (const s of activeSmokes) {
      const sx = worldToMapX(s.center.x, width);
      const sy = worldToMapY(s.center.z, height);
      const r = s.radius * pxPerMeter;
      ctx.fillStyle = 'rgba(148, 163, 184, 0.42)';
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.72)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // 2. Buy-Phase Barrier spans (all 12 forward attacker/defender lane & window spans)
  if (hud.phase === 'buy') {
    ctx.save();
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 3]);
    for (const span of ASCENT_MAP_DATA.buyBarrierSpans) {
      const axis = span.axis ?? 'z';
      ctx.strokeStyle =
        span.side === 'attacker' ? 'rgba(79, 157, 255, 0.92)' : 'rgba(255, 77, 94, 0.92)';
      ctx.shadowColor = span.side === 'attacker' ? '#4f9dff' : '#ff4d5e';
      ctx.shadowBlur = 5;
      ctx.beginPath();
      if (axis === 'x') {
        const mx = worldToMapX(span.x ?? 0, width);
        const y0 = worldToMapY(span.z0 ?? 0, height);
        const y1 = worldToMapY(span.z1 ?? 0, height);
        ctx.moveTo(mx, y0);
        ctx.lineTo(mx, y1);
      } else {
        const x0 = worldToMapX(span.x0 ?? 0, width);
        const x1 = worldToMapX(span.x1 ?? 0, width);
        const y = worldToMapY(span.z ?? 0, height);
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // 2. Interactive Blast Doors
  const doors = hud.doors && hud.doors.length > 0 ? hud.doors : getArenaDoors();
  drawBlastDoors(ctx, width, height, doors, detailedDoors, undoRotationRad);

  if (cfg.drawSiteLabelsUpright) {
    drawBombSiteLabels(ctx, width, height, Math.round(12 * entityScale), undoRotationRad);
  }

  // 3. Pulse [X] Orbital Recon sonar sweep ring
  if (ultRevealActive) {
    const rx = worldToMapX(player.position.x, width);
    const ry = worldToMapY(player.position.z, height);
    const maxR = Math.hypot(width, height) * 0.8;
    const waveA = (nowSec * 0.85) % 1;
    const waveB = (waveA + 0.5) % 1;
    ctx.save();
    for (const w of [waveA, waveB]) {
      const radius = 6 + w * maxR;
      const alpha = (1 - w) * 0.72;
      ctx.strokeStyle = `rgba(46, 204, 113, ${alpha.toFixed(3)})`;
      ctx.shadowColor = '#2ecc71';
      ctx.shadowBlur = 5;
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.arc(rx, ry, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 4. Spike icon (planted pulsing beacon or dropped diamond)
  const spike = hud.spike;
  if (spike) {
    const spX = worldToMapX(spike.position.x, width);
    const spY = worldToMapY(spike.position.z, height);

    if (spike.status === 'planted') {
      const pulse = (nowSec * 2.2) % 1;
      ctx.save();
      ctx.strokeStyle = `rgba(255, 59, 92, ${(1 - pulse) * 0.88})`;
      ctx.lineWidth = 1.8 * entityScale;
      ctx.beginPath();
      ctx.arc(spX, spY, (4 + pulse * 11) * entityScale, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = '#ff3b5c';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2 * entityScale;
      ctx.beginPath();
      ctx.arc(spX, spY, 4 * entityScale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    } else if (spike.status === 'dropped') {
      const dSize = 3.8 * entityScale;
      ctx.save();
      ctx.translate(spX, spY);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#f59e0b';
      ctx.strokeStyle = '#0d1117';
      ctx.lineWidth = 1.2;
      ctx.fillRect(-dSize, -dSize, dSize * 2, dSize * 2);
      ctx.strokeRect(-dSize, -dSize, dSize * 2, dSize * 2);
      ctx.restore();
    }
  }

  // 5. Living Allies
  for (const c of combatants) {
    if (c.team !== 'ally' || !c.alive || c.isPlayer) continue;
    const ax = worldToMapX(c.position.x, width);
    const ay = worldToMapY(c.position.z, height);

    if (spike?.status === 'carried' && spike.carrierId === c.id) {
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1.6 * entityScale;
      ctx.beginPath();
      ctx.arc(ax, ay, 6.2 * entityScale, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = AGENT_PALETTES[c.colorId].css;
    ctx.strokeStyle = '#0b1018';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(ax, ay, 4 * entityScale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // 6. LoS-Spotted Enemies
  for (const enemy of hud.minimapEnemies ?? []) {
    const ex = worldToMapX(enemy.x, width);
    const ey = worldToMapY(enemy.z, height);

    ctx.fillStyle = 'rgba(255, 59, 92, 0.28)';
    ctx.beginPath();
    ctx.arc(ex, ey, 6.5 * entityScale, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ff3b5c';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(ex, ey, 3.6 * entityScale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // 7. Local Player + Look FOV Wedge
  const playerCombatant = combatants.find((c) => c.isPlayer);
  const px = worldToMapX(player.position.x, width);
  const py = worldToMapY(player.position.z, height);
  const lookAngle = Math.atan2(-Math.cos(playerYaw), -Math.sin(playerYaw));
  const playerCss = AGENT_PALETTES[player.colorId].css;

  if (!playerCombatant || playerCombatant.alive) {
    const halfCone = 0.58;
    const wedgeRadius = 25 * entityScale;
    const grad = ctx.createRadialGradient(px, py, 2, px, py, wedgeRadius);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.34)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, wedgeRadius, lookAngle - halfCone, lookAngle + halfCone);
    ctx.closePath();
    ctx.fill();

    if (spike?.status === 'carried' && spike.playerHasSpike) {
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1.8 * entityScale;
      ctx.beginPath();
      ctx.arc(px, py, 7 * entityScale, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(lookAngle);
    ctx.scale(entityScale, entityScale);
    ctx.fillStyle = playerCss;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(6.5, 0);
    ctx.lineTo(-4.2, -4.4);
    ctx.lineTo(-2.2, 0);
    ctx.lineTo(-4.2, 4.4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  } else {
    const r = 3.2 * entityScale;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(px - r, py - r);
    ctx.lineTo(px + r, py + r);
    ctx.moveTo(px + r, py - r);
    ctx.lineTo(px - r, py + r);
    ctx.stroke();
  }
}

function loadRotatePreference(): boolean {
  try {
    const raw = localStorage.getItem(ROTATE_STORAGE_KEY);
    if (raw === 'fixed') return false;
    if (raw === 'radar') return true;
  } catch {
    // Ignore storage errors cleanly.
  }
  return true;
}

function saveRotatePreference(rotate: boolean): void {
  try {
    localStorage.setItem(ROTATE_STORAGE_KEY, rotate ? 'radar' : 'fixed');
  } catch {
    // Ignore storage errors cleanly.
  }
}

/**
 * Creates the 2x-DPR vector Radar Minimap (`#minimap-canvas`) with
 * rotating player-centered mode (`[N]` toggle) and click-to-open `[M]` Tactical Map.
 */
export function createMinimapController(options?: MinimapOptions): MinimapController {
  const wrapEl = document.getElementById('minimap-wrap') as HTMLDivElement | null;
  const modePillEl = document.getElementById('minimap-mode-pill') as HTMLButtonElement | null;
  const canvas = document.getElementById('minimap-canvas') as HTMLCanvasElement | null;
  const ctx = canvas?.getContext('2d') ?? null;

  if (canvas) {
    canvas.width = MINIMAP_W * MINIMAP_DPR;
    canvas.height = MINIMAP_H * MINIMAP_DPR;
  }

  // Static offscreen blueprint cache (zero per-frame architectural redraw)
  const miniStatic = document.createElement('canvas');
  miniStatic.width = MINIMAP_W * MINIMAP_DPR;
  miniStatic.height = MINIMAP_H * MINIMAP_DPR;
  const miniStaticCtx = miniStatic.getContext('2d');
  if (miniStaticCtx) {
    miniStaticCtx.setTransform(MINIMAP_DPR, 0, 0, MINIMAP_DPR, 0, 0);
    drawAscentBlueprintBase(miniStaticCtx, {
      width: MINIMAP_W,
      height: MINIMAP_H,
      showCallouts: false,
      showSiteLabels: false,
    });
  }

  let rotateMode = loadRotatePreference();
  let lastSnapshot: {
    hud: MatchHudState;
    combatants: readonly Combatant[];
    player: PlayerState;
    playerYaw: number;
    ultRevealActive?: boolean;
    activeSmokes?: readonly SmokeSphere[];
  } | null = null;

  function syncModePill(): void {
    if (!modePillEl) return;
    modePillEl.textContent = rotateMode ? '[N] RADAR' : '[N] FIXED';
    modePillEl.classList.toggle('fixed', !rotateMode);
  }

  function renderMini(
    hud: MatchHudState,
    combatants: readonly Combatant[],
    player: PlayerState,
    playerYaw: number,
    ultRevealActive?: boolean,
    activeSmokes?: readonly SmokeSphere[]
  ): void {
    if (!canvas || !ctx) return;
    const nowSec = performance.now() * 0.001;

    ctx.setTransform(MINIMAP_DPR, 0, 0, MINIMAP_DPR, 0, 0);
    ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);
    ctx.fillStyle = '#090e17';
    ctx.fillRect(0, 0, MINIMAP_W, MINIMAP_H);

    if (rotateMode) {
      const px = worldToMapX(player.position.x, MINIMAP_W);
      const py = worldToMapY(player.position.z, MINIMAP_H);
      const lookAngle = Math.atan2(-Math.cos(playerYaw), -Math.sin(playerYaw));
      const rot = -(lookAngle + Math.PI * 0.5);

      ctx.save();
      ctx.translate(MINIMAP_W * 0.5, MINIMAP_H * 0.54);
      ctx.rotate(rot);
      ctx.scale(RADAR_ZOOM, RADAR_ZOOM);
      ctx.translate(-px, -py);

      ctx.drawImage(miniStatic, 0, 0, MINIMAP_W, MINIMAP_H);
      drawAscentDynamicEntities(ctx, {
        width: MINIMAP_W,
        height: MINIMAP_H,
        hud,
        combatants,
        player,
        playerYaw,
        ultRevealActive,
        activeSmokes,
        nowSec,
        detailedDoors: false,
        undoRotationRad: -rot,
        drawSiteLabelsUpright: true,
        entityScale: 0.9,
      });
      ctx.restore();

      // Subtle North indicator pill in corner of rotating radar
      ctx.save();
      const nx = MINIMAP_W - 15;
      const ny = 15;
      ctx.translate(nx, ny);
      ctx.rotate(rot);
      ctx.fillStyle = 'rgba(13, 17, 23, 0.78)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ff6b81';
      ctx.beginPath();
      ctx.moveTo(0, -6.5);
      ctx.lineTo(3, -1);
      ctx.lineTo(-3, -1);
      ctx.closePath();
      ctx.fill();
      ctx.font = '900 7px Inter, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText('N', 0, 3.2);
      ctx.restore();
    } else {
      ctx.drawImage(miniStatic, 0, 0, MINIMAP_W, MINIMAP_H);
      drawAscentDynamicEntities(ctx, {
        width: MINIMAP_W,
        height: MINIMAP_H,
        hud,
        combatants,
        player,
        playerYaw,
        ultRevealActive,
        activeSmokes,
        nowSec,
        detailedDoors: false,
        drawSiteLabelsUpright: true,
        entityScale: 1,
      });
    }
  }

  function update(
    hud: MatchHudState,
    combatants: readonly Combatant[],
    player: PlayerState,
    playerYaw: number,
    ultRevealActive?: boolean,
    activeSmokes?: readonly SmokeSphere[]
  ): void {
    lastSnapshot = { hud, combatants, player, playerYaw, ultRevealActive, activeSmokes };
    renderMini(hud, combatants, player, playerYaw, ultRevealActive, activeSmokes);
  }

  function redrawLast(): void {
    if (!lastSnapshot) return;
    renderMini(
      lastSnapshot.hud,
      lastSnapshot.combatants,
      lastSnapshot.player,
      lastSnapshot.playerYaw,
      lastSnapshot.ultRevealActive,
      lastSnapshot.activeSmokes
    );
  }

  function setRotateMode(rotate: boolean): void {
    rotateMode = Boolean(rotate);
    saveRotatePreference(rotateMode);
    syncModePill();
    redrawLast();
  }

  function toggleRotateMode(): boolean {
    setRotateMode(!rotateMode);
    return rotateMode;
  }

  function setSizePreset(size: MinimapSizePreset): void {
    const preset = MINIMAP_SIZE_PRESETS[size] ?? MINIMAP_SIZE_PRESETS.standard;
    if (canvas) {
      canvas.style.width = `${preset.widthPx}px`;
      canvas.style.height = `${preset.heightPx}px`;
      // Preserve crisp 420x460 backing pixels regardless of CSS display preset.
      canvas.width = MINIMAP_W * MINIMAP_DPR;
      canvas.height = MINIMAP_H * MINIMAP_DPR;
    }
    wrapEl?.setAttribute('data-size', size);
  }

  const onPillClick = (e: MouseEvent) => {
    e.stopPropagation();
    toggleRotateMode();
  };

  const onWrapClick = (e: MouseEvent) => {
    e.stopPropagation();
    options?.onOpenFullMap?.();
  };

  modePillEl?.addEventListener('click', onPillClick);
  wrapEl?.addEventListener('click', onWrapClick);

  syncModePill();

  function dispose(): void {
    modePillEl?.removeEventListener('click', onPillClick);
    wrapEl?.removeEventListener('click', onWrapClick);
  }

  return {
    update,
    toggleRotateMode,
    setRotateMode,
    isRotateMode: () => rotateMode,
    setSizePreset,
    dispose,
  };
}
