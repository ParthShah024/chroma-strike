import {
  AGENT_PALETTES,
  Combatant,
  MatchHudState,
  PlayerState,
} from '../core/types';
import {
  ARENA_DEPTH_M,
  ARENA_WIDTH_M,
  GRID_COLS,
  GRID_ROWS,
} from '../arena/skirmishAscii';
import { getArenaSpawns, getBombSites, getCurrentGrid } from '../arena/map';

export interface MinimapController {
  update(
    hud: MatchHudState,
    combatants: readonly Combatant[],
    player: PlayerState,
    playerYaw: number,
    ultRevealActive?: boolean
  ): void;
}

const MINIMAP_W = 180;
const MINIMAP_H = 200;
const HALF_W = ARENA_WIDTH_M * 0.5;
const HALF_D = ARENA_DEPTH_M * 0.5;

function worldToX(x: number): number {
  return ((x + HALF_W) / ARENA_WIDTH_M) * MINIMAP_W;
}

function worldToY(z: number): number {
  return ((z + HALF_D) / ARENA_DEPTH_M) * MINIMAP_H;
}

/**
 * Creates the cached 2D tactical minimap controller managing `<canvas id="minimap-canvas">`.
 * Rebuilds the static `36x40` architectural offscreen cache only when the active ASCII grid changes.
 */
export function createMinimapController(): MinimapController {
  const canvas = document.getElementById('minimap-canvas') as HTMLCanvasElement | null;
  const ctx = canvas?.getContext('2d') ?? null;

  const offscreen = document.createElement('canvas');
  offscreen.width = MINIMAP_W;
  offscreen.height = MINIMAP_H;
  const offCtx = offscreen.getContext('2d');

  let cachedGridSig = '';

  function rebuildStaticCache(grid: string[]): void {
    if (!offCtx) return;

    const cellW = MINIMAP_W / GRID_COLS;
    const cellH = MINIMAP_H / GRID_ROWS;

    // 1. Base tactical floor + subtle grid lines
    offCtx.fillStyle = '#0d131d';
    offCtx.fillRect(0, 0, MINIMAP_W, MINIMAP_H);

    offCtx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    offCtx.lineWidth = 1;
    for (let c = 1; c < GRID_COLS; c++) {
      const gx = Math.round(c * cellW) + 0.5;
      offCtx.beginPath();
      offCtx.moveTo(gx, 0);
      offCtx.lineTo(gx, MINIMAP_H);
      offCtx.stroke();
    }
    for (let r = 1; r < GRID_ROWS; r++) {
      const gy = Math.round(r * cellH) + 0.5;
      offCtx.beginPath();
      offCtx.moveTo(0, gy);
      offCtx.lineTo(MINIMAP_W, gy);
      offCtx.stroke();
    }

    // 2. Architectural tiles
    for (let r = 0; r < GRID_ROWS; r++) {
      const row = grid[r] ?? '';
      for (let c = 0; c < GRID_COLS; c++) {
        const ch = row[c] ?? '.';
        const x = c * cellW;
        const y = r * cellH;

        if (ch === '#') {
          offCtx.fillStyle = '#3b4657';
          offCtx.fillRect(x, y, cellW, cellH);
          offCtx.fillStyle = 'rgba(255, 255, 255, 0.08)';
          offCtx.fillRect(x, y, cellW, 1);
        } else if (ch === 'W') {
          offCtx.fillStyle = '#2d3748';
          offCtx.fillRect(x, y, cellW, cellH);
          // Determine whether window runs horizontally or vertically from neighbor walls
          const wallLR = row[c - 1] === '#' || row[c + 1] === '#';
          offCtx.fillStyle = '#22d3ee';
          if (wallLR) {
            offCtx.fillRect(x + 0.5, y + cellH * 0.35, cellW - 1, cellH * 0.3);
          } else {
            offCtx.fillRect(x + cellW * 0.35, y + 0.5, cellW * 0.3, cellH - 1);
          }
        } else if (ch === 'O') {
          offCtx.fillStyle = 'rgba(148, 163, 184, 0.14)';
          offCtx.fillRect(x, y, cellW, cellH);
          offCtx.strokeStyle = 'rgba(203, 213, 225, 0.65)';
          offCtx.lineWidth = 1;
          offCtx.strokeRect(x + 0.75, y + 0.75, cellW - 1.5, cellH - 1.5);
        } else if (ch === '=') {
          offCtx.fillStyle = '#8b7252';
          offCtx.fillRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
        } else if (ch === 'D') {
          offCtx.fillStyle = '#606d4d';
          offCtx.fillRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
          offCtx.strokeStyle = 'rgba(250, 204, 21, 0.35)';
          offCtx.lineWidth = 0.8;
          offCtx.strokeRect(x + 0.8, y + 0.8, cellW - 1.6, cellH - 1.6);
        } else if (ch === 'B') {
          offCtx.fillStyle = '#536071';
          offCtx.fillRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
        } else if (ch === 'P') {
          offCtx.fillStyle = 'rgba(59, 130, 246, 0.36)';
          offCtx.fillRect(x, y, cellW, cellH);
          offCtx.strokeStyle = 'rgba(96, 165, 250, 0.75)';
          offCtx.lineWidth = 0.9;
          offCtx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
        } else if (ch === '^' || ch === 'v') {
          offCtx.fillStyle = 'rgba(6, 182, 212, 0.34)';
          offCtx.fillRect(x, y, cellW, cellH);
          offCtx.fillStyle = 'rgba(103, 232, 249, 0.75)';
          offCtx.fillRect(x + 1, y + 1.5, cellW - 2, 1);
          offCtx.fillRect(x + 1, y + cellH - 2.5, cellW - 2, 1);
        } else if (ch === '1') {
          offCtx.fillStyle = 'rgba(255, 138, 61, 0.28)';
          offCtx.fillRect(x, y, cellW, cellH);
        } else if (ch === '2') {
          offCtx.fillStyle = 'rgba(56, 189, 248, 0.28)';
          offCtx.fillRect(x, y, cellW, cellH);
        } else if (ch === 'S') {
          offCtx.fillStyle = 'rgba(250, 204, 21, 0.24)';
          offCtx.fillRect(x, y, cellW, cellH);
          offCtx.strokeStyle = 'rgba(250, 204, 21, 0.75)';
          offCtx.lineWidth = 0.85;
          offCtx.strokeRect(x + 0.6, y + 0.6, cellW - 1.2, cellH - 1.2);
          offCtx.fillStyle = '#facc15';
          offCtx.fillRect(x + cellW * 0.3, y + cellH * 0.3, cellW * 0.4, cellH * 0.4);
        } else if (ch === 'A') {
          offCtx.fillStyle = 'rgba(16, 185, 129, 0.18)';
          offCtx.fillRect(x, y, cellW, cellH);
        } else if (ch === 'E') {
          offCtx.fillStyle = 'rgba(239, 68, 68, 0.16)';
          offCtx.fillRect(x, y, cellW, cellH);
        }
      }
    }

    // 3. Bomb Site zone outlines & crisp A / B labels
    const sites = getBombSites();
    const siteConfigs = [
      { site: sites.A, label: 'A', stroke: '#ff8a3d' },
      { site: sites.B, label: 'B', stroke: '#38bdf8' },
    ] as const;

    for (const cfg of siteConfigs) {
      const sx0 = worldToX(cfg.site.minX);
      const sy0 = worldToY(cfg.site.minZ);
      const sw = worldToX(cfg.site.maxX) - sx0;
      const sh = worldToY(cfg.site.maxZ) - sy0;

      offCtx.strokeStyle = cfg.stroke;
      offCtx.lineWidth = 1.25;
      offCtx.strokeRect(sx0 + 0.5, sy0 + 0.5, sw - 1, sh - 1);

      const cx = worldToX(cfg.site.center.x);
      const cy = worldToY(cfg.site.center.z);
      offCtx.font = '900 12px Inter, "Segoe UI", sans-serif';
      offCtx.textAlign = 'center';
      offCtx.textBaseline = 'middle';
      offCtx.lineWidth = 3;
      offCtx.strokeStyle = 'rgba(8, 12, 20, 0.9)';
      offCtx.strokeText(cfg.label, cx, cy);
      offCtx.fillStyle = cfg.stroke;
      offCtx.fillText(cfg.label, cx, cy);
    }
  }

  function update(
    hud: MatchHudState,
    combatants: readonly Combatant[],
    player: PlayerState,
    playerYaw: number,
    ultRevealActive?: boolean
  ): void {
    if (!canvas || !ctx) return;

    const grid = getCurrentGrid();
    const sig = grid.join('\n');
    if (sig !== cachedGridSig) {
      cachedGridSig = sig;
      rebuildStaticCache(grid);
    }

    ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);
    ctx.drawImage(offscreen, 0, 0);

    const nowSec = performance.now() * 0.001;
    const spike = hud.spike;

    // 0. Glowing cyan/teal Buy-Phase Barrier lines
    if (hud.phase === 'buy') {
      const spawns = getArenaSpawns();
      const barrierYs = [worldToY(spawns.buyMinAllyZ), worldToY(spawns.buyMaxDefenderZ)];
      ctx.save();
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.88)';
      ctx.shadowColor = '#22d3ee';
      ctx.shadowBlur = 6;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 3]);
      for (const by of barrierYs) {
        ctx.beginPath();
        ctx.moveTo(0, by);
        ctx.lineTo(MINIMAP_W, by);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 0b. Pulse [X] Orbital Recon emerald sonar sweep ring
    if (ultRevealActive) {
      const rx = worldToX(player.position.x);
      const ry = worldToY(player.position.z);
      const maxR = Math.hypot(MINIMAP_W, MINIMAP_H) * 0.85;
      const waveA = (nowSec * 0.85) % 1;
      const waveB = (waveA + 0.5) % 1;
      ctx.save();
      for (const w of [waveA, waveB]) {
        const radius = 6 + w * maxR;
        const alpha = (1 - w) * 0.75;
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

    // 1. Spike icon (planted pulsing crimson beacon or dropped amber diamond)
    if (spike) {
      const spX = worldToX(spike.position.x);
      const spY = worldToY(spike.position.z);

      if (spike.status === 'planted') {
        const pulse = (nowSec * 2.2) % 1;
        ctx.save();
        ctx.strokeStyle = `rgba(255, 59, 92, ${(1 - pulse) * 0.85})`;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(spX, spY, 4 + pulse * 10, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = '#ff3b5c';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(spX, spY, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      } else if (spike.status === 'dropped') {
        ctx.save();
        ctx.translate(spX, spY);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#f59e0b';
        ctx.strokeStyle = '#0d1117';
        ctx.lineWidth = 1.2;
        ctx.fillRect(-3.5, -3.5, 7, 7);
        ctx.strokeRect(-3.5, -3.5, 7, 7);
        ctx.restore();
      }
    }

    // 2. Living Allies
    for (const c of combatants) {
      if (c.team !== 'ally' || !c.alive || c.isPlayer) continue;
      const ax = worldToX(c.position.x);
      const ay = worldToY(c.position.z);

      if (spike?.status === 'carried' && spike.carrierId === c.id) {
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(ax, ay, 6.2, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = AGENT_PALETTES[c.colorId].css;
      ctx.strokeStyle = '#0b1018';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(ax, ay, 3.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // 3. LoS-Spotted Enemies
    for (const enemy of hud.minimapEnemies ?? []) {
      const ex = worldToX(enemy.x);
      const ey = worldToY(enemy.z);

      ctx.fillStyle = 'rgba(255, 59, 92, 0.28)';
      ctx.beginPath();
      ctx.arc(ex, ey, 6.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ff3b5c';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // 4. Local Player + Look FOV Wedge
    const playerCombatant = combatants.find((c) => c.isPlayer);
    const px = worldToX(player.position.x);
    const py = worldToY(player.position.z);
    const lookAngle = Math.atan2(-Math.cos(playerYaw), -Math.sin(playerYaw));
    const playerCss = AGENT_PALETTES[player.colorId].css;

    if (!playerCombatant || playerCombatant.alive) {
      // Translucent FOV wedge
      const halfCone = 0.58; // ~33 deg half-angle
      const wedgeRadius = 24;
      const grad = ctx.createRadialGradient(px, py, 2, px, py, wedgeRadius);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.32)');
      grad.addColorStop(1, 'rgba(255, 255, 255, 0)');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.arc(px, py, wedgeRadius, lookAngle - halfCone, lookAngle + halfCone);
      ctx.closePath();
      ctx.fill();

      // Gold Spike carrier ring around player if carrying
      if (spike?.status === 'carried' && spike.playerHasSpike) {
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Directional player arrow/chevron
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(lookAngle);
      ctx.fillStyle = playerCss;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(6.2, 0);
      ctx.lineTo(-4.2, -4.2);
      ctx.lineTo(-2.2, 0);
      ctx.lineTo(-4.2, 4.2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    } else {
      // Eliminated X marker
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(px - 3, py - 3);
      ctx.lineTo(px + 3, py + 3);
      ctx.moveTo(px + 3, py - 3);
      ctx.lineTo(px - 3, py + 3);
      ctx.stroke();
    }
  }

  return { update };
}
