import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AABB, BombSiteId, BombSiteZone, Vec3 } from '../core/types';
import {
  ARENA_DEPTH_M,
  ARENA_WIDTH_M,
  DEFAULT_KILLHOUSE_GRID,
  GRID_COLS,
  GRID_ROWS,
  TILE_SIZE_M,
  type TileChar,
  normalizeAsciiGrid,
} from './skirmishAscii';
import { TEXTURE_WORLD_SIZE_M, getArenaTexture, getBuyBarrierTexture, type ArenaTextureId } from './textures';

/**
 * ============================================================================
 * "Chroma Ascent" 2-Site Search & Destroy Arena Builder:
 * 2D Greedy Meshing, Single-Source-of-Truth Colliders, Windows & Archways,
 * Bomb Sites, Zone-Tagged Auto-Waypoint Graph, Procedural PBR Surfaces,
 * Real-Time Sun Shadows, Spike Pedestal & Buy-Phase Energy Barriers
 * ============================================================================
 *
 * 1. **Single Source of Truth (`ARENA_COLLIDERS`)**:
 *    Every solid piece of geometry in the 72m x 80m map is generated from the
 *    same `string[]` ASCII grid (`skirmishAscii.ts`) and pushed into the live
 *    `ARENA_COLLIDERS` array. Physics (`movement.ts`), hitscan bullets
 *    (`weapons.ts`), AI line-of-sight (`botBrain.ts`), and Three.js meshes all
 *    read from these exact AABBs â€” guaranteeing zero physics/visual desync.
 *
 *    IMPORTANT: `ARENA_COLLIDERS` is exported as a `const` array reference and
 *    is ALWAYS mutated in-place (`ARENA_COLLIDERS.length = 0; ARENA_COLLIDERS.push(...)`)
 *    on build/rebuild so every module holding an import binding sees updates
 *    immediately after `[M]` Map Maker live edits.
 *
 * 2. **How 2D Greedy Meshing Works**:
 *      Step A: Classify each `(r, c)` cell into a `MergeKind` (cells with
 *              identical height profile, tag, and architectural role) or `null`
 *              for open walkable floor (`.`, `O`, `1`, `2`, `A`, `E`).
 *      Step B: Scan left-to-right, top-to-bottom. At the first unvisited solid
 *              cell `(r, c)`, expand width `w` rightwards while contiguous
 *              unvisited cells share the same `MergeKind`.
 *      Step C: Expand height `h` downwards row-by-row while EVERY cell in the
 *              span `[c .. c + w - 1]` is unvisited and matches `MergeKind`.
 *      Step D: Mark the `w x h` rectangle visited and emit its collider(s):
 *                - solid kinds -> ONE AABB `0 .. height`
 *                - `window`    -> TWO AABBs: sill `0 .. 1.12m` + lintel
 *                                 `2.55 .. 3.60m` (the `1.12 .. 2.55m` band is
 *                                 OPEN for bullets, LoS, and thrown utility)
 *                - `archway`   -> ONE overhead header AABB `2.65 .. 3.60m`
 *                                 (the floor below stays walkable)
 *
 * 3. **Auto-Waypoint Extraction (`getArenaWaypoints`)**:
 *      - Every walkable tile (`.`, `O`, `1`, `2`, `A`, `E`, `^`, `v`, `P`)
 *        becomes a node at its world-space center `(x, surfaceY, z)` tagged
 *        with a tactical `zone` (`site_a`, `site_b`, `spawn`, `mid`, `flank`).
 *        `W` windows are NOT walkable.
 *      - **4-directional edges** connect adjacent walkable tiles iff the step
 *        height difference `|heightA - heightB| <= 0.50m`.
 *      - **Diagonal edges** are added ONLY when the target AND BOTH shared
 *        orthogonal corner tiles are walkable within the step limit,
 *        preventing bots from clipping their `0.4m` body radius into corners.
 *
 * 4. **Regional PBR Theming (`./textures`)**:
 *      Every block is skinned with cached procedural `map` + `bumpMap` canvas
 *      textures using world-anchored UVs (so a 2m crate and a 30m perimeter
 *      wall share the same texel density). Region is chosen by world X:
 *        - `x < -12`        West Wing / Site A : warm sandstone ashlar + terracotta trims
 *        - `-12 <= x <= 12` Mid Plaza          : slate concrete + dark steel channels
 *        - `x > 12`         East Wing / Site B : ribbed cobalt-steel + hazard-striped trims
 *      Long merged walls are split visually at the region seams (their single
 *      collider is untouched).
 *
 * 5. **Real Shadows**: the sun `DirectionalLight` casts a 2048^2 PCF shadow map
 *    over the whole compound; walls / crates / decks cast + receive. (The
 *    renderer must have `renderer.shadowMap.enabled = true`.)
 */

// ---------------------------------------------------------------------------
// Public Contracts & Live Arena State
// ---------------------------------------------------------------------------

/**
 * Live static AABBs used by player/bot movement, bullet raycasts, and LoS.
 * Mutated strictly in-place so existing module references remain valid across
 * `rebuildArenaScene` calls.
 */
export const ARENA_COLLIDERS: AABB[] = [];

/** Tactical region a navigation node belongs to (used by S&D bot routing). */
export type ArenaZone = 'site_a' | 'site_b' | 'mid' | 'flank' | 'spawn';

/** Walkable navigation node automatically extracted from the active ASCII grid. */
export interface ArenaWaypoint {
  id: string;
  pos: Vec3;
  neighbors: string[];
  zone?: ArenaZone;
}

/**
 * Team spawn positions plus buy-phase fences:
 * - Attackers / Allies (South `+Z`) must stay at `z >= buyMinAllyZ`.
 * - Defenders / Enemies (North `-Z`) must stay at `z <= buyMaxDefenderZ`.
 */
export interface ArenaSpawns {
  allies: [Vec3, Vec3, Vec3];
  enemies: [Vec3, Vec3, Vec3];
  buyMinAllyZ: number;
  buyMaxDefenderZ: number;
}

const HALF_WIDTH_M = ARENA_WIDTH_M * 0.5; // 36m -> x in [-36, +36]
const HALF_DEPTH_M = ARENA_DEPTH_M * 0.5; // 40m -> z in [-40, +40]
/**
 * South Attacker buy barrier: the row 28 / 29 seam, just North of the
 * A-Lobby / Top-Mid / B-Lobby doors. Every door across it dog-legs 90 degrees.
 */
const BUY_MIN_ALLY_Z = 18.0;
/**
 * North Defender setup barrier: the row 12 / 13 seam (Site A, Mid Nest and
 * Site B fronts), so Defenders may stage on-site before barriers drop.
 */
const BUY_MAX_DEFENDER_Z = -14.0;
const MAX_STEP_HEIGHT_M = 0.5;
/** Region seams for material theming (West/Site A | Mid Plaza | East/Site B). */
const REGION_WEST_MAX_X = -12;
const REGION_EAST_MIN_X = 12;
/** Spike pedestal top surface (the dropped Spike rests here). */
const SPIKE_PEDESTAL_TOP_Y = 0.05;

// Architectural heights (meters)
const PERIMETER_HEIGHT_M = 4.6;
const INTERIOR_WALL_HEIGHT_M = 3.6;
const LOW_COVER_HEIGHT_M = 1.26;
const DOUBLE_BOX_HEIGHT_M = 1.72;
const CRATE_HEIGHT_M = 2.25;
const PLATFORM_HEIGHT_M = 0.9;
const STAIR_HEIGHT_M = 0.45;
const WINDOW_SILL_TOP_M = 1.12;
const WINDOW_LINTEL_BOTTOM_M = 2.55;
const ARCH_HEADER_BOTTOM_M = 2.65;

// ---------------------------------------------------------------------------
// Architectural Material Palette (Neutral Daylight Compound)
// ---------------------------------------------------------------------------
// Kept deliberately warm/neutral so Red, Blue, Green, Violet and Gold agent
// silhouettes pop at a glance in every lane.

const COLOR_SKY_BG = 0xcfdbe8;
const COLOR_FLOOR = 0x767f8c;
const COLOR_FLOOR_GRID = 0x56606e;
const COLOR_PERIMETER_WALL = 0x475161;
const COLOR_PERIMETER_TRIM = 0x2c3440;
const COLOR_PLYWOOD_WALL = 0xa68966;
const COLOR_STEEL_FRAME = 0x38414f;
const COLOR_HEADGLITCH = 0x8c7355;
const COLOR_CAPRAIL = 0x3b4350;
const COLOR_CRATE = 0x525d6b;
const COLOR_CRATE_TRIM = 0x39424f;
const COLOR_DOUBLE_BOX = 0x5f6b4e; // olive-slate
const COLOR_DOUBLE_BOX_TRIM = 0x3b4430;
const COLOR_DOUBLE_BOX_BRACE = 0x8a7b4c;
const COLOR_WINDOW_WALL = 0x9a8262;
const COLOR_WINDOW_FRAME = 0x2f3742;
const COLOR_ARCH_STONE = 0x8f969f;
const COLOR_ARCH_PILASTER = 0x5b636e;
const COLOR_WATCHTOWER = 0x5c6675;
const COLOR_STAIR = 0x6e7887;
const COLOR_BOLLARD = 0xd99b26;
const COLOR_SITE_A = 0xff8a3d;
const COLOR_SITE_B = 0x38bdf8;
// Regional fallbacks (used verbatim when no DOM canvas -> textures are null)
const COLOR_SANDSTONE = 0xc9a77a;
const COLOR_TERRACOTTA = 0xb0603a;
const COLOR_SLATE_WALL = 0x7a8492;
const COLOR_COBALT_STEEL = 0x3f5f80;
const COLOR_HAZARD = 0xd9a21b;
const COLOR_RADIANITE = 0xff4d6d;
const COLOR_GENERATOR_GLOW = 0xff9a3d;
const COLOR_BARRIER_ATTACK = 0x4f9dff;
const COLOR_BARRIER_DEFEND = 0xff4d5e;

type MergeKind =
  | 'perimeter'
  | 'wall_interior'
  | 'window'
  | 'archway'
  | 'low_cover'
  | 'double_box'
  | 'crate'
  | 'platform'
  | 'stair';

interface TileColliderSpec {
  /** Vertical solid bands `[minY, maxY]` emitted as separate AABBs. */
  bands: ReadonlyArray<readonly [number, number]>;
  tag: 'wall' | 'cover';
  color: number;
}

const MERGE_SPECS: Record<MergeKind, TileColliderSpec> = {
  perimeter: { bands: [[0, PERIMETER_HEIGHT_M]], tag: 'wall', color: COLOR_PERIMETER_WALL },
  wall_interior: { bands: [[0, INTERIOR_WALL_HEIGHT_M]], tag: 'wall', color: COLOR_PLYWOOD_WALL },
  window: {
    bands: [
      [0, WINDOW_SILL_TOP_M],
      [WINDOW_LINTEL_BOTTOM_M, INTERIOR_WALL_HEIGHT_M],
    ],
    tag: 'wall',
    color: COLOR_WINDOW_WALL,
  },
  archway: {
    bands: [[ARCH_HEADER_BOTTOM_M, INTERIOR_WALL_HEIGHT_M]],
    tag: 'wall',
    color: COLOR_ARCH_STONE,
  },
  low_cover: { bands: [[0, LOW_COVER_HEIGHT_M]], tag: 'cover', color: COLOR_HEADGLITCH },
  double_box: { bands: [[0, DOUBLE_BOX_HEIGHT_M]], tag: 'cover', color: COLOR_DOUBLE_BOX },
  crate: { bands: [[0, CRATE_HEIGHT_M]], tag: 'cover', color: COLOR_CRATE },
  platform: { bands: [[0, PLATFORM_HEIGHT_M]], tag: 'cover', color: COLOR_WATCHTOWER },
  stair: { bands: [[0, STAIR_HEIGHT_M]], tag: 'cover', color: COLOR_STAIR },
};

interface MergedBlock {
  kind: MergeKind;
  /** Full footprint bounds (`minY = 0`, `maxY` = top of the tallest band). */
  box: AABB;
  /** Exact physics colliders emitted for this block (1 or 2 AABBs). */
  colliders: AABB[];
  row: number;
  col: number;
  rowsSpan: number;
  colsSpan: number;
}

// Module-level cached arena state updated atomically by `applyGridData`.
let currentGrid: string[] = [];
let cachedMergedBlocks: MergedBlock[] = [];
let cachedWaypoints: ArenaWaypoint[] = [];
let cachedSites: Record<BombSiteId, BombSiteZone> = createFallbackSites();
let cachedSpawns: ArenaSpawns = {
  allies: [
    { x: -5, y: 0.1, z: 33 },
    { x: 1, y: 0.1, z: 33 },
    { x: 7, y: 0.1, z: 33 },
  ],
  enemies: [
    { x: -7, y: 0.1, z: -35 },
    { x: 1, y: 0.1, z: -35 },
    { x: 7, y: 0.1, z: -35 },
  ],
  buyMinAllyZ: BUY_MIN_ALLY_Z,
  buyMaxDefenderZ: BUY_MAX_DEFENDER_Z,
};
const FALLBACK_SPIKE_POS: Vec3 = { x: 0, y: SPIKE_PEDESTAL_TOP_Y, z: 29 };
let cachedSpikePos: Vec3 = { ...FALLBACK_SPIKE_POS };

/** Site A landmark generator tower (extra collider on top of a `B` crate near Site A). */
interface GeneratorTowerSpec {
  x: number;
  z: number;
  baseY: number;
  topY: number;
  half: number;
}
let cachedGenerator: GeneratorTowerSpec | null = null;
const GENERATOR_TOWER_TOP_Y = 4.1;
const GENERATOR_TOWER_HALF = 0.5;

/** Single root group holding all arena Three.js meshes/lights for clean disposal. */
let arenaRoot: THREE.Group | null = null;
/** Lazily-built buy-phase energy curtains (child of `arenaRoot`). */
let barrierGroup: THREE.Group | null = null;
let barriersVisible = false;

// ---------------------------------------------------------------------------
// Coordinate & Tile Classification Helpers
// ---------------------------------------------------------------------------

function tileCenterX(col: number): number {
  return -HALF_WIDTH_M + (col + 0.5) * TILE_SIZE_M;
}

function tileCenterZ(row: number): number {
  return -HALF_DEPTH_M + (row + 0.5) * TILE_SIZE_M;
}

function worldToCol(x: number): number {
  return Math.floor((x + HALF_WIDTH_M) / TILE_SIZE_M);
}

function worldToRow(z: number): number {
  return Math.floor((z + HALF_DEPTH_M) / TILE_SIZE_M);
}

function isPerimeterCell(row: number, col: number): boolean {
  return row === 0 || row === GRID_ROWS - 1 || col === 0 || col === GRID_COLS - 1;
}

function tileAt(grid: readonly string[], row: number, col: number): TileChar | null {
  if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) return null;
  return (grid[row]?.[col] ?? '.') as TileChar;
}

function classifyTileForMesh(ch: TileChar, row: number, col: number): MergeKind | null {
  switch (ch) {
    case '#':
      return isPerimeterCell(row, col) ? 'perimeter' : 'wall_interior';
    case 'W':
      return 'window';
    case 'O':
      return 'archway';
    case '=':
      return 'low_cover';
    case 'D':
      return 'double_box';
    case 'B':
      return 'crate';
    case 'P':
      return 'platform';
    case '^':
    case 'v':
      return 'stair';
    case '1':
    case '2':
    case '.':
    case 'S':
    case 'A':
    case 'E':
      return null;
  }
}

function getWalkableSurfaceHeight(ch: TileChar | null): number | null {
  switch (ch) {
    case '.':
    case 'O':
    case '1':
    case '2':
    case 'S':
    case 'A':
    case 'E':
      return 0;
    case '^':
    case 'v':
      return STAIR_HEIGHT_M;
    case 'P':
      return PLATFORM_HEIGHT_M;
    default:
      return null;
  }
}

/** Full-height solid tiles that can host window jambs / archway pilasters. */
function isTallSolid(ch: TileChar | null): boolean {
  return ch === '#' || ch === 'W';
}

function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function cloneSite(site: BombSiteZone): BombSiteZone {
  return {
    site: site.site,
    minX: site.minX,
    maxX: site.maxX,
    minZ: site.minZ,
    maxZ: site.maxZ,
    center: cloneVec3(site.center),
  };
}

// ---------------------------------------------------------------------------
// 2D Greedy Meshing Implementation
// ---------------------------------------------------------------------------

function greedyMeshGrid(grid: readonly string[]): MergedBlock[] {
  const kindGrid: Array<Array<MergeKind | null>> = [];
  const visited: boolean[][] = [];

  for (let r = 0; r < GRID_ROWS; r++) {
    const kindRow: Array<MergeKind | null> = [];
    const visitedRow: boolean[] = [];
    for (let c = 0; c < GRID_COLS; c++) {
      const ch = grid[r][c] as TileChar;
      kindRow.push(classifyTileForMesh(ch, r, c));
      visitedRow.push(false);
    }
    kindGrid.push(kindRow);
    visited.push(visitedRow);
  }

  const blocks: MergedBlock[] = [];

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const targetKind = kindGrid[r][c];
      if (visited[r][c] || targetKind === null) continue;

      // 1. Expand rectangle width (columns) greedily to the right.
      let colsSpan = 1;
      while (
        c + colsSpan < GRID_COLS &&
        !visited[r][c + colsSpan] &&
        kindGrid[r][c + colsSpan] === targetKind
      ) {
        colsSpan++;
      }

      // 2. Expand rectangle height (rows) downwards while full width matches.
      let rowsSpan = 1;
      while (r + rowsSpan < GRID_ROWS) {
        let rowMatches = true;
        for (let dc = 0; dc < colsSpan; dc++) {
          if (visited[r + rowsSpan][c + dc] || kindGrid[r + rowsSpan][c + dc] !== targetKind) {
            rowMatches = false;
            break;
          }
        }
        if (!rowMatches) break;
        rowsSpan++;
      }

      // 3. Mark covered cells visited so no tile is emitted twice.
      for (let dr = 0; dr < rowsSpan; dr++) {
        for (let dc = 0; dc < colsSpan; dc++) {
          visited[r + dr][c + dc] = true;
        }
      }

      // 4. Emit the collider band(s) for the entire w x h block.
      const spec = MERGE_SPECS[targetKind];
      const minX = -HALF_WIDTH_M + c * TILE_SIZE_M;
      const maxX = -HALF_WIDTH_M + (c + colsSpan) * TILE_SIZE_M;
      const minZ = -HALF_DEPTH_M + r * TILE_SIZE_M;
      const maxZ = -HALF_DEPTH_M + (r + rowsSpan) * TILE_SIZE_M;

      const colliders: AABB[] = spec.bands.map(([y0, y1]) => ({
        min: { x: minX, y: y0, z: minZ },
        max: { x: maxX, y: y1, z: maxZ },
        tag: spec.tag,
        color: spec.color,
      }));
      const topY = spec.bands[spec.bands.length - 1][1];

      blocks.push({
        kind: targetKind,
        row: r,
        col: c,
        rowsSpan,
        colsSpan,
        colliders,
        box: {
          min: { x: minX, y: 0, z: minZ },
          max: { x: maxX, y: topY, z: maxZ },
          tag: spec.tag,
          color: spec.color,
        },
      });
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Bomb Site Extraction
// ---------------------------------------------------------------------------

function makeSiteZone(site: BombSiteId, minX: number, maxX: number, minZ: number, maxZ: number): BombSiteZone {
  return {
    site,
    minX,
    maxX,
    minZ,
    maxZ,
    center: { x: (minX + maxX) * 0.5, y: 0, z: (minZ + maxZ) * 0.5 },
  };
}

/** Safe default plant rectangles (match the default layout) for grids lacking `1` / `2` tiles. */
function createFallbackSites(): Record<BombSiteId, BombSiteZone> {
  return {
    A: makeSiteZone('A', -26, -18, -24, -16),
    B: makeSiteZone('B', 22, 30, -24, -16),
  };
}

function extractBombSites(grid: readonly string[]): Record<BombSiteId, BombSiteZone> {
  const fallback = createFallbackSites();
  const bounds: Record<BombSiteId, { r0: number; r1: number; c0: number; c1: number } | null> = {
    A: null,
    B: null,
  };

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const ch = grid[r][c];
      const id: BombSiteId | null = ch === '1' ? 'A' : ch === '2' ? 'B' : null;
      if (id === null) continue;
      const b = bounds[id];
      if (b === null) {
        bounds[id] = { r0: r, r1: r, c0: c, c1: c };
      } else {
        b.r0 = Math.min(b.r0, r);
        b.r1 = Math.max(b.r1, r);
        b.c0 = Math.min(b.c0, c);
        b.c1 = Math.max(b.c1, c);
      }
    }
  }

  const toZone = (id: BombSiteId): BombSiteZone => {
    const b = bounds[id];
    if (b === null) return fallback[id];
    return makeSiteZone(
      id,
      -HALF_WIDTH_M + b.c0 * TILE_SIZE_M,
      -HALF_WIDTH_M + (b.c1 + 1) * TILE_SIZE_M,
      -HALF_DEPTH_M + b.r0 * TILE_SIZE_M,
      -HALF_DEPTH_M + (b.r1 + 1) * TILE_SIZE_M
    );
  };

  return { A: toZone('A'), B: toZone('B') };
}

// ---------------------------------------------------------------------------
// Auto-Waypoint Graph Extraction (Zone-Tagged)
// ---------------------------------------------------------------------------

/** Central third of columns forms the Mid lane (`c = 12..23` on a 36-wide grid). */
const MID_COL_MIN = Math.floor(GRID_COLS / 3);
const MID_COL_MAX = GRID_COLS - Math.floor(GRID_COLS / 3) - 1;
/** Spawn bands: rows `1..4` (North CT sanctuary) and `34..38` (South T courtyard). */
const SPAWN_ROW_NORTH_MAX = 4;
const SPAWN_ROW_SOUTH_MIN = GRID_ROWS - 6;

function classifyWaypointZone(
  ch: TileChar,
  row: number,
  col: number,
  x: number,
  z: number,
  sites: Record<BombSiteId, BombSiteZone>
): ArenaZone {
  if (ch === '1') return 'site_a';
  if (ch === '2') return 'site_b';
  if (ch === 'A' || ch === 'E' || ch === 'S') return 'spawn';

  // Tiles hugging a plant cluster (1 tile margin) read as part of that site.
  const margin = TILE_SIZE_M;
  for (const id of ['A', 'B'] as const) {
    const s = sites[id];
    if (x >= s.minX - margin && x <= s.maxX + margin && z >= s.minZ - margin && z <= s.maxZ + margin) {
      return id === 'A' ? 'site_a' : 'site_b';
    }
  }

  const inMidCols = col >= MID_COL_MIN && col <= MID_COL_MAX;
  if (inMidCols && (row <= SPAWN_ROW_NORTH_MAX || row >= SPAWN_ROW_SOUTH_MIN)) return 'spawn';
  if (row >= SPAWN_ROW_SOUTH_MIN) return 'spawn';
  return inMidCols ? 'mid' : 'flank';
}

function extractWaypoints(
  grid: readonly string[],
  sites: Record<BombSiteId, BombSiteZone>
): ArenaWaypoint[] {
  const heights: Array<Array<number | null>> = [];
  const ids: Array<Array<string | null>> = [];

  for (let r = 0; r < GRID_ROWS; r++) {
    const hRow: Array<number | null> = [];
    const idRow: Array<string | null> = [];
    for (let c = 0; c < GRID_COLS; c++) {
      const h = getWalkableSurfaceHeight(grid[r][c] as TileChar);
      hRow.push(h);
      idRow.push(h !== null ? `wp_${r}_${c}` : null);
    }
    heights.push(hRow);
    ids.push(idRow);
  }

  const waypoints: ArenaWaypoint[] = [];
  const orthoDirs: ReadonlyArray<[number, number]> = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  const diagDirs: ReadonlyArray<[number, number]> = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ];

  const canStep = (h1: number | null, h2: number | null): boolean => {
    if (h1 === null || h2 === null) return false;
    return Math.abs(h1 - h2) <= MAX_STEP_HEIGHT_M + 1e-6;
  };

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const hSelf = heights[r][c];
      const idSelf = ids[r][c];
      if (hSelf === null || idSelf === null) continue;

      const neighbors: string[] = [];

      // Orthogonal 4-neighbor links
      for (const [dr, dc] of orthoDirs) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
        const hNeighbor = heights[nr][nc];
        const idNeighbor = ids[nr][nc];
        if (idNeighbor !== null && canStep(hSelf, hNeighbor)) {
          neighbors.push(idNeighbor);
        }
      }

      // Diagonal links: require both orthogonal corner tiles to be walkable and
      // reachable so bots never clip their 0.4m radius into wall/cover corners.
      for (const [dr, dc] of diagDirs) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
        const hNeighbor = heights[nr][nc];
        const idNeighbor = ids[nr][nc];
        if (idNeighbor === null || !canStep(hSelf, hNeighbor)) continue;

        const hOrthoRow = heights[r + dr][c];
        const hOrthoCol = heights[r][c + dc];
        if (
          canStep(hSelf, hOrthoRow) &&
          canStep(hSelf, hOrthoCol) &&
          canStep(hNeighbor, hOrthoRow) &&
          canStep(hNeighbor, hOrthoCol)
        ) {
          neighbors.push(idNeighbor);
        }
      }

      const x = tileCenterX(c);
      const z = tileCenterZ(r);
      waypoints.push({
        id: idSelf,
        pos: { x, y: hSelf, z },
        neighbors,
        zone: classifyWaypointZone(grid[r][c] as TileChar, r, c, x, z, sites),
      });
    }
  }

  return waypoints;
}

// ---------------------------------------------------------------------------
// Team Spawn Extraction (With Safe Open-Tile Fallbacks)
// ---------------------------------------------------------------------------

function findClosestWalkableSpawn(
  grid: readonly string[],
  preferredX: number,
  preferredZ: number,
  searchRowOrder: readonly number[],
  usedKeys: Set<string>
): Vec3 {
  let bestPos: Vec3 | null = null;
  let bestKey = '';
  let bestDistSq = Infinity;

  for (const r of searchRowOrder) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      const key = `${r},${c}`;
      if (usedKeys.has(key)) continue;

      // Only flat floor (no decks/stairs) so spawns never sit on elevated cover.
      const surfaceY = getWalkableSurfaceHeight(grid[r][c] as TileChar);
      if (surfaceY === null || surfaceY > 0) continue;

      const wx = tileCenterX(c);
      const wz = tileCenterZ(r);
      const distSq = (wx - preferredX) ** 2 + (wz - preferredZ) ** 2;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestKey = key;
        bestPos = { x: wx, y: surfaceY + 0.1, z: wz };
      }
    }
    if (bestPos !== null) {
      // Mark the tile chosen so 2 bots never stack on the exact same fallback tile.
      usedKeys.add(bestKey);
      return bestPos;
    }
  }

  return { x: preferredX, y: 0.1, z: preferredZ };
}

function isWorldCoordWalkable(grid: readonly string[], x: number, z: number): number | null {
  return getWalkableSurfaceHeight(tileAt(grid, worldToRow(z), worldToCol(x)));
}

function extractSpawns(grid: readonly string[]): ArenaSpawns {
  const allyTiles: Array<{ pos: Vec3; key: string }> = [];
  const enemyTiles: Array<{ pos: Vec3; key: string }> = [];

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const ch = grid[r][c] as TileChar;
      if (ch === 'A') {
        allyTiles.push({ key: `${r},${c}`, pos: { x: tileCenterX(c), y: 0.1, z: tileCenterZ(r) } });
      } else if (ch === 'E') {
        enemyTiles.push({ key: `${r},${c}`, pos: { x: tileCenterX(c), y: 0.1, z: tileCenterZ(r) } });
      }
    }
  }

  // Nearest-to-centerline pads first so allies[1] / enemies[1] are the central pads.
  allyTiles.sort((a, b) => b.pos.z - a.pos.z || a.pos.x - b.pos.x);
  enemyTiles.sort((a, b) => a.pos.z - b.pos.z || a.pos.x - b.pos.x);
  const pickThree = (tiles: Array<{ pos: Vec3; key: string }>) =>
    tiles.slice(0, 3).sort((a, b) => a.pos.x - b.pos.x);
  const allyPicked = pickThree(allyTiles);
  const enemyPicked = pickThree(enemyTiles);

  const usedAllyKeys = new Set<string>(allyPicked.map((t) => t.key));
  const usedEnemyKeys = new Set<string>(enemyPicked.map((t) => t.key));

  const southRows: number[] = [];
  for (let r = GRID_ROWS - 2; r >= 1; r--) southRows.push(r);
  const northRows: number[] = [];
  for (let r = 1; r <= GRID_ROWS - 2; r++) northRows.push(r);

  const allyFallbackTargets: ReadonlyArray<[number, number]> = [
    [-5, 33],
    [1, 33],
    [7, 33],
  ];
  const enemyFallbackTargets: ReadonlyArray<[number, number]> = [
    [-7, -35],
    [1, -35],
    [7, -35],
  ];

  const resolveTeamSpawns = (
    explicit: Array<{ pos: Vec3; key: string }>,
    fallbacks: ReadonlyArray<[number, number]>,
    rowOrder: readonly number[],
    usedKeys: Set<string>
  ): [Vec3, Vec3, Vec3] => {
    const out: Vec3[] = explicit.map((t) => t.pos);
    for (let i = out.length; i < 3; i++) {
      const [fx, fz] = fallbacks[i];
      const directSurface = isWorldCoordWalkable(grid, fx, fz);
      const fKey = `${worldToRow(fz)},${worldToCol(fx)}`;

      if (directSurface === 0 && !usedKeys.has(fKey)) {
        usedKeys.add(fKey);
        out.push({ x: fx, y: 0.1, z: fz });
      } else {
        out.push(findClosestWalkableSpawn(grid, fx, fz, rowOrder, usedKeys));
      }
    }
    return [out[0], out[1], out[2]];
  };

  const allies = resolveTeamSpawns(allyPicked, allyFallbackTargets, southRows, usedAllyKeys);
  const enemies = resolveTeamSpawns(enemyPicked, enemyFallbackTargets, northRows, usedEnemyKeys);

  // Buy fences adapt so custom spawn pads always sit inside their own buy zone.
  const minAllyZ = Math.min(allies[0].z, allies[1].z, allies[2].z);
  const maxEnemyZ = Math.max(enemies[0].z, enemies[1].z, enemies[2].z);

  return {
    allies,
    enemies,
    buyMinAllyZ: Math.min(BUY_MIN_ALLY_Z, minAllyZ - 1.0),
    buyMaxDefenderZ: Math.max(BUY_MAX_DEFENDER_Z, maxEnemyZ + 1.0),
  };
}

// ---------------------------------------------------------------------------
// Core Simulation State Sync (Runs at Module Load & on Every Build/Rebuild)
// ---------------------------------------------------------------------------

function applyGridData(rawGrid?: readonly string[]): void {
  const normalized = normalizeAsciiGrid(rawGrid);
  currentGrid = normalized;

  const mergedBlocks = greedyMeshGrid(normalized);
  cachedMergedBlocks = mergedBlocks;

  // Mutate ARENA_COLLIDERS strictly in-place so existing import bindings stay live.
  ARENA_COLLIDERS.length = 0;
  ARENA_COLLIDERS.push({
    min: { x: -HALF_WIDTH_M, y: -0.5, z: -HALF_DEPTH_M },
    max: { x: HALF_WIDTH_M, y: 0, z: HALF_DEPTH_M },
    tag: 'floor',
    color: COLOR_FLOOR,
  });
  for (const block of mergedBlocks) {
    ARENA_COLLIDERS.push(...block.colliders);
  }

  cachedSites = extractBombSites(normalized);
  cachedWaypoints = extractWaypoints(normalized, cachedSites);
  cachedSpawns = extractSpawns(normalized);
  cachedSpikePos = extractSpikeSpawn(normalized);

  // Site A landmark generator tower: its own collider keeps physics == visuals.
  cachedGenerator = extractGeneratorTower(normalized, cachedSites.A);
  if (cachedGenerator) {
    const g = cachedGenerator;
    ARENA_COLLIDERS.push({
      min: { x: g.x - g.half, y: g.baseY, z: g.z - g.half },
      max: { x: g.x + g.half, y: g.topY, z: g.z + g.half },
      tag: 'cover',
      color: COLOR_CRATE,
    });
  }
}

/** World center of the (first) `S` Spike Pedestal tile, or the default fallback. */
function extractSpikeSpawn(grid: readonly string[]): Vec3 {
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (grid[r][c] === 'S') {
        return { x: tileCenterX(c), y: SPIKE_PEDESTAL_TOP_Y, z: tileCenterZ(r) };
      }
    }
  }
  return { ...FALLBACK_SPIKE_POS };
}

/**
 * Picks the `B` crate tile inside (or 1 tile around) Site A that is closest to
 * the plant-zone center to host the generator tower. `null` when none exists.
 */
function extractGeneratorTower(grid: readonly string[], siteA: BombSiteZone): GeneratorTowerSpec | null {
  let best: GeneratorTowerSpec | null = null;
  let bestD = Infinity;
  const margin = TILE_SIZE_M;
  for (let r = 1; r < GRID_ROWS - 1; r++) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      if (grid[r][c] !== 'B') continue;
      const x = tileCenterX(c);
      const z = tileCenterZ(r);
      if (x < siteA.minX - margin || x > siteA.maxX + margin || z < siteA.minZ - margin || z > siteA.maxZ + margin) {
        continue;
      }
      const d = (x - siteA.center.x) ** 2 + (z - siteA.center.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x, z, baseY: CRATE_HEIGHT_M, topY: GENERATOR_TOWER_TOP_Y, half: GENERATOR_TOWER_HALF };
      }
    }
  }
  return best;
}

// Seed default colliders/waypoints/spawns/sites immediately at module import.
applyGridData(DEFAULT_KILLHOUSE_GRID);

/** Default South (`+Z`) player spawn: the central Attacker pad of the default map. */
export const PLAYER_SPAWN: Vec3 = cachedSpawns.allies[1]
  ? cloneVec3(cachedSpawns.allies[1])
  : { x: 1, y: 0.1, z: 33 };

// ---------------------------------------------------------------------------
// Public Accessors
// ---------------------------------------------------------------------------

/**
 * Returns a copy of the currently active `36 x 40` ASCII grid rows.
 */
export function getCurrentGrid(): string[] {
  return [...currentGrid];
}

/**
 * World-space resting position of the round's single physical Spike: the
 * center of the `S` pedestal tile in the active grid (top of the pedestal),
 * falling back to `{ x: 0, y: 0.05, z: 29 }` when the grid has no `S` tile.
 */
export function getSpikeSpawnPos(): Vec3 {
  return cloneVec3(cachedSpikePos);
}

/**
 * Returns the auto-generated, zone-tagged AI navigation waypoint graph.
 */
export function getArenaWaypoints(): ArenaWaypoint[] {
  return cachedWaypoints.map((wp) => ({
    id: wp.id,
    pos: cloneVec3(wp.pos),
    neighbors: [...wp.neighbors],
    zone: wp.zone,
  }));
}

/**
 * Returns extracted Attacker/Defender spawn pads (with safe fallbacks) and
 * both buy-phase fences.
 */
export function getArenaSpawns(): ArenaSpawns {
  return {
    allies: [
      cloneVec3(cachedSpawns.allies[0]),
      cloneVec3(cachedSpawns.allies[1]),
      cloneVec3(cachedSpawns.allies[2]),
    ],
    enemies: [
      cloneVec3(cachedSpawns.enemies[0]),
      cloneVec3(cachedSpawns.enemies[1]),
      cloneVec3(cachedSpawns.enemies[2]),
    ],
    buyMinAllyZ: cachedSpawns.buyMinAllyZ,
    buyMaxDefenderZ: cachedSpawns.buyMaxDefenderZ,
  };
}

/**
 * Returns both bomb-site plant zones (bounding boxes of the `1` / `2` tile
 * clusters, with safe fallbacks) for the active grid.
 */
export function getBombSites(): Record<BombSiteId, BombSiteZone> {
  return { A: cloneSite(cachedSites.A), B: cloneSite(cachedSites.B) };
}

/**
 * Returns which bomb site plant zone contains world point `(x, z)`, or `null`.
 */
export function getBombSiteAt(x: number, z: number): BombSiteId | null {
  for (const id of ['A', 'B'] as const) {
    const s = cachedSites[id];
    if (x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3D Scene Disposal & Architectural Construction
// ---------------------------------------------------------------------------

/**
 * Frees every GPU resource under `root`: geometries, materials and EVERY
 * texture slot (`map`, `bumpMap`, `alphaMap`, `emissiveMap`, ...) plus light
 * shadow maps. Cached procedural textures are safe to dispose: Three.js
 * re-uploads a disposed `CanvasTexture` the next time a material samples it.
 */
function disposeArenaRoot(root: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  const collectMaterial = (mat: THREE.Material) => {
    materials.add(mat);
    for (const value of Object.values(mat)) {
      if (value instanceof THREE.Texture) textures.add(value);
    }
  };

  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
      geometries.add(obj.geometry);
      if (Array.isArray(obj.material)) {
        for (const mat of obj.material) collectMaterial(mat);
      } else if (obj.material) {
        collectMaterial(obj.material);
      }
    } else if (obj instanceof THREE.Sprite) {
      // Sprite geometry is a Three.js shared singleton: dispose material + texture only.
      collectMaterial(obj.material);
    } else if (obj instanceof THREE.DirectionalLight) {
      obj.shadow.dispose();
    }
  });

  for (const geo of geometries) geo.dispose();
  for (const tex of textures) tex.dispose();
  for (const mat of materials) mat.dispose();
  root.removeFromParent();
}

/**
 * UV layout for box meshes:
 * - `'world'`: world-anchored planar UVs, one texture repeat per
 *   `TEXTURE_WORLD_SIZE_M` (4m) on every face -> uniform texel density across
 *   walls / floors of any size, and seamless continuation between blocks.
 * - `'tile'` : horizontal axes repeat every 2m tile, vertical side-face V is
 *   normalized to the box height -> one full crate / cargo / trim pattern per
 *   tile segment.
 */
type UvMode = 'world' | 'tile';

function applyBoxUVs(
  geo: THREE.BufferGeometry,
  cx: number,
  cy: number,
  cz: number,
  minY: number,
  maxY: number,
  mode: UvMode
): void {
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  if (!pos || !nor || !uv) return;
  const s = mode === 'world' ? TEXTURE_WORLD_SIZE_M : TILE_SIZE_M;
  const hY = Math.max(1e-4, maxY - minY);

  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i) + cx;
    const py = pos.getY(i) + cy;
    const pz = pos.getZ(i) + cz;
    const nx = nor.getX(i);
    const ny = nor.getY(i);
    const nz = nor.getZ(i);
    let u: number;
    let v: number;
    if (Math.abs(ny) > 0.5) {
      u = px / s;
      v = pz / s;
    } else {
      // Right-handed "along the wall" axis as seen from outside the face.
      const along = Math.abs(nx) > 0.5 ? pz * -Math.sign(nx) : px * Math.sign(nz);
      u = along / s;
      v = mode === 'tile' ? (py - minY) / hY : py / s;
    }
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
}

function addBoxMesh(
  parent: THREE.Object3D,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
  material: THREE.Material,
  edgeMaterial?: THREE.LineBasicMaterial,
  uvMode: UvMode = 'world'
): THREE.Mesh {
  const geo = new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ);
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  applyBoxUVs(geo, cx, cy, cz, minY, maxY, uvMode);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(cx, cy, cz);
  parent.add(mesh);

  if (edgeMaterial) {
    const edges = new THREE.EdgesGeometry(geo);
    mesh.add(new THREE.LineSegments(edges, edgeMaterial));
  }
  return mesh;
}

/** Solid block material with polygon offset so EdgesGeometry lines never stipple-flicker. */
function solidMat(color: number, roughness: number, metalness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

/**
 * Procedurally textured PBR material. `tint` multiplies the albedo map; when
 * no DOM canvas exists (headless) the flat `fallback` color is used instead.
 * Solid bodies get `polygonOffset(1, 1)`; proud trims pass `offset = false`.
 */
function pbrMat(
  texId: ArenaTextureId,
  tint: number,
  fallback: number,
  roughness: number,
  metalness: number,
  bumpScale = 1,
  offset = true
): THREE.MeshStandardMaterial {
  const tex = getArenaTexture(texId);
  const mat = new THREE.MeshStandardMaterial({
    color: tex.map ? tint : fallback,
    roughness,
    metalness,
    polygonOffset: offset,
    polygonOffsetFactor: offset ? 1 : 0,
    polygonOffsetUnits: offset ? 1 : 0,
  });
  if (tex.map) mat.map = tex.map;
  if (tex.bumpMap) {
    mat.bumpMap = tex.bumpMap;
    mat.bumpScale = bumpScale;
  }
  return mat;
}

/** Flat translucent floor decal material (never writes depth -> zero Z-fighting with floor). */
function decalMat(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    toneMapped: false,
  });
}

/** Unlit glowing material for emitters / light strips (never casts shadows). */
function glowMat(color: number, opacity = 1, additive = false): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1 || additive,
    opacity,
    depthWrite: !(opacity < 1 || additive),
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: additive ? THREE.DoubleSide : THREE.FrontSide,
    toneMapped: false,
  });
}

function nowSeconds(): number {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

// ---------------------------------------------------------------------------
// Regional Theming (West Sandstone | Mid Slate | East Cobalt-Steel)
// ---------------------------------------------------------------------------

type Region = 'west' | 'mid' | 'east';

function regionOfX(x: number): Region {
  if (x < REGION_WEST_MAX_X) return 'west';
  if (x > REGION_EAST_MIN_X) return 'east';
  return 'mid';
}

/** Splits `[minX, maxX]` at region seams so long merged walls switch skins cleanly. */
function splitByRegion(minX: number, maxX: number): Array<{ x0: number; x1: number; region: Region }> {
  const cuts = [minX];
  for (const seam of [REGION_WEST_MAX_X, REGION_EAST_MIN_X]) {
    if (seam > minX + 1e-6 && seam < maxX - 1e-6) cuts.push(seam);
  }
  cuts.push(maxX);
  const out: Array<{ x0: number; x1: number; region: Region }> = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    out.push({ x0: cuts[i], x1: cuts[i + 1], region: regionOfX((cuts[i] + cuts[i + 1]) * 0.5) });
  }
  return out;
}

interface RegionMaterials {
  /** Interior partitions, window walls, low-cover bodies, deck skirts. */
  wall: THREE.MeshStandardMaterial;
  perimeter: THREE.MeshStandardMaterial;
  /** Proud caps / baseboards / caprails (tile UVs, no polygon offset). */
  trim: THREE.MeshStandardMaterial;
  /** Vertical posts & pilasters. */
  post: THREE.MeshStandardMaterial;
  /** Keystones & small accents. */
  accent: THREE.MeshStandardMaterial;
  archStone: THREE.MeshStandardMaterial;
  /** Inset top plate on wall caps (keeps wide wall tops from reading as one giant trim). */
  coping: THREE.MeshStandardMaterial;
  floor: THREE.MeshStandardMaterial;
}

function createRegionMaterials(): Record<Region, RegionMaterials> {
  return {
    west: {
      wall: pbrMat('sandstone_ashlar', 0xffffff, COLOR_SANDSTONE, 0.9, 0.02, 1.4),
      perimeter: pbrMat('sandstone_ashlar', 0xe2d3bd, 0xb8956a, 0.92, 0.02, 1.4),
      trim: pbrMat('terracotta_trim', 0xffffff, COLOR_TERRACOTTA, 0.82, 0.04, 1.0, false),
      post: pbrMat('terracotta_trim', 0xf0d8cc, COLOR_TERRACOTTA, 0.82, 0.04, 1.0, false),
      accent: new THREE.MeshStandardMaterial({ color: COLOR_TERRACOTTA, roughness: 0.6, metalness: 0.1 }),
      archStone: pbrMat('sandstone_ashlar', 0xf6ead8, COLOR_SANDSTONE, 0.88, 0.02, 1.2),
      coping: pbrMat('sandstone_ashlar', 0xd9c7ad, COLOR_SANDSTONE, 0.9, 0.02, 1.0, false),
      floor: pbrMat('plaza_concrete', 0xf2e2ca, 0x8c8172, 0.94, 0.02, 0.9),
    },
    mid: {
      wall: pbrMat('plaza_concrete', 0xbfc6d0, COLOR_SLATE_WALL, 0.88, 0.05, 1.1),
      perimeter: pbrMat('plaza_concrete', 0x9fa9b7, COLOR_PERIMETER_WALL, 0.9, 0.06, 1.1),
      trim: new THREE.MeshStandardMaterial({ color: COLOR_PERIMETER_TRIM, roughness: 0.6, metalness: 0.4 }),
      post: new THREE.MeshStandardMaterial({ color: COLOR_STEEL_FRAME, roughness: 0.55, metalness: 0.42 }),
      accent: new THREE.MeshStandardMaterial({ color: COLOR_BOLLARD, roughness: 0.45, metalness: 0.25 }),
      archStone: pbrMat('plaza_concrete', 0xd3d8df, COLOR_ARCH_STONE, 0.82, 0.06, 1.0),
      coping: pbrMat('plaza_concrete', 0xa9b2be, COLOR_SLATE_WALL, 0.9, 0.05, 1.0, false),
      floor: pbrMat('plaza_concrete', 0xffffff, COLOR_FLOOR, 0.92, 0.04, 0.9),
    },
    east: {
      wall: pbrMat('cobalt_steel', 0xffffff, COLOR_COBALT_STEEL, 0.58, 0.22, 1.3),
      perimeter: pbrMat('cobalt_steel', 0xc2ccd8, 0x34506c, 0.62, 0.2, 1.3),
      trim: pbrMat('hazard_trim', 0xffffff, COLOR_HAZARD, 0.55, 0.3, 1.0, false),
      post: new THREE.MeshStandardMaterial({ color: 0x2c3746, roughness: 0.5, metalness: 0.35 }),
      accent: new THREE.MeshStandardMaterial({ color: COLOR_HAZARD, roughness: 0.45, metalness: 0.3 }),
      archStone: pbrMat('cobalt_steel', 0xd5dde8, COLOR_ARCH_PILASTER, 0.6, 0.22, 1.2),
      coping: pbrMat('cobalt_steel', 0xaab6c6, COLOR_COBALT_STEEL, 0.62, 0.2, 1.0, false),
      floor: pbrMat('plaza_concrete', 0xd4dfec, 0x6f7f92, 0.88, 0.08, 0.9),
    },
  };
}

// ---------------------------------------------------------------------------
// Floor, Tactical Grid & Buy-Fence Floor Lines
// ---------------------------------------------------------------------------

function buildFloorAndGrid(root: THREE.Group, regions: Record<Region, RegionMaterials>): void {
  // Three region slabs (one physics collider) with world-anchored 2m concrete slabs.
  for (const seg of splitByRegion(-HALF_WIDTH_M, HALF_WIDTH_M)) {
    const slab = addBoxMesh(root, seg.x0, seg.x1, -0.5, 0, -HALF_DEPTH_M, HALF_DEPTH_M, regions[seg.region].floor);
    slab.userData.shadowMode = 'receive';
  }

  // Exact 72m x 80m 2m tactical grid lines clipped cleanly to arena bounds.
  const linePoints: number[] = [];
  const y = 0.006;
  for (let x = -HALF_WIDTH_M; x <= HALF_WIDTH_M + 1e-4; x += TILE_SIZE_M) {
    linePoints.push(x, y, -HALF_DEPTH_M, x, y, HALF_DEPTH_M);
  }
  for (let z = -HALF_DEPTH_M; z <= HALF_DEPTH_M + 1e-4; z += TILE_SIZE_M) {
    linePoints.push(-HALF_WIDTH_M, y, z, HALF_WIDTH_M, y, z);
  }

  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePoints, 3));
  const gridMat = new THREE.LineBasicMaterial({
    color: COLOR_FLOOR_GRID,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
  });
  const gridLines = new THREE.LineSegments(gridGeo, gridMat);
  gridLines.renderOrder = 2;
  root.add(gridLines);

  // Buy-phase fences: Attackers (South) fenced at buyMinAllyZ, Defenders (North) at buyMaxDefenderZ.
  const addZoneLine = (zPos: number, hex: number, opacity: number) => {
    const geo = new THREE.BufferGeometry();
    const xEdge = HALF_WIDTH_M - TILE_SIZE_M;
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-xEdge, 0.01, zPos, xEdge, 0.01, zPos], 3));
    const mat = new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity, depthWrite: false });
    const line = new THREE.LineSegments(geo, mat);
    line.renderOrder = 3;
    root.add(line);
  };

  addZoneLine(cachedSpawns.buyMinAllyZ, COLOR_BARRIER_ATTACK, 0.55);
  addZoneLine(cachedSpawns.buyMaxDefenderZ, COLOR_BARRIER_DEFEND, 0.5);
}

/** Builds a single horizontal BufferGeometry of axis-aligned quads at height `y`. */
function buildFlatQuadGeometry(
  quads: ReadonlyArray<readonly [number, number, number, number]>,
  y: number
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [x0, x1, z0, z1] of quads) {
    const base = positions.length / 3;
    positions.push(x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Renders a glowing site letter into a CanvasTexture (null when no DOM is available). */
function createSiteLetterTexture(letter: string, color: number, ring: boolean): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const css = `#${color.toString(16).padStart(6, '0')}`;
  ctx.clearRect(0, 0, 256, 256);
  if (ring) {
    ctx.fillStyle = 'rgba(10, 14, 22, 0.55)';
    ctx.beginPath();
    ctx.arc(128, 128, 108, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 12;
    ctx.strokeStyle = css;
    ctx.shadowColor = css;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(128, 128, 104, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.shadowColor = css;
  ctx.shadowBlur = 22;
  ctx.fillStyle = ring ? '#ffffff' : css;
  ctx.font = 'bold 170px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, 128, 138);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * High-visibility bomb-site floor paint (per `1` / `2` tile), glowing perimeter
 * stripes around each plant zone, a painted floor letter, and a floating
 * holographic `A` / `B` marker above each site center.
 *
 * All decals use `depthWrite: false` + negative polygon offset + staggered
 * heights / renderOrder so they never Z-fight the floor, grid, or each other.
 */
function buildSiteMarkings(root: THREE.Group, grid: readonly string[]): void {
  const siteDefs: ReadonlyArray<{ id: BombSiteId; ch: string; color: number }> = [
    { id: 'A', ch: '1', color: COLOR_SITE_A },
    { id: 'B', ch: '2', color: COLOR_SITE_B },
  ];

  for (const def of siteDefs) {
    const zone = cachedSites[def.id];

    // 1. Floor paint on every plant tile.
    const tileQuads: Array<[number, number, number, number]> = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (grid[r][c] !== def.ch) continue;
        const x0 = -HALF_WIDTH_M + c * TILE_SIZE_M;
        const z0 = -HALF_DEPTH_M + r * TILE_SIZE_M;
        tileQuads.push([x0, x0 + TILE_SIZE_M, z0, z0 + TILE_SIZE_M]);
      }
    }
    if (tileQuads.length === 0) continue;

    const paint = new THREE.Mesh(buildFlatQuadGeometry(tileQuads, 0.004), decalMat(def.color, 0.2));
    paint.renderOrder = 1;
    root.add(paint);

    // 2. Glowing perimeter stripes hugging the plant-zone bounding box.
    const w = 0.16;
    const inset = 0.06;
    const x0 = zone.minX + inset;
    const x1 = zone.maxX - inset;
    const z0 = zone.minZ + inset;
    const z1 = zone.maxZ - inset;
    const stripeQuads: Array<[number, number, number, number]> = [
      [x0, x1, z0, z0 + w],
      [x0, x1, z1 - w, z1],
      [x0, x0 + w, z0 + w, z1 - w],
      [x1 - w, x1, z0 + w, z1 - w],
    ];
    const stripes = new THREE.Mesh(buildFlatQuadGeometry(stripeQuads, 0.008), decalMat(def.color, 0.92));
    stripes.renderOrder = 3;
    root.add(stripes);

    // 3. Painted floor letter at the site center.
    const floorTex = createSiteLetterTexture(def.id, def.color, false);
    if (floorTex) {
      const letterMat = decalMat(0xffffff, 0.72);
      letterMat.map = floorTex;
      const letterSize = Math.min(zone.maxX - zone.minX, zone.maxZ - zone.minZ, 4.2) * 0.9;
      const letter = new THREE.Mesh(new THREE.PlaneGeometry(letterSize, letterSize), letterMat);
      letter.rotation.x = -Math.PI / 2;
      letter.position.set(zone.center.x, 0.011, zone.center.z);
      letter.renderOrder = 4;
      root.add(letter);
    }

    // 4. Floating holographic tactical marker (always faces the camera).
    const holoTex = createSiteLetterTexture(def.id, def.color, true);
    if (holoTex) {
      const spriteMat = new THREE.SpriteMaterial({
        map: holoTex,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(spriteMat);
      sprite.scale.set(1.6, 1.6, 1);
      sprite.position.set(zone.center.x, 4.6, zone.center.z);
      sprite.renderOrder = 5;
      root.add(sprite);
    }
  }
}

/**
 * Decides whether a merged window / archway block runs along X (opening faces
 * +-Z) or along Z (opening faces +-X), using span shape then wall neighbors.
 */
function runsAlongX(block: MergedBlock, grid: readonly string[]): boolean {
  if (block.colsSpan > block.rowsSpan) return true;
  if (block.rowsSpan > block.colsSpan) return false;
  const { row, col } = block;
  const lr = isTallSolid(tileAt(grid, row, col - 1)) || isTallSolid(tileAt(grid, row, col + block.colsSpan));
  if (lr) return true;
  const ud = isTallSolid(tileAt(grid, row - 1, col)) || isTallSolid(tileAt(grid, row + block.rowsSpan, col));
  return !ud;
}

interface FrameMaterials {
  windowWall: THREE.MeshStandardMaterial;
  archStone: THREE.MeshStandardMaterial;
  frame: THREE.MeshStandardMaterial;
  pilaster: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  edge: THREE.LineBasicMaterial;
}

/**
 * Window (`W`) / Archway (`O`) geometry in "run space": `a` runs along the wall
 * line, `d` is wall depth. Every trim is either inset or proud by >= 0.006m so
 * no visible faces are ever coplanar.
 */
function buildWindowOrArchway(
  root: THREE.Group,
  block: MergedBlock,
  grid: readonly string[],
  m: FrameMaterials
): void {
  const alongX = runsAlongX(block, grid);
  const { min, max } = block.box;
  const a0 = alongX ? min.x : min.z;
  const a1 = alongX ? max.x : max.z;
  const d0 = alongX ? min.z : min.x;
  const d1 = alongX ? max.z : max.x;

  const box = (
    pa0: number,
    pa1: number,
    y0: number,
    y1: number,
    pd0: number,
    pd1: number,
    mat: THREE.Material,
    edge?: THREE.LineBasicMaterial
  ) =>
    alongX
      ? addBoxMesh(root, pa0, pa1, y0, y1, pd0, pd1, mat, edge)
      : addBoxMesh(root, pd0, pd1, y0, y1, pa0, pa1, mat, edge);

  // Neighbor tiles just beyond each end of the run (only full walls host casings/pilasters).
  const startNeighbor = alongX ? tileAt(grid, block.row, block.col - 1) : tileAt(grid, block.row - 1, block.col);
  const endNeighbor = alongX
    ? tileAt(grid, block.row, block.col + block.colsSpan)
    : tileAt(grid, block.row + block.rowsSpan, block.col);
  const hostStart = startNeighbor === '#';
  const hostEnd = endNeighbor === '#';

  if (block.kind === 'window') {
    // Sill (collider 0..1.12) = body + proud ledge cap; lintel (collider 2.55..3.60) = body + proud soffit.
    box(a0, a1, 0, 1.08, d0, d1, m.windowWall, m.edge);
    box(a0 + 0.008, a1 - 0.008, 1.076, WINDOW_SILL_TOP_M, d0 - 0.04, d1 + 0.04, m.frame);
    box(a0, a1, 2.594, 3.596, d0, d1, m.windowWall, m.edge);
    box(a0 + 0.008, a1 - 0.008, WINDOW_LINTEL_BOTTOM_M, 2.598, d0 - 0.012, d1 + 0.012, m.frame);

    // Jamb casings recessed inside the host walls, proud +0.02m of the wall faces.
    if (hostStart) box(a0 - 0.14, a0 - 0.006, 1.04, 2.63, d0 - 0.02, d1 + 0.02, m.frame);
    if (hostEnd) box(a1 + 0.006, a1 + 0.14, 1.04, 2.63, d0 - 0.02, d1 + 0.02, m.frame);

    // Mullion strips at internal tile seams on the sill & lintel faces (+0.012m proud).
    for (let s = a0 + TILE_SIZE_M; s < a1 - 1e-4; s += TILE_SIZE_M) {
      box(s - 0.03, s + 0.03, 0.004, 1.076, d0 - 0.012, d1 + 0.012, m.frame);
      box(s - 0.03, s + 0.03, 2.602, 3.5, d0 - 0.012, d1 + 0.012, m.frame);
    }
    return;
  }

  // Archway: overhead header beam (collider 2.65..3.60) + proud soffit + keystone.
  box(a0, a1, 2.69, 3.596, d0, d1, m.archStone, m.edge);
  box(a0 + 0.008, a1 - 0.008, ARCH_HEADER_BOTTOM_M, 2.694, d0 - 0.012, d1 + 0.012, m.frame);
  const mid = (a0 + a1) * 0.5;
  box(mid - 0.2, mid + 0.2, 2.86, 3.42, d0 - 0.02, d1 + 0.02, m.accent);

  // Side pilasters + capitals living inside the host walls, proud +0.03m / +0.05m.
  if (hostStart) {
    box(a0 - 0.18, a0 - 0.006, 0.004, 2.7, d0 - 0.03, d1 + 0.03, m.pilaster);
    box(a0 - 0.22, a0 - 0.006, 2.7, 2.84, d0 - 0.05, d1 + 0.05, m.frame);
  }
  if (hostEnd) {
    box(a1 + 0.006, a1 + 0.18, 0.004, 2.7, d0 - 0.03, d1 + 0.03, m.pilaster);
    box(a1 + 0.006, a1 + 0.22, 2.7, 2.84, d0 - 0.05, d1 + 0.05, m.frame);
  }
}

/**
 * Olive braced cargo (`D`, 1.72m): two stenciled timber tiers per merged block,
 * a proud seam band, a proud top cap, and diagonal bracing on every outer face
 * of every tile segment (alternating per tier for an X-brace feel).
 */
function buildDoubleBox(
  root: THREE.Group,
  block: MergedBlock,
  bodyMat: THREE.MeshStandardMaterial,
  trimMat: THREE.MeshStandardMaterial,
  braceMat: THREE.MeshStandardMaterial,
  edgeMat: THREE.LineBasicMaterial
): void {
  const { min, max } = block.box;
  const p = 0.008;
  addBoxMesh(root, min.x, max.x, 0, 0.84, min.z, max.z, bodyMat, edgeMat, 'tile');
  addBoxMesh(root, min.x, max.x, 0.88, 1.68, min.z, max.z, bodyMat, edgeMat, 'tile');
  addBoxMesh(root, min.x - p, max.x + p, 0.836, 0.884, min.z - p, max.z + p, trimMat, undefined, 'tile');
  addBoxMesh(root, min.x - p, max.x + p, 1.676, DOUBLE_BOX_HEIGHT_M, min.z - p, max.z + p, trimMat, undefined, 'tile');

  const tiers: ReadonlyArray<readonly [number, number]> = [
    [0.0, 0.836],
    [0.884, 1.676],
  ];
  const braceThick = 0.014;
  const braceOffset = 0.012 + braceThick * 0.5; // inner face 0.012m proud (clear of 0.008m bands)
  const braceWidth = 0.07;

  const addBrace = (cx: number, cy: number, cz: number, segLen: number, tierH: number, faceAxis: 'x' | 'z', flip: boolean) => {
    const diag = Math.hypot(segLen, tierH) - 0.16;
    const angle = Math.atan2(tierH, segLen) * (flip ? -1 : 1);
    const geo =
      faceAxis === 'z'
        ? new THREE.BoxGeometry(diag, braceWidth, braceThick)
        : new THREE.BoxGeometry(braceThick, braceWidth, diag);
    const mesh = new THREE.Mesh(geo, braceMat);
    mesh.position.set(cx, cy, cz);
    if (faceAxis === 'z') mesh.rotation.z = angle;
    else mesh.rotation.x = -angle;
    root.add(mesh);
  };

  tiers.forEach(([y0, y1], tierIdx) => {
    const cy = (y0 + y1) * 0.5;
    const tierH = y1 - y0 - 0.06;
    for (let dc = 0; dc < block.colsSpan; dc++) {
      const cx = min.x + (dc + 0.5) * TILE_SIZE_M;
      const flip = (dc + tierIdx) % 2 === 1;
      addBrace(cx, cy, min.z - braceOffset, TILE_SIZE_M, tierH, 'z', flip);
      addBrace(cx, cy, max.z + braceOffset, TILE_SIZE_M, tierH, 'z', !flip);
    }
    for (let dr = 0; dr < block.rowsSpan; dr++) {
      const cz = min.z + (dr + 0.5) * TILE_SIZE_M;
      const flip = (dr + tierIdx) % 2 === 1;
      addBrace(min.x - braceOffset, cy, cz, TILE_SIZE_M, tierH, 'x', flip);
      addBrace(max.x + braceOffset, cy, cz, TILE_SIZE_M, tierH, 'x', !flip);
    }
  });
}

function buildArchitecturalBlocks(root: THREE.Group, grid: readonly string[], regions: Record<Region, RegionMaterials>): void {
  const cargoMat = pbrMat('olive_cargo', 0xffffff, COLOR_DOUBLE_BOX, 0.8, 0.1, 1.2);
  const crateMat = pbrMat('radianite_crate', 0xffffff, COLOR_CRATE, 0.6, 0.22, 1.3);
  const deckMat = pbrMat('steel_grate', 0xffffff, COLOR_WATCHTOWER, 0.55, 0.3, 1.6);
  const stairMat = pbrMat('steel_grate', 0xe6ebf2, COLOR_STAIR, 0.58, 0.28, 1.6);

  const caprailMat = new THREE.MeshStandardMaterial({ color: COLOR_CAPRAIL, roughness: 0.65, metalness: 0.3 });
  const crateTrimMat = new THREE.MeshStandardMaterial({ color: COLOR_CRATE_TRIM, roughness: 0.5, metalness: 0.55 });
  const doubleBoxTrimMat = new THREE.MeshStandardMaterial({ color: COLOR_DOUBLE_BOX_TRIM, roughness: 0.6, metalness: 0.3 });
  const doubleBoxBraceMat = new THREE.MeshStandardMaterial({ color: COLOR_DOUBLE_BOX_BRACE, roughness: 0.7, metalness: 0.15 });
  const bollardMat = new THREE.MeshStandardMaterial({ color: COLOR_BOLLARD, roughness: 0.45, metalness: 0.2 });
  const windowFrameMat = new THREE.MeshStandardMaterial({ color: COLOR_WINDOW_FRAME, roughness: 0.5, metalness: 0.5 });

  const edgeMat = new THREE.LineBasicMaterial({ color: 0x2a323d, transparent: true, opacity: 0.22 });

  const frameMatsByRegion: Record<Region, FrameMaterials> = {
    west: { windowWall: regions.west.wall, archStone: regions.west.archStone, frame: windowFrameMat, pilaster: regions.west.post, accent: regions.west.accent, edge: edgeMat },
    mid: { windowWall: regions.mid.wall, archStone: regions.mid.archStone, frame: windowFrameMat, pilaster: regions.mid.post, accent: regions.mid.accent, edge: edgeMat },
    east: { windowWall: regions.east.wall, archStone: regions.east.archStone, frame: windowFrameMat, pilaster: regions.east.post, accent: regions.east.accent, edge: edgeMat },
  };

  // Trim/post extrusion reliefs eliminate coplanar Z-fighting with base wall/cover meshes.
  const trimProud = 0.008;
  const postProud = 0.012;

  for (const block of cachedMergedBlocks) {
    const { box, kind } = block;
    const { min, max } = box;
    const blockRegion = regionOfX((min.x + max.x) * 0.5);

    if (kind === 'perimeter' || kind === 'wall_interior') {
      const isPerimeter = kind === 'perimeter';
      for (const seg of splitByRegion(min.x, max.x)) {
        const rm = regions[seg.region];
        // Proud trims only overhang the block's TRUE ends (never at internal region seams).
        const tx0 = Math.abs(seg.x0 - min.x) < 1e-6 ? seg.x0 - trimProud : seg.x0;
        const tx1 = Math.abs(seg.x1 - max.x) < 1e-6 ? seg.x1 + trimProud : seg.x1;
        // Inset coping plate 6mm proud above the cap (inset only at TRUE block ends).
        const copingInset = 0.12;
        const cx0 = Math.abs(seg.x0 - min.x) < 1e-6 ? seg.x0 + copingInset : seg.x0;
        const cx1 = Math.abs(seg.x1 - max.x) < 1e-6 ? seg.x1 - copingInset : seg.x1;
        const capTop = isPerimeter ? PERIMETER_HEIGHT_M : INTERIOR_WALL_HEIGHT_M;
        addBoxMesh(root, cx0, cx1, capTop - 0.002, capTop + 0.006, min.z + copingInset, max.z - copingInset, rm.coping);
        if (isPerimeter) {
          // Base wall (0..4.6m) + proud baseboard/top coping overlapping by 0.004m.
          addBoxMesh(root, seg.x0, seg.x1, 0.22, 4.5, min.z, max.z, rm.perimeter, edgeMat);
          addBoxMesh(root, tx0, tx1, 0, 0.224, min.z - trimProud, max.z + trimProud, rm.trim, undefined, 'tile');
          addBoxMesh(root, tx0, tx1, 4.496, PERIMETER_HEIGHT_M, min.z - trimProud, max.z + trimProud, rm.trim, undefined, 'tile');
        } else {
          // Partition (0..3.6m) + proud regional top cap.
          addBoxMesh(root, seg.x0, seg.x1, 0, 3.5, min.z, max.z, rm.wall, edgeMat);
          addBoxMesh(root, tx0, tx1, 3.496, INTERIOR_WALL_HEIGHT_M, min.z - trimProud, max.z + trimProud, rm.trim, undefined, 'tile');
        }
      }
      if (isPerimeter) continue;

      // Proud vertical posts / pilasters at tile seams (regional material), built
      // as THIN face strips (<= 3cm inside the body) + L-shaped corner posts, so
      // no large post face ever sits just behind a polygon-offset wall face.
      const postW = 0.11;
      const embed = 0.03;
      const postMinY = 0.004;
      const postMaxY = 3.496;
      const strip = (x0: number, x1: number, z0: number, z1: number, region: Region) =>
        addBoxMesh(root, x0, x1, postMinY, postMaxY, z0, z1, regions[region].post, undefined, 'tile');

      for (let dc = 0; dc <= block.colsSpan; dc++) {
        const sx = min.x + dc * TILE_SIZE_M;
        const region = regionOfX(dc === 0 ? sx + 0.01 : sx - 0.01);
        let x0: number;
        let x1: number;
        if (dc === 0) {
          x0 = min.x - postProud;
          x1 = min.x + postW;
        } else if (dc === block.colsSpan) {
          x0 = max.x - postW;
          x1 = max.x + postProud;
        } else {
          x0 = sx - postW * 0.5;
          x1 = sx + postW * 0.5;
        }
        strip(x0, x1, min.z - postProud, min.z + embed, region); // North face
        strip(x0, x1, max.z - embed, max.z + postProud, region); // South face
      }
      // East / West faces: corner returns (complete the L) + interior row seams.
      for (let dr = 0; dr <= block.rowsSpan; dr++) {
        const sz = min.z + dr * TILE_SIZE_M;
        let z0: number;
        let z1: number;
        if (dr === 0) {
          z0 = min.z + embed;
          z1 = min.z + postW;
        } else if (dr === block.rowsSpan) {
          z0 = max.z - postW;
          z1 = max.z - embed;
        } else {
          z0 = sz - postW * 0.5;
          z1 = sz + postW * 0.5;
        }
        strip(min.x - postProud, min.x + embed, z0, z1, regionOfX(min.x + 0.01)); // West face
        strip(max.x - embed, max.x + postProud, z0, z1, regionOfX(max.x - 0.01)); // East face
      }
    } else if (kind === 'window' || kind === 'archway') {
      buildWindowOrArchway(root, block, grid, frameMatsByRegion[blockRegion]);
    } else if (kind === 'low_cover') {
      // Head-glitch barrier (1.26m): regional masonry/steel body + proud regional caprail.
      addBoxMesh(root, min.x, max.x, 0, 1.17, min.z, max.z, regions[blockRegion].wall, edgeMat);
      addBoxMesh(root, min.x - trimProud, max.x + trimProud, 1.166, LOW_COVER_HEIGHT_M, min.z - trimProud, max.z + trimProud, regions[blockRegion].trim, undefined, 'tile');
    } else if (kind === 'double_box') {
      buildDoubleBox(root, block, cargoMat, doubleBoxTrimMat, doubleBoxBraceMat, edgeMat);
    } else if (kind === 'crate') {
      // Radianite crate (2.25m): stenciled body + proud dark steel base/top frame bands.
      addBoxMesh(root, min.x, max.x, 0.14, 2.11, min.z, max.z, crateMat, edgeMat, 'tile');
      addBoxMesh(root, min.x - trimProud, max.x + trimProud, 0, 0.144, min.z - trimProud, max.z + trimProud, crateTrimMat);
      addBoxMesh(root, min.x - trimProud, max.x + trimProud, 2.106, CRATE_HEIGHT_M, min.z - trimProud, max.z + trimProud, crateTrimMat);
    } else if (kind === 'platform') {
      // Diamond-plate deck (0.90m) over an inset regional skirt + corner bollards.
      addBoxMesh(root, min.x + trimProud, max.x - trimProud, 0, 0.784, min.z + trimProud, max.z - trimProud, regions[blockRegion].wall);
      addBoxMesh(root, min.x, max.x, 0.78, PLATFORM_HEIGHT_M, min.z, max.z, deckMat, edgeMat, 'tile');

      const inset = 0.16;
      const bHalf = 0.055;
      const corners: ReadonlyArray<[number, number]> = [
        [min.x + inset, min.z + inset],
        [max.x - inset, min.z + inset],
        [min.x + inset, max.z - inset],
        [max.x - inset, max.z - inset],
      ];
      for (const [bx, bz] of corners) {
        addBoxMesh(root, bx - bHalf, bx + bHalf, PLATFORM_HEIGHT_M, 1.08, bz - bHalf, bz + bHalf, bollardMat);
      }
    } else if (kind === 'stair') {
      addBoxMesh(root, min.x, max.x, 0, STAIR_HEIGHT_M, min.z, max.z, stairMat, edgeMat, 'tile');
    }
  }

  // Per-tile anti-slip tread bars on `^` and `v` stairs so step direction is obvious.
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const ch = grid[r][c] as TileChar;
      if (ch !== '^' && ch !== 'v') continue;

      const x0 = -HALF_WIDTH_M + c * TILE_SIZE_M + 0.14;
      const x1 = -HALF_WIDTH_M + (c + 1) * TILE_SIZE_M - 0.14;
      const zTileMin = -HALF_DEPTH_M + r * TILE_SIZE_M;

      // 3 grip cleats along Z, raised proud (0.448..0.462) above the 0.45m step top face.
      const offsets = ch === '^' ? [0.35, 0.95, 1.55] : [0.45, 1.05, 1.65];
      for (const off of offsets) {
        addBoxMesh(root, x0, x1, 0.448, 0.462, zTileMin + off - 0.06, zTileMin + off + 0.06, caprailMat);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Landmarks: Radianite Spike Pedestal & Site A Generator Tower
// ---------------------------------------------------------------------------

/**
 * Low hexagonal Radianite pedestal centered on the `S` tile. Purely visual
 * (5cm tall, no collider): the dropped Spike rests on its top at
 * `SPIKE_PEDESTAL_TOP_Y`, with a glowing inset hex ring, core disc, corner
 * studs and a faint pulsing light column.
 */
function buildSpikePedestal(root: THREE.Group, pos: Vec3): void {
  const group = new THREE.Group();
  group.name = 'spike-pedestal';
  group.position.set(pos.x, 0, pos.z);

  const steel = solidMat(0x343c48, 0.42, 0.45);
  const radianiteDark = new THREE.MeshStandardMaterial({
    color: 0x3a1622,
    roughness: 0.32,
    metalness: 0.6,
    emissive: COLOR_RADIANITE,
    emissiveIntensity: 0.2,
  });

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.98, 1.04, 0.03, 6), steel);
  base.position.y = 0.015;
  group.add(base);

  const tier = new THREE.Mesh(new THREE.CylinderGeometry(0.74, 0.8, SPIKE_PEDESTAL_TOP_Y - 0.03, 6), radianiteDark);
  tier.position.y = 0.03 + (SPIKE_PEDESTAL_TOP_Y - 0.03) * 0.5;
  group.add(tier);

  const ringMat = decalMat(COLOR_RADIANITE, 0.95);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 6, 1, Math.PI / 6), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = SPIKE_PEDESTAL_TOP_Y + 0.0015;
  ring.renderOrder = 4;
  ring.userData.shadowMode = 'none';
  group.add(ring);

  const coreMat = decalMat(0xff9fb2, 0.4);
  const core = new THREE.Mesh(new THREE.CircleGeometry(0.44, 6, Math.PI / 6), coreMat);
  core.rotation.x = -Math.PI / 2;
  core.position.y = SPIKE_PEDESTAL_TOP_Y + 0.001;
  core.renderOrder = 3;
  core.userData.shadowMode = 'none';
  group.add(core);

  const studMat = glowMat(COLOR_RADIANITE);
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * k;
    const sx = Math.sin(a) * 0.88;
    const sz = Math.cos(a) * 0.88;
    const stud = addBoxMesh(group, sx - 0.045, sx + 0.045, 0.03, 0.046, sz - 0.045, sz + 0.045, studMat);
    stud.userData.shadowMode = 'none';
  }

  const beamMat = glowMat(COLOR_RADIANITE, 0.1, true);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 1.4, 6, 1, true), beamMat);
  beam.position.y = SPIKE_PEDESTAL_TOP_Y + 0.7;
  beam.renderOrder = 6;
  beam.userData.shadowMode = 'none';
  beam.onBeforeRender = () => {
    const t = nowSeconds();
    beamMat.opacity = 0.07 + 0.05 * (0.5 + 0.5 * Math.sin(t * 2.6));
    ringMat.opacity = 0.75 + 0.2 * (0.5 + 0.5 * Math.sin(t * 2.6 + 1.1));
  };
  group.add(beam);

  root.add(group);
}

/**
 * Industrial A-Site Generator Tower standing on a Site A `B` crate. Every
 * visual part stays inside its own collider (`|dx|,|dz| <= 0.5`,
 * `y in [2.25, 4.10]`) pushed into `ARENA_COLLIDERS` by `applyGridData`.
 */
function buildGeneratorTower(root: THREE.Group, spec: GeneratorTowerSpec): void {
  const group = new THREE.Group();
  group.name = 'site-a-generator-tower';
  group.position.set(spec.x, 0, spec.z);

  const y0 = spec.baseY;
  const y1 = spec.topY;
  const steel = solidMat(0x4a5361, 0.45, 0.4);
  const pipeMat = new THREE.MeshStandardMaterial({ color: COLOR_STEEL_FRAME, roughness: 0.55, metalness: 0.42 });
  const hazard = pbrMat('hazard_trim', 0xffffff, COLOR_HAZARD, 0.5, 0.3, 1.0, false);
  const coilMat = new THREE.MeshStandardMaterial({
    color: 0x40210c,
    roughness: 0.35,
    metalness: 0.4,
    emissive: COLOR_GENERATOR_GLOW,
    emissiveIntensity: 1.6,
  });

  // Base plate (sits on the crate top band).
  addBoxMesh(group, -0.48, 0.48, y0, y0 + 0.08, -0.48, 0.48, steel);

  // Tapered generator core.
  const coreH = y1 - 0.5 - (y0 + 0.08);
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, coreH, 16), steel);
  core.position.y = y0 + 0.08 + coreH * 0.5;
  group.add(core);

  // Hazard collar near the base.
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.435, 0.435, 0.18, 20, 1, true), hazard);
  collar.position.y = y0 + 0.22;
  group.add(collar);

  // Glowing induction coils.
  for (let k = 0; k < 3; k++) {
    const t = 0.38 + k * 0.22;
    const radius = 0.42 - 0.08 * t + 0.01; // core radius at height fraction t, +1cm proud
    const coil = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.04, 8, 28), coilMat);
    coil.rotation.x = Math.PI / 2;
    coil.position.y = y0 + 0.08 + coreH * t;
    group.add(coil);
  }

  // Four coolant pipes at the plate corners.
  for (const [px, pz] of [
    [0.4, 0.4],
    [-0.4, 0.4],
    [0.4, -0.4],
    [-0.4, -0.4],
  ] as const) {
    const pipeH = y1 - 0.44 - (y0 + 0.08);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, pipeH, 8), pipeMat);
    pipe.position.set(px, y0 + 0.08 + pipeH * 0.5, pz);
    group.add(pipe);
  }

  // Hex cap + pulsing beacon (top of beacon == collider top).
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.47, 0.12, 6), steel);
  cap.position.y = y1 - 0.44;
  group.add(cap);
  const beaconMat = glowMat(COLOR_GENERATOR_GLOW);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), beaconMat);
  beacon.position.y = y1 - 0.15;
  beacon.userData.shadowMode = 'none';
  const baseBeacon = new THREE.Color(COLOR_GENERATOR_GLOW);
  beacon.onBeforeRender = () => {
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(nowSeconds() * 4.2));
    beaconMat.color.copy(baseBeacon).multiplyScalar(pulse);
    coilMat.emissiveIntensity = 1.1 + pulse * 0.9;
  };
  group.add(beacon);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.2, 8), steel);
  mast.position.y = y1 - 0.34;
  group.add(mast);

  root.add(group);
}

// ---------------------------------------------------------------------------
// Buy-Phase Energy Barrier Curtains
// ---------------------------------------------------------------------------

interface BarrierSpan {
  x0: number;
  x1: number;
  baseY: number;
  height: number;
}

/**
 * Finds the walkable openings crossing the barrier line `z = zLine`: a column
 * is open when the tiles on both sides of the line are walkable. Adjacent open
 * columns merge into one curtain span (headroom clamps under archway headers).
 */
function findBarrierSpans(grid: readonly string[], zLine: number): BarrierSpan[] {
  const rNorth = worldToRow(zLine - 0.05);
  const rSouth = worldToRow(zLine + 0.05);
  const spans: BarrierSpan[] = [];
  let current: BarrierSpan | null = null;

  for (let c = 1; c < GRID_COLS - 1; c++) {
    const chN = tileAt(grid, rNorth, c);
    const chS = tileAt(grid, rSouth, c);
    const hN = getWalkableSurfaceHeight(chN);
    const hS = getWalkableSurfaceHeight(chS);
    if (hN === null || hS === null) {
      current = null;
      continue;
    }
    const cap = chN === 'O' || chS === 'O' ? ARCH_HEADER_BOTTOM_M - 0.04 : INTERIOR_WALL_HEIGHT_M - 0.1;
    const base = Math.max(hN, hS);
    const x0 = -HALF_WIDTH_M + c * TILE_SIZE_M;
    if (current && Math.abs(current.baseY - base) < 1e-6) {
      current.x1 = x0 + TILE_SIZE_M;
      current.height = Math.min(current.height, cap - base);
    } else {
      current = { x0, x1: x0 + TILE_SIZE_M, baseY: base, height: cap - base };
      spans.push(current);
    }
  }

  if (spans.length === 0) {
    spans.push({ x0: -HALF_WIDTH_M + TILE_SIZE_M, x1: HALF_WIDTH_M - TILE_SIZE_M, baseY: 0, height: 3.2 });
  }
  return spans;
}

/**
 * Builds translucent, animated hex-grid energy curtains across every opening
 * on the South Attacker barrier (`buyMinAllyZ`, blue) and the North Defender
 * setup barrier (`buyMaxDefenderZ`, red), each framed by glowing emitter rails.
 */
function buildBuyBarriers(grid: readonly string[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'buy-phase-barriers';
  const hex = getBuyBarrierTexture();
  const uvRepeatM = 1.6;

  const defs: ReadonlyArray<{ z: number; color: number; phase: number }> = [
    { z: cachedSpawns.buyMinAllyZ, color: COLOR_BARRIER_ATTACK, phase: 0 },
    { z: cachedSpawns.buyMaxDefenderZ, color: COLOR_BARRIER_DEFEND, phase: 1.7 },
  ];

  for (const def of defs) {
    const baseOpacity = hex.map ? 0.62 : 0.3;
    const curtainMat = new THREE.MeshBasicMaterial({
      color: def.color,
      transparent: true,
      opacity: baseOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });
    if (hex.map) curtainMat.map = hex.map;
    if (hex.alphaMap) curtainMat.alphaMap = hex.alphaMap;
    const railMat = glowMat(def.color);

    for (const span of findBarrierSpans(grid, def.z)) {
      const w = span.x1 - span.x0 - 0.04;
      const h = span.height;
      const cx = (span.x0 + span.x1) * 0.5;

      const geo = new THREE.PlaneGeometry(w, h);
      const uv = geo.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, (uv.getX(i) * w) / uvRepeatM, (uv.getY(i) * h) / uvRepeatM);
      }
      uv.needsUpdate = true;

      const curtain = new THREE.Mesh(geo, curtainMat);
      curtain.position.set(cx, span.baseY + h * 0.5, def.z);
      curtain.renderOrder = 7;
      curtain.onBeforeRender = () => {
        const t = nowSeconds();
        curtainMat.opacity = baseOpacity * (0.8 + 0.2 * Math.sin(t * 2.4 + def.phase));
        if (hex.map) hex.map.offset.set((t * 0.015) % 1, (t * 0.11) % 1);
        if (hex.alphaMap && hex.map) hex.alphaMap.offset.copy(hex.map.offset);
      };
      group.add(curtain);

      // Glowing floor emitter + top rail + side posts framing the curtain.
      const x0 = span.x0 + 0.02;
      const x1 = span.x1 - 0.02;
      const y0 = span.baseY + 0.002;
      addBoxMesh(group, x0, x1, y0, y0 + 0.05, def.z - 0.07, def.z + 0.07, railMat);
      addBoxMesh(group, x0, x1, span.baseY + h - 0.05, span.baseY + h, def.z - 0.05, def.z + 0.05, railMat);
      addBoxMesh(group, x0, x0 + 0.07, y0, span.baseY + h, def.z - 0.06, def.z + 0.06, railMat);
      addBoxMesh(group, x1 - 0.07, x1, y0, span.baseY + h, def.z - 0.06, def.z + 0.06, railMat);
    }
  }
  return group;
}

/**
 * Shows / hides the translucent 3D buy-phase energy curtains (built lazily for
 * the active grid). Safe to call before `buildArenaScene`: the requested state
 * is remembered and applied when the arena is built.
 */
export function setArenaBuyBarriersVisible(visible: boolean): void {
  barriersVisible = visible;
  if (!arenaRoot) return;
  if (!barrierGroup) {
    barrierGroup = buildBuyBarriers(currentGrid);
    arenaRoot.add(barrierGroup);
  }
  barrierGroup.visible = visible;
}

/**
 * Static draw-call batching: bakes every opaque, non-animated mesh (and every
 * edge-line overlay) under `root` into world space and merges them into ONE
 * mesh per `(material, castShadow, receiveShadow)` bucket. Turns ~1000 tiny
 * box meshes into a few dozen draw calls (and the same for the shadow pass)
 * with zero visual change. Animated parts (`onBeforeRender` hooks),
 * transparent decals and sprites are left untouched.
 */
function mergeStaticMeshes(root: THREE.Group): void {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const defaultHook = THREE.Object3D.prototype.onBeforeRender;

  interface Bucket {
    mat: THREE.Material;
    geos: THREE.BufferGeometry[];
    cast: boolean;
    receive: boolean;
    lines: boolean;
  }
  const buckets = new Map<string, Bucket>();
  const consumed: THREE.Object3D[] = [];

  root.traverse((obj) => {
    if (obj.onBeforeRender !== defaultHook) return;
    const isLine = obj instanceof THREE.LineSegments;
    const isMesh = obj instanceof THREE.Mesh;
    if (!isLine && !isMesh) return;
    const mesh = obj as THREE.Mesh | THREE.LineSegments;
    if (Array.isArray(mesh.material) || mesh.material.transparent) return;
    const geo = mesh.geometry;
    if (isMesh && (!geo.index || !geo.getAttribute('normal') || !geo.getAttribute('uv'))) return;
    if (isLine && geo.index) return;

    const key = `${isLine ? 'L' : 'M'}:${mesh.material.uuid}:${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { mat: mesh.material, geos: [], cast: mesh.castShadow, receive: mesh.receiveShadow, lines: isLine };
      buckets.set(key, bucket);
    }
    const baked = (isLine ? new THREE.BufferGeometry().setAttribute('position', geo.getAttribute('position').clone()) : geo.clone());
    baked.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld));
    bucket.geos.push(baked);
    consumed.push(mesh);
  });

  // Detach consumed objects (re-homing any non-consumed children) and free their geometry.
  const consumedSet = new Set(consumed);
  for (const obj of consumed) {
    for (const child of [...obj.children]) {
      if (!consumedSet.has(child)) root.attach(child);
    }
    obj.removeFromParent();
    (obj as THREE.Mesh).geometry.dispose();
  }

  for (const bucket of buckets.values()) {
    const merged = bucket.geos.length === 1 ? bucket.geos[0] : mergeGeometries(bucket.geos, false);
    const outputs = merged ? [merged] : bucket.geos;
    for (const g of outputs) {
      const obj = bucket.lines
        ? new THREE.LineSegments(g, bucket.mat)
        : new THREE.Mesh(g, bucket.mat);
      obj.castShadow = bucket.cast;
      obj.receiveShadow = bucket.receive;
      root.add(obj);
    }
    if (merged && bucket.geos.length > 1) {
      for (const g of bucket.geos) g.dispose();
    }
  }
}

/** Applies cast/receive shadow flags to every opaque mesh under `root`. */
function applyShadowFlags(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mode = obj.userData.shadowMode as 'none' | 'receive' | undefined;
    const mat = obj.material as THREE.Material | THREE.Material[];
    const transparent = Array.isArray(mat) ? mat.some((m) => m.transparent) : mat.transparent;
    const unlit = !Array.isArray(mat) && mat instanceof THREE.MeshBasicMaterial;
    if (mode === 'none' || transparent || unlit) {
      obj.castShadow = false;
      obj.receiveShadow = false;
      return;
    }
    obj.castShadow = mode !== 'receive';
    obj.receiveShadow = true;
  });
}

/**
 * Populates `scene` with the daylight "Chroma Ascent" S&D compound built from
 * `customGrid` (or `DEFAULT_KILLHOUSE_GRID`), updating `ARENA_COLLIDERS`,
 * `getArenaWaypoints()`, `getArenaSpawns()`, `getBombSites()` and
 * `getSpikeSpawnPos()`.
 *
 * Safe to call multiple times: disposes any prior arena meshes/materials first.
 */
export function buildArenaScene(scene: THREE.Scene, customGrid?: string[]): void {
  if (arenaRoot) {
    disposeArenaRoot(arenaRoot);
    arenaRoot = null;
    barrierGroup = null;
  }

  applyGridData(customGrid ?? DEFAULT_KILLHOUSE_GRID);

  scene.background = new THREE.Color(COLOR_SKY_BG);
  // Fog starts beyond the 50m A-Long lane so long sightlines stay crystal sharp.
  scene.fog = new THREE.Fog(COLOR_SKY_BG, 82, 190);

  const root = new THREE.Group();
  root.name = 'chroma-ascent-arena-root';

  // Bright overcast skylight + warm shadow-casting sun key light so agent colors POP.
  const hemiLight = new THREE.HemisphereLight(0xeef4ff, 0x4a5568, 1.1);
  root.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xfff3e0, 1.75);
  sunLight.position.set(26, 44, 20);
  sunLight.target.position.set(0, 0, 0);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  const shadowCam = sunLight.shadow.camera;
  shadowCam.left = -46;
  shadowCam.right = 46;
  shadowCam.top = 46;
  shadowCam.bottom = -46;
  shadowCam.near = 2;
  shadowCam.far = 110;
  shadowCam.updateProjectionMatrix();
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.02;
  root.add(sunLight);
  root.add(sunLight.target);

  // Subtle cool back-fill keeps north-facing cover faces legible (no shadows).
  const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.42);
  fillLight.position.set(-18, 20, -20);
  root.add(fillLight);

  const regions = createRegionMaterials();
  buildFloorAndGrid(root, regions);
  buildSiteMarkings(root, currentGrid);
  buildArchitecturalBlocks(root, currentGrid, regions);

  if (currentGrid.some((row) => row.includes('S'))) {
    buildSpikePedestal(root, cachedSpikePos);
  }
  if (cachedGenerator) {
    buildGeneratorTower(root, cachedGenerator);
  }

  applyShadowFlags(root);
  mergeStaticMeshes(root);

  // Buy-phase curtains (unlit, never cast shadows); visibility follows the last request.
  barrierGroup = buildBuyBarriers(currentGrid);
  barrierGroup.visible = barriersVisible;
  root.add(barrierGroup);

  scene.add(root);
  arenaRoot = root;
}

/**
 * Live-rebuilds the 3D arena, greedy-meshed `ARENA_COLLIDERS`, AI waypoints,
 * team spawns, bomb sites and the Spike pedestal from a user-edited ASCII
 * grid, cleanly disposing old GPU geometries, materials, and textures without
 * disturbing combatants.
 */
export function rebuildArenaScene(scene: THREE.Scene, customGrid: string[]): void {
  buildArenaScene(scene, customGrid);
}
