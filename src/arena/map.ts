import * as THREE from 'three';
import type { AABB, Vec3 } from '../core/types';
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

/**
 * ============================================================================
 * Killhouse Skirmish Arena Builder:
 * 2D Greedy Meshing, Single-Source-of-Truth Colliders & Auto-Waypoint Graph
 * ============================================================================
 *
 * 1. **Single Source of Truth (`ARENA_COLLIDERS`)**:
 *    Every solid piece of geometry in the 28m x 34m Killhouse is generated from
 *    the same `string[]` ASCII grid (`skirmishAscii.ts`) and pushed into the
 *    live `ARENA_COLLIDERS` array. Both physics (`movement.ts`), hitscan bullets
 *    (`weapons.ts`), AI line-of-sight (`botBrain.ts`), and 3D Three.js meshes
 *    read from these exact AABBs — guaranteeing zero physics/visual desync.
 *
 *    IMPORTANT: `ARENA_COLLIDERS` is exported as a `const` array reference and
 *    is ALWAYS mutated in-place (`ARENA_COLLIDERS.length = 0; ARENA_COLLIDERS.push(...)`)
 *    on build/rebuild so every module holding an import binding sees updates
 *    immediately after `[M]` Map Maker live edits.
 *
 * 2. **How 2D Greedy Meshing Works**:
 *    A 14 x 17 grid has 238 tiles. Creating one AABB per solid tile would emit
 *    ~80+ tiny boxes, forcing physics sweeps and raycasts to test dozens of
 *    redundant faces (and potentially snag players on micro-seams between flush
 *    adjacent tiles!).
 *
 *    **2D Greedy Meshing** solves both problems in O(rows * cols) time:
 *      Step A: Classify each `(r, c)` cell into a `MergeKind` (cells with
 *              identical height, tag, and architectural role) or `null` for
 *              open walkable floor.
 *      Step B: Scan left-to-right, top-to-bottom. At the first unvisited solid
 *              cell `(r, c)`, expand width `w` rightwards as far as contiguous
 *              unvisited cells share the same `MergeKind`.
 *      Step C: Expand height `h` downwards row-by-row as long as EVERY cell in
 *              the horizontal span `[c .. c + w - 1]` is unvisited and matches
 *              `MergeKind`.
 *      Step D: Mark the `w x h` rectangle visited and emit ONE combined `AABB`!
 *
 *    Result on `DEFAULT_KILLHOUSE_GRID`: ~85 raw solid tiles compress into ~25
 *    seamless AABB colliders — cutting raycast/physics cost by >3x and
 *    eliminating tile-seam snags along walls and the 2x3 Watchtower deck!
 *
 * 3. **How Auto-Waypoint Extraction Works (`getArenaWaypoints`)**:
 *    Hand-coded waypoint arrays break the moment a player edits a wall in the
 *    `[M]` Map Maker. Instead, we generate the AI navigation graph directly from
 *    the ASCII grid:
 *      - Every walkable tile (`.`, `A`, `E`, `^`, `v`, `P`) becomes a node at
 *        its world-space center `(x, surfaceY, z)`.
 *      - **4-directional edges** connect adjacent walkable tiles iff the step
 *        height difference `|heightA - heightB| <= 0.50m`. This lets bots climb
 *        from floor (`0.00m`) -> stairs (`0.45m`) -> Watchtower (`0.90m`),
 *        while forbidding impossible `0.90m` vertical cliff jumps!
 *      - **Diagonal edges** are added ONLY when the target AND BOTH shared
 *        orthogonal corner tiles are walkable within the `0.50m` step limit,
 *        preventing bots from clipping their `0.4m` body radius into corners.
 */

// ---------------------------------------------------------------------------
// Public Contracts & Live Arena State
// ---------------------------------------------------------------------------

/** Default South (`+Z`) player spawn inside the Killhouse Ally zone. */
export const PLAYER_SPAWN: Vec3 = { x: 0, y: 0.1, z: 14.0 };

/**
 * Live static AABBs used by player/bot movement, bullet raycasts, and LoS.
 * Mutated strictly in-place so existing module references remain valid across
 * `rebuildArenaScene` calls.
 */
export const ARENA_COLLIDERS: AABB[] = [];

/** Walkable navigation node automatically extracted from the active ASCII grid. */
export interface ArenaWaypoint {
  id: string;
  pos: Vec3;
  neighbors: string[];
}

/** Team spawn positions and Ally buy-phase forward boundary (`+Z` side). */
export interface ArenaSpawns {
  allies: [Vec3, Vec3, Vec3];
  enemies: [Vec3, Vec3, Vec3];
  buyMinAllyZ: number;
}

const HALF_WIDTH_M = ARENA_WIDTH_M * 0.5;   // 14m -> x in [-14, +14]
const HALF_DEPTH_M = ARENA_DEPTH_M * 0.5;   // 17m -> z in [-17, +17]
const BUY_MIN_ALLY_Z = 11.2;
const MAX_STEP_HEIGHT_M = 0.50;

// ---------------------------------------------------------------------------
// Architectural Material Palette (Neutral Daylight Killhouse)
// ---------------------------------------------------------------------------
// Kept deliberately warm/neutral so Red (#ff3b5c), Blue (#00d2ff), and
// Green (#2ecc71) agent silhouettes pop at a glance in every lane.

const COLOR_SKY_BG = 0xcfdbe8;
const COLOR_FLOOR = 0x767f8c;
const COLOR_FLOOR_GRID = 0x56606e;
const COLOR_PERIMETER_WALL = 0x475161;
const COLOR_PERIMETER_TRIM = 0x2c3440;
const COLOR_RAFTER_STEEL = 0x343d4b;
const COLOR_PLYWOOD_WALL = 0xa68966;
const COLOR_STEEL_FRAME = 0x38414f;
const COLOR_HEADGLITCH = 0x8c7355;
const COLOR_CAPRAIL = 0x3b4350;
const COLOR_CRATE = 0x525d6b;
const COLOR_CRATE_TRIM = 0x39424f;
const COLOR_WATCHTOWER = 0x5c6675;
const COLOR_STAIR = 0x6e7887;
const COLOR_BOLLARD = 0xd99b26;

type MergeKind =
  | 'perimeter'
  | 'wall_interior'
  | 'low_cover'
  | 'crate'
  | 'platform'
  | 'stair';

interface TileVisualSpec {
  height: number;
  tag: 'wall' | 'cover';
  color: number;
}

const MERGE_SPECS: Record<MergeKind, TileVisualSpec> = {
  perimeter: { height: 4.2, tag: 'wall', color: COLOR_PERIMETER_WALL },
  wall_interior: { height: 3.2, tag: 'wall', color: COLOR_PLYWOOD_WALL },
  low_cover: { height: 1.28, tag: 'cover', color: COLOR_HEADGLITCH },
  crate: { height: 2.2, tag: 'cover', color: COLOR_CRATE },
  platform: { height: 0.9, tag: 'cover', color: COLOR_WATCHTOWER },
  stair: { height: 0.45, tag: 'cover', color: COLOR_STAIR },
};

interface MergedBlock {
  kind: MergeKind;
  box: AABB;
  row: number;
  col: number;
  rowsSpan: number;
  colsSpan: number;
}

// Module-level cached arena state updated atomically by `applyGridData`.
let currentGrid: string[] = [];
let cachedMergedBlocks: MergedBlock[] = [];
let cachedWaypoints: ArenaWaypoint[] = [];
let cachedSpawns: ArenaSpawns = {
  allies: [
    { x: -4, y: 0.1, z: 14 },
    { x: 0, y: 0.1, z: 14 },
    { x: 4, y: 0.1, z: 14 },
  ],
  enemies: [
    { x: -4, y: 0.1, z: -14 },
    { x: 0, y: 0.1, z: -14 },
    { x: 4, y: 0.1, z: -14 },
  ],
  buyMinAllyZ: BUY_MIN_ALLY_Z,
};

/** Single root group holding all arena Three.js meshes/lights for clean disposal. */
let arenaRoot: THREE.Group | null = null;

// ---------------------------------------------------------------------------
// Coordinate & Tile Classification Helpers
// ---------------------------------------------------------------------------

function tileCenterX(col: number): number {
  return -HALF_WIDTH_M + (col + 0.5) * TILE_SIZE_M;
}

function tileCenterZ(row: number): number {
  return -HALF_DEPTH_M + (row + 0.5) * TILE_SIZE_M;
}

function isPerimeterCell(row: number, col: number): boolean {
  return row === 0 || row === GRID_ROWS - 1 || col === 0 || col === GRID_COLS - 1;
}

function classifyTileForMesh(ch: TileChar, row: number, col: number): MergeKind | null {
  switch (ch) {
    case '#':
      return isPerimeterCell(row, col) ? 'perimeter' : 'wall_interior';
    case '=':
      return 'low_cover';
    case 'B':
      return 'crate';
    case 'P':
      return 'platform';
    case '^':
    case 'v':
      return 'stair';
    case '.':
    case 'A':
    case 'E':
      return null;
  }
}

function getWalkableSurfaceHeight(ch: TileChar): number | null {
  switch (ch) {
    case '.':
    case 'A':
    case 'E':
      return 0;
    case '^':
    case 'v':
      return 0.45;
    case 'P':
      return 0.9;
    default:
      return null;
  }
}

function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
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
          if (
            visited[r + rowsSpan][c + dc] ||
            kindGrid[r + rowsSpan][c + dc] !== targetKind
          ) {
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

      // 4. Emit one combined world-space AABB for the entire w x h block.
      const spec = MERGE_SPECS[targetKind];
      const minX = -HALF_WIDTH_M + c * TILE_SIZE_M;
      const maxX = -HALF_WIDTH_M + (c + colsSpan) * TILE_SIZE_M;
      const minZ = -HALF_DEPTH_M + r * TILE_SIZE_M;
      const maxZ = -HALF_DEPTH_M + (r + rowsSpan) * TILE_SIZE_M;

      blocks.push({
        kind: targetKind,
        row: r,
        col: c,
        rowsSpan,
        colsSpan,
        box: {
          min: { x: minX, y: 0, z: minZ },
          max: { x: maxX, y: spec.height, z: maxZ },
          tag: spec.tag,
          color: spec.color,
        },
      });
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Auto-Waypoint Graph Extraction
// ---------------------------------------------------------------------------

function extractWaypoints(grid: readonly string[]): ArenaWaypoint[] {
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

      waypoints.push({
        id: idSelf,
        pos: {
          x: tileCenterX(c),
          y: hSelf,
          z: tileCenterZ(r),
        },
        neighbors,
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
  let bestDistSq = Infinity;

  for (const r of searchRowOrder) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      const key = `${r},${c}`;
      if (usedKeys.has(key)) continue;

      const surfaceY = getWalkableSurfaceHeight(grid[r][c] as TileChar);
      if (surfaceY === null) continue;

      const wx = tileCenterX(c);
      const wz = tileCenterZ(r);
      const distSq = (wx - preferredX) ** 2 + (wz - preferredZ) ** 2;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestPos = { x: wx, y: surfaceY + 0.1, z: wz };
      }
    }
    if (bestPos !== null) {
      // Mark the tile chosen so 2 bots never stack on the exact same fallback tile.
      const col = Math.round((bestPos.x + HALF_WIDTH_M) / TILE_SIZE_M - 0.5);
      usedKeys.add(`${r},${col}`);
      return bestPos;
    }
  }

  return { x: preferredX, y: 0.1, z: preferredZ };
}

function isWorldCoordWalkable(grid: readonly string[], x: number, z: number): number | null {
  const c = Math.floor((x + HALF_WIDTH_M) / TILE_SIZE_M);
  const r = Math.floor((z + HALF_DEPTH_M) / TILE_SIZE_M);
  if (r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLS) return null;
  return getWalkableSurfaceHeight(grid[r][c] as TileChar);
}

function extractSpawns(grid: readonly string[]): ArenaSpawns {
  const allyTiles: Array<{ pos: Vec3; key: string }> = [];
  const enemyTiles: Array<{ pos: Vec3; key: string }> = [];

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const ch = grid[r][c] as TileChar;
      if (ch === 'A') {
        allyTiles.push({
          key: `${r},${c}`,
          pos: { x: tileCenterX(c), y: 0.1, z: tileCenterZ(r) },
        });
      } else if (ch === 'E') {
        enemyTiles.push({
          key: `${r},${c}`,
          pos: { x: tileCenterX(c), y: 0.1, z: tileCenterZ(r) },
        });
      }
    }
  }

  const usedAllyKeys = new Set<string>(allyTiles.slice(0, 3).map((t) => t.key));
  const usedEnemyKeys = new Set<string>(enemyTiles.slice(0, 3).map((t) => t.key));

  const southRows: number[] = [];
  for (let r = GRID_ROWS - 2; r >= 1; r--) southRows.push(r);
  const northRows: number[] = [];
  for (let r = 1; r <= GRID_ROWS - 2; r++) northRows.push(r);

  const allyFallbackTargets: ReadonlyArray<[number, number]> = [
    [-4, 14],
    [0, 14],
    [4, 14],
  ];
  const enemyFallbackTargets: ReadonlyArray<[number, number]> = [
    [-4, -14],
    [0, -14],
    [4, -14],
  ];

  const resolveTeamSpawns = (
    explicit: Array<{ pos: Vec3; key: string }>,
    fallbacks: ReadonlyArray<[number, number]>,
    rowOrder: readonly number[],
    usedKeys: Set<string>
  ): [Vec3, Vec3, Vec3] => {
    const out: Vec3[] = explicit.slice(0, 3).map((t) => t.pos);
    for (let i = out.length; i < 3; i++) {
      const [fx, fz] = fallbacks[i];
      const directSurface = isWorldCoordWalkable(grid, fx, fz);
      const fc = Math.floor((fx + HALF_WIDTH_M) / TILE_SIZE_M);
      const fr = Math.floor((fz + HALF_DEPTH_M) / TILE_SIZE_M);
      const fKey = `${fr},${fc}`;

      if (directSurface !== null && !usedKeys.has(fKey)) {
        usedKeys.add(fKey);
        out.push({ x: fx, y: directSurface + 0.1, z: fz });
      } else {
        out.push(findClosestWalkableSpawn(grid, fx, fz, rowOrder, usedKeys));
      }
    }
    return [out[0], out[1], out[2]];
  };

  return {
    allies: resolveTeamSpawns(allyTiles, allyFallbackTargets, southRows, usedAllyKeys),
    enemies: resolveTeamSpawns(enemyTiles, enemyFallbackTargets, northRows, usedEnemyKeys),
    buyMinAllyZ: BUY_MIN_ALLY_Z,
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
    ARENA_COLLIDERS.push(block.box);
  }

  cachedWaypoints = extractWaypoints(normalized);
  cachedSpawns = extractSpawns(normalized);
}

// Seed default Killhouse colliders/waypoints/spawns immediately at module import.
applyGridData(DEFAULT_KILLHOUSE_GRID);

// ---------------------------------------------------------------------------
// Public Accessors
// ---------------------------------------------------------------------------

/**
 * Returns a copy of the currently active `14 x 17` ASCII grid rows.
 */
export function getCurrentGrid(): string[] {
  return [...currentGrid];
}

/**
 * Returns the auto-generated AI navigation waypoint graph for the active map.
 */
export function getArenaWaypoints(): ArenaWaypoint[] {
  return cachedWaypoints.map((wp) => ({
    id: wp.id,
    pos: cloneVec3(wp.pos),
    neighbors: [...wp.neighbors],
  }));
}

/**
 * Returns extracted Ally/Enemy spawn pads (with safe fallbacks) and buy-zone Z.
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
  };
}

// ---------------------------------------------------------------------------
// 3D Scene Disposal & Architectural Killhouse Construction
// ---------------------------------------------------------------------------

function disposeArenaRoot(root: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
      geometries.add(obj.geometry);
      if (Array.isArray(obj.material)) {
        for (const mat of obj.material) materials.add(mat);
      } else if (obj.material) {
        materials.add(obj.material);
      }
    }
  });

  for (const geo of geometries) geo.dispose();
  for (const mat of materials) mat.dispose();
  root.removeFromParent();
}

function addBoxMesh(
  parent: THREE.Group,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
  material: THREE.Material,
  edgeMaterial?: THREE.LineBasicMaterial
): THREE.Mesh {
  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;
  const geo = new THREE.BoxGeometry(sizeX, sizeY, sizeZ);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(
    (minX + maxX) * 0.5,
    (minY + maxY) * 0.5,
    (minZ + maxZ) * 0.5
  );
  parent.add(mesh);

  if (edgeMaterial) {
    const edges = new THREE.EdgesGeometry(geo);
    mesh.add(new THREE.LineSegments(edges, edgeMaterial));
  }
  return mesh;
}

function buildFloorAndGrid(root: THREE.Group): void {
  // Polygon offset pushes solid floor depth back slightly so grid/overlay lines never Z-fight.
  const floorMat = new THREE.MeshStandardMaterial({
    color: COLOR_FLOOR,
    roughness: 0.92,
    metalness: 0.04,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  addBoxMesh(root, -HALF_WIDTH_M, HALF_WIDTH_M, -0.5, 0, -HALF_DEPTH_M, HALF_DEPTH_M, floorMat);

  // Exact 28m x 34m 2m tactical grid lines clipped cleanly to arena bounds.
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
    opacity: 0.42,
    depthWrite: false,
  });
  root.add(new THREE.LineSegments(gridGeo, gridMat));

  // Subtle buy-phase boundary lines so Ally/Enemy spawn zones read instantly.
  const addZoneLine = (zPos: number, hex: number, opacity: number) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-12, 0.010, zPos, 12, 0.010, zPos], 3)
    );
    const mat = new THREE.LineBasicMaterial({
      color: hex,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    root.add(new THREE.LineSegments(geo, mat));
  };

  addZoneLine(BUY_MIN_ALLY_Z, 0x3b82f6, 0.48);
  addZoneLine(-BUY_MIN_ALLY_Z, 0xef4444, 0.36);
}

function buildWarehouseRafters(root: THREE.Group): void {
  const rafterMat = new THREE.MeshStandardMaterial({
    color: COLOR_RAFTER_STEEL,
    roughness: 0.55,
    metalness: 0.45,
  });

  // Overhead steel trusses spanning across X at y = 4.24..4.46m
  for (const zPos of [-12, -6, 0, 6, 12]) {
    addBoxMesh(root, -HALF_WIDTH_M, HALF_WIDTH_M, 4.24, 4.46, zPos - 0.14, zPos + 0.14, rafterMat);
  }
  // Longitudinal purlins tying the roof trusses together cleanly above trusses (no coplanar Y or Z ends)
  for (const xPos of [-7, 7]) {
    addBoxMesh(
      root,
      xPos - 0.1,
      xPos + 0.1,
      4.465,
      4.605,
      -HALF_DEPTH_M + 0.02,
      HALF_DEPTH_M - 0.02,
      rafterMat
    );
  }
}

function buildArchitecturalBlocks(root: THREE.Group, grid: readonly string[]): void {
  // Polygon offset keeps all solid block faces slightly behind EdgesGeometry lines to prevent stipple-flicker.
  const mats: Record<MergeKind, THREE.MeshStandardMaterial> = {
    perimeter: new THREE.MeshStandardMaterial({
      color: COLOR_PERIMETER_WALL,
      roughness: 0.88,
      metalness: 0.08,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
    wall_interior: new THREE.MeshStandardMaterial({
      color: COLOR_PLYWOOD_WALL,
      roughness: 0.86,
      metalness: 0.04,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
    low_cover: new THREE.MeshStandardMaterial({
      color: COLOR_HEADGLITCH,
      roughness: 0.82,
      metalness: 0.06,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
    crate: new THREE.MeshStandardMaterial({
      color: COLOR_CRATE,
      roughness: 0.72,
      metalness: 0.22,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
    platform: new THREE.MeshStandardMaterial({
      color: COLOR_WATCHTOWER,
      roughness: 0.54,
      metalness: 0.38,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
    stair: new THREE.MeshStandardMaterial({
      color: COLOR_STAIR,
      roughness: 0.68,
      metalness: 0.24,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  };

  const trimMat = new THREE.MeshStandardMaterial({
    color: COLOR_PERIMETER_TRIM,
    roughness: 0.75,
    metalness: 0.25,
  });
  const frameSteelMat = new THREE.MeshStandardMaterial({
    color: COLOR_STEEL_FRAME,
    roughness: 0.55,
    metalness: 0.42,
  });
  const caprailMat = new THREE.MeshStandardMaterial({
    color: COLOR_CAPRAIL,
    roughness: 0.65,
    metalness: 0.3,
  });
  const crateTrimMat = new THREE.MeshStandardMaterial({
    color: COLOR_CRATE_TRIM,
    roughness: 0.62,
    metalness: 0.35,
  });
  const bollardMat = new THREE.MeshStandardMaterial({
    color: COLOR_BOLLARD,
    roughness: 0.45,
    metalness: 0.2,
  });

  const edgeMat = new THREE.LineBasicMaterial({
    color: 0x2a323d,
    transparent: true,
    opacity: 0.38,
  });

  // Trim/post extrusion reliefs eliminate coplanar Z-fighting with base wall/cover meshes.
  const trimProud = 0.008;
  const postProud = 0.012;

  for (const block of cachedMergedBlocks) {
    const { box, kind } = block;
    const { min, max } = box;

    if (kind === 'perimeter') {
      // Base concrete warehouse wall (0..4.2m) + proud dark baseboard/top trims overlapping by 0.004m
      addBoxMesh(root, min.x, max.x, 0.22, 4.10, min.z, max.z, mats.perimeter, edgeMat);
      addBoxMesh(root, min.x - trimProud, max.x + trimProud, 0, 0.224, min.z - trimProud, max.z + trimProud, trimMat);
      addBoxMesh(root, min.x - trimProud, max.x + trimProud, 4.096, 4.20, min.z - trimProud, max.z + trimProud, trimMat);
    } else if (kind === 'wall_interior') {
      // Plywood/OSB Killhouse partition with proud top steel channel & proud vertical steel posts
      addBoxMesh(root, min.x, max.x, 0, 3.10, min.z, max.z, mats.wall_interior, edgeMat);
      addBoxMesh(root, min.x - trimProud, max.x + trimProud, 3.096, 3.20, min.z - trimProud, max.z + trimProud, frameSteelMat);

      const postW = 0.11;
      const postMinY = 0.004;
      const postMaxY = 3.096;
      for (let dc = 0; dc <= block.colsSpan; dc++) {
        const px = Math.min(
          Math.max(min.x + dc * TILE_SIZE_M, min.x + postW * 0.5 + postProud),
          max.x - postW * 0.5 - postProud
        );
        addBoxMesh(
          root,
          px - postW * 0.5,
          px + postW * 0.5,
          postMinY,
          postMaxY,
          min.z - postProud,
          max.z + postProud,
          frameSteelMat
        );
      }
      if (block.rowsSpan > 1) {
        for (let dr = 0; dr <= block.rowsSpan; dr++) {
          const pz = Math.min(
            Math.max(min.z + dr * TILE_SIZE_M, min.z + postW * 0.5 + postProud),
            max.z - postW * 0.5 - postProud
          );
          addBoxMesh(
            root,
            min.x - postProud,
            max.x + postProud,
            postMinY,
            postMaxY,
            pz - postW * 0.5,
            pz + postW * 0.5,
            frameSteelMat
          );
        }
      }
    } else if (kind === 'low_cover') {
      // Head-glitch barrier (1.28m) with proud dark top caprail (1.186..1.28m)
      addBoxMesh(root, min.x, max.x, 0, 1.19, min.z, max.z, mats.low_cover, edgeMat);
      addBoxMesh(root, min.x - trimProud, max.x + trimProud, 1.186, 1.28, min.z - trimProud, max.z + trimProud, caprailMat);
    } else if (kind === 'crate') {
      // Shipping crate (2.2m) with proud dark steel base/top frame bands
      addBoxMesh(root, min.x, max.x, 0.14, 2.06, min.z, max.z, mats.crate, edgeMat);
      addBoxMesh(root, min.x - trimProud, max.x + trimProud, 0, 0.144, min.z - trimProud, max.z + trimProud, crateTrimMat);
      addBoxMesh(root, min.x - trimProud, max.x + trimProud, 2.056, 2.20, min.z - trimProud, max.z + trimProud, crateTrimMat);
    } else if (kind === 'platform') {
      // Watchtower steel-grate deck (0.90m) + slightly inset dark skirt (no coplanar join) + corner bollards
      addBoxMesh(root, min.x + trimProud, max.x - trimProud, 0, 0.784, min.z + trimProud, max.z - trimProud, frameSteelMat);
      addBoxMesh(root, min.x, max.x, 0.78, 0.90, min.z, max.z, mats.platform, edgeMat);

      const inset = 0.16;
      const bHalf = 0.055;
      const corners: ReadonlyArray<[number, number]> = [
        [min.x + inset, min.z + inset],
        [max.x - inset, min.z + inset],
        [min.x + inset, max.z - inset],
        [max.x - inset, max.z - inset],
      ];
      for (const [bx, bz] of corners) {
        addBoxMesh(root, bx - bHalf, bx + bHalf, 0.90, 1.08, bz - bHalf, bz + bHalf, bollardMat);
      }
    } else if (kind === 'stair') {
      // 0.45m step-up platform
      addBoxMesh(root, min.x, max.x, 0, 0.45, min.z, max.z, mats.stair, edgeMat);
    }
  }

  // Per-tile anti-slip tread bars on `^` and `v` stairs so step direction is obvious
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const ch = grid[r][c] as TileChar;
      if (ch !== '^' && ch !== 'v') continue;

      const x0 = -HALF_WIDTH_M + c * TILE_SIZE_M + 0.14;
      const x1 = -HALF_WIDTH_M + (c + 1) * TILE_SIZE_M - 0.14;
      const zTileMin = -HALF_DEPTH_M + r * TILE_SIZE_M;

      // 3 crisp anti-slip grip cleats along Z, raised proud (0.448..0.462) above the 0.45m step top face
      const offsets = ch === '^' ? [0.35, 0.95, 1.55] : [0.45, 1.05, 1.65];
      for (const off of offsets) {
        addBoxMesh(
          root,
          x0,
          x1,
          0.448,
          0.462,
          zTileMin + off - 0.06,
          zTileMin + off + 0.06,
          caprailMat
        );
      }
    }
  }
}

/**
 * Populates `scene` with the daylight Killhouse Warehouse arena built from
 * `customGrid` (or `DEFAULT_KILLHOUSE_GRID`), updating `ARENA_COLLIDERS`,
 * `getArenaWaypoints()`, and `getArenaSpawns()`.
 *
 * Safe to call multiple times: disposes any prior arena meshes/materials first.
 */
export function buildArenaScene(scene: THREE.Scene, customGrid?: string[]): void {
  if (arenaRoot) {
    disposeArenaRoot(arenaRoot);
    arenaRoot = null;
  }

  applyGridData(customGrid ?? DEFAULT_KILLHOUSE_GRID);

  scene.background = new THREE.Color(COLOR_SKY_BG);
  scene.fog = new THREE.Fog(COLOR_SKY_BG, 34, 86);

  const root = new THREE.Group();
  root.name = 'killhouse-arena-root';

  // Bright overcast skylight + warm sun key light so Red/Blue/Green characters POP
  const hemiLight = new THREE.HemisphereLight(0xeef4ff, 0x4a5568, 1.15);
  root.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xfff6e8, 1.55);
  sunLight.position.set(14, 24, 16);
  root.add(sunLight);

  // Subtle cool back-fill keeps north-facing cover faces legible
  const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.45);
  fillLight.position.set(-12, 16, -14);
  root.add(fillLight);

  buildFloorAndGrid(root);
  buildArchitecturalBlocks(root, currentGrid);
  buildWarehouseRafters(root);

  scene.add(root);
  arenaRoot = root;
}

/**
 * Live-rebuilds the 3D arena, greedy-meshed `ARENA_COLLIDERS`, AI waypoints,
 * and team spawns from a user-edited ASCII grid, cleanly disposing old GPU
 * geometries and materials without disturbing combatants or HUD state.
 */
export function rebuildArenaScene(scene: THREE.Scene, customGrid: string[]): void {
  buildArenaScene(scene, customGrid);
}
