/**
 * ============================================================================
 * 2D ASCII Skirmish Map Format & Default Killhouse Grid (`28m x 34m`)
 * ============================================================================
 *
 * HOW TO DESIGN YOUR OWN ARENA IN 30 SECONDS
 * ------------------------------------------
 * This file defines tactical arenas as plain 2D text grids (`string[]`).
 * Each character represents ONE square `2.0m x 2.0m` (`TILE_SIZE_M`) tile:
 *
 *   - Columns (`c = 0..13`, left -> right) map to World X: `[-14m .. +14m]`
 *     `xMin = -14 + c * 2.0`,  tile center `x = -14 + (c + 0.5) * 2.0`
 *   - Rows    (`r = 0..16`, top  -> bottom) map to World Z: `[-17m .. +17m]`
 *     `zMin = -17 + r * 2.0`,  tile center `z = -17 + (r + 0.5) * 2.0`
 *
 *   Character Legend (`TileChar`):
 *   +------+----------------------------------+---------+--------------------+
 *   | Char | Architectural Element            | Height  | Walkable / Sight   |
 *   +------+----------------------------------+---------+--------------------+
 *   |  #   | Perimeter Warehouse Wall (edge)  |  4.20 m | Solid blocker      |
 *   |  #   | Interior Killhouse Plywood Wall  |  3.20 m | Solid blocker      |
 *   |  =   | Chest-High Head-Glitch Barrier   |  1.28 m | Blocks body, peek! |
 *   |  B   | Industrial Shipping Crate        |  2.20 m | Full-body cover    |
 *   |  P   | Watchtower Steel-Grate Deck      |  0.90 m | Walkable highground|
 *   |  ^   | North-Facing Step-Up Stairs      |  0.45 m | Walkable step-up   |
 *   |  v   | South-Facing Step-Up Stairs      |  0.45 m | Walkable step-up   |
 *   |  A   | Ally Spawn Pad (South `+Z`)      |  0.00 m | Walkable open floor|
 *   |  E   | Enemy Spawn Pad (North `-Z`)     |  0.00 m | Walkable open floor|
 *   |  .   | Open Concrete Floor              |  0.00 m | Walkable open floor|
 *   +------+----------------------------------+---------+--------------------+
 *
 * QUICK EDITING RULES:
 * 1. Keep 17 rows (`GRID_ROWS`) and 14 characters per row (`GRID_COLS`).
 * 2. Keep the outer border ring (`row 0`, `row 16`, `col 0`, `col 13`) as `#`
 *    so combatants cannot walk out of the warehouse bounds.
 * 3. Place up to 3 `A` tiles near the south rows (`+Z`) and 3 `E` tiles near
 *    the north rows (`-Z`). If omitted, `getArenaSpawns()` safely falls back
 *    to open south/north tiles automatically.
 * 4. Connect `P` (`0.90m` Watchtower) platforms to `.` floor (`0.00m`) using
 *    `^` or `v` (`0.45m` stairs) so both players and AI bots can climb smoothly
 *    (each step is `0.45m <= 0.50m` max step height).
 * 5. Prefer editing live in-game with `[M]` Map Maker and clicking
 *    "Copy TypeScript Code" to paste your layout straight back here!
 */

/** Number of columns in every skirmish ASCII grid (`14 * 2.0m = 28m` wide). */
export const GRID_COLS = 14;

/** Number of rows in every skirmish ASCII grid (`17 * 2.0m = 34m` deep). */
export const GRID_ROWS = 17;

/** World-space side length of one ASCII tile in meters (1 Three.js unit = 1m). */
export const TILE_SIZE_M = 2.0;

/** Total world width in meters (`28m`, spanning `x: [-14, +14]`). */
export const ARENA_WIDTH_M = GRID_COLS * TILE_SIZE_M;

/** Total world depth in meters (`34m`, spanning `z: [-17, +17]`). */
export const ARENA_DEPTH_M = GRID_ROWS * TILE_SIZE_M;

/** Supported ASCII tile symbols in a Killhouse skirmish map. */
export type TileChar = '#' | '=' | 'B' | 'P' | '^' | 'v' | 'A' | 'E' | '.';

/**
 * Default 3v3 Killhouse Skirmish Layout (`28m x 34m`, `x: [-14, 14]`, `z: [-17, 17]`).
 *
 * Tactical design highlights:
 * - **Fast 2-second engagements**: Compact CoD Killhouse / Valorant Skirmish
 *   scale keeps round pacing electric while preserving clean 3-lane angles.
 * - **Symmetric rotation, asymmetric cover**: Both teams get spawn cover (`###`),
 *   a `1.28m` head-glitch peek (`==`), and a side CQB plywood wing (`#`).
 * - **Central Watchtower (`PP` + `^^`/`vv`)**: Climbing the `0.45m` stairs onto
 *   the `0.90m` steel deck gives a rewarding elevation angle over `1.28m` cover
 *   at the cost of exposed flanks.
 */
export const DEFAULT_KILLHOUSE_GRID: string[] = [
  '##############', // row 0  (z: -17..-15, North Perimeter Wall)
  '#..E..E..E...#', // row 1  (z: -15..-13, Enemy North Spawns)
  '#..###..==...#', // row 2  (z: -13..-11, Spawn cover wall + head-glitch `=`)
  '#.....B....B.#', // row 3  (z: -11.. -9, Shipping crates)
  '#.==....#....#', // row 4  (z:  -9.. -7, West head-glitch + Mid-East pillar)
  '#...#........#', // row 5  (z:  -7.. -5, West CQB plywood wing)
  '#...#..^^..B.#', // row 6  (z:  -5.. -3, `^^` = 0.45m stairs onto Mid Watchtower)
  '#.B....PP....#', // row 7  (z:  -3.. -1, `PP` = 0.90m Center Watchtower Deck)
  '#......PP..=.#', // row 8  (z:  -1.. +1, Center Watchtower + East low cover)
  '#.=....PP....#', // row 9  (z:  +1.. +3, West low cover + Center Watchtower)
  '#.B....vv..#.#', // row 10 (z:  +3.. +5, `vv` = 0.45m South stairs onto Watchtower)
  '#........#...#', // row 11 (z:  +5.. +7, East CQB plywood wing)
  '#....#....==.#', // row 12 (z:  +7.. +9, Mid-West pillar + East head-glitch)
  '#.B....B.....#', // row 13 (z:  +9..+11, Shipping crates)
  '#...==..###..#', // row 14 (z: +11..+13, Ally spawn cover wall + head-glitch `=`)
  '#...A..A..A..#', // row 15 (z: +13..+15, Ally South Spawns)
  '##############', // row 16 (z: +15..+17, South Perimeter Wall)
];

const VALID_TILES = new Set<string>(['#', '=', 'B', 'P', '^', 'v', 'A', 'E', '.']);

/**
 * Type guard checking whether a single character is a valid `TileChar`.
 */
export function isTileChar(ch: string): ch is TileChar {
  return VALID_TILES.has(ch);
}

/**
 * Sanitizes an arbitrary `string[]` into an exact `GRID_ROWS x GRID_COLS`
 * array of valid `TileChar` strings with a sealed `#` outer perimeter.
 *
 * This protects `buildArenaScene` / `rebuildArenaScene` against malformed user
 * edits or truncated `localStorage` payloads so bots and players never fall out
 * of the world.
 */
export function normalizeAsciiGrid(rawGrid?: readonly string[]): string[] {
  const source = rawGrid && rawGrid.length > 0 ? rawGrid : DEFAULT_KILLHOUSE_GRID;
  const rows: string[] = [];

  for (let r = 0; r < GRID_ROWS; r++) {
    const rawRow = source[r] ?? '';
    let cleanRow = '';

    for (let c = 0; c < GRID_COLS; c++) {
      const isBorder = r === 0 || r === GRID_ROWS - 1 || c === 0 || c === GRID_COLS - 1;
      if (isBorder) {
        cleanRow += '#';
        continue;
      }

      const ch = rawRow[c] ?? '.';
      cleanRow += isTileChar(ch) ? ch : '.';
    }

    rows.push(cleanRow);
  }

  return rows;
}
