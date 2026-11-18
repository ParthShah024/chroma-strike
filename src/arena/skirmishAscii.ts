/**
 * ============================================================================
 * 2D ASCII Map Format & Default 2-Site Search & Destroy Grid (`48m x 56m`)
 * ============================================================================
 *
 * HOW TO DESIGN YOUR OWN ARENA
 * ----------------------------
 * Arenas are plain 2D text grids (`string[]`). Each character is ONE square
 * `2.0m x 2.0m` (`TILE_SIZE_M`) tile:
 *
 *   - Columns (`c = 0..23`, left -> right) map to World X: `[-24m .. +24m]`
 *     `xMin = -24 + c * 2.0`,  tile center `x = -24 + (c + 0.5) * 2.0`
 *   - Rows    (`r = 0..27`, top  -> bottom) map to World Z: `[-28m .. +28m]`
 *     `zMin = -28 + r * 2.0`,  tile center `z = -28 + (r + 0.5) * 2.0`
 *
 *   Character Legend (`TileChar`):
 *   +------+-------------------------------------+--------------+---------------------------+
 *   | Char | Architectural Element               | Height       | Walkable / Sight          |
 *   +------+-------------------------------------+--------------+---------------------------+
 *   |  #   | Perimeter Wall (outer ring)         | 4.60 m       | Solid blocker             |
 *   |  #   | Interior Wall                       | 3.60 m       | Solid blocker             |
 *   |  W   | Shoot-Through Framed Window         | sill 0..1.12 | NOT walkable; bullets/LoS |
 *   |      |                                     | lintel 2.55+ | pass through 1.12..2.55 m |
 *   |  O   | Overhead Archway                    | header 2.65+ | Walkable floor (0.00 m)   |
 *   |  =   | Chest-High Head-Glitch Cover        | 1.26 m       | Blocks body, peek!        |
 *   |  D   | Double-Stacked Medium Box           | 1.72 m       | Blocks standing head      |
 *   |  B   | Tall Industrial Crate               | 2.25 m       | Full-body cover           |
 *   |  P   | Heaven / Catwalk / Overlook Deck    | 0.90 m       | Walkable highground       |
 *   |  ^   | North-Side Step-Up Stairs           | 0.45 m       | Walkable step-up          |
 *   |  v   | South-Side Step-Up Stairs           | 0.45 m       | Walkable step-up          |
 *   |  1   | Bomb Site A Plant Zone              | 0.00 m       | Walkable floor            |
 *   |  2   | Bomb Site B Plant Zone              | 0.00 m       | Walkable floor            |
 *   |  A   | Attacker Spawn Pad (South `+Z`)     | 0.00 m       | Walkable floor            |
 *   |  E   | Defender Spawn Pad (North `-Z`)     | 0.00 m       | Walkable floor            |
 *   |  .   | Open Concrete Floor                 | 0.00 m       | Walkable floor            |
 *   +------+-------------------------------------+--------------+---------------------------+
 *
 * QUICK EDITING RULES:
 * 1. Keep 28 rows (`GRID_ROWS`) and 24 characters per row (`GRID_COLS`).
 * 2. Keep the outer border ring as `#` so nobody walks out of bounds.
 * 3. Place up to 3 `A` tiles in the south rows (`+Z`) and 3 `E` tiles in the
 *    north rows (`-Z`). Missing pads fall back to open south/north tiles.
 * 4. Paint each bomb site as a contiguous cluster of `1` / `2` tiles; the
 *    site's plant zone is the bounding box of its tiles.
 * 5. Connect `P` (0.90m) decks to floor via `^` / `v` (0.45m) stairs; every
 *    traversable step must be `<= 0.50m`.
 */

/** Number of columns in every ASCII grid (`24 * 2.0m = 48m` wide). */
export const GRID_COLS = 24;

/** Number of rows in every ASCII grid (`28 * 2.0m = 56m` deep). */
export const GRID_ROWS = 28;

/** World-space side length of one ASCII tile in meters (1 Three.js unit = 1m). */
export const TILE_SIZE_M = 2.0;

/** Total world width in meters (`48m`, spanning `x: [-24, +24]`). */
export const ARENA_WIDTH_M = GRID_COLS * TILE_SIZE_M;

/** Total world depth in meters (`56m`, spanning `z: [-28, +28]`). */
export const ARENA_DEPTH_M = GRID_ROWS * TILE_SIZE_M;

/** Supported ASCII tile symbols. */
export type TileChar =
  | '#'
  | 'W'
  | 'O'
  | '='
  | 'D'
  | 'B'
  | 'P'
  | '^'
  | 'v'
  | '1'
  | '2'
  | 'A'
  | 'E'
  | '.';

/**
 * Default 2-Site Search & Destroy Layout (`48m x 56m`, `x: [-24, 24]`, `z: [-28, 28]`).
 *
 * Column bands:  c1-6 West (A) | c7 wall | c8-15 Mid | c16 wall | c17-22 East (B)
 *
 * - **A-Long (c1-2, rows 1-24)**: clean 46m sightline along column 1 from the
 *   back of A-Heaven to the spawn exit, with a recess cubby (r15-16 c3) and an
 *   ambush box (`D`, r20 c2) that never block the whole lane.
 * - **Site A (`1`, r6-8 c2-4)**: default-plant crate `B`, `D` / `=` retake
 *   angles, A-Main archway (`O`, r11 c5) from A-Link, A-Short archway (`O`,
 *   r7 c7) from Mid-Top, and **A-Heaven** (`P` 0.90m deck r2-3, `v` stairs r4,
 *   `^` CT stair r3 c6) overlooking the site from the Defender side.
 * - **Mid**: CT **Mid Window** (`WW`, r4 c11-12) staring 40m down the
 *   courtyard, **Mid Catwalk** (`P` 0.90m r14-16 c14-15, `^`/`v` stairs), Mid-Top
 *   box room, and A-Link / B-Link archways.
 * - **Lurk Connectors**: West lurk room (r19-21 c4-6) linking A-Long (r20 c3)
 *   and lower Mid (r21 c7), plus a 1-wide crawl (c5 r15-18) up into A-Link;
 *   East lurk room (r19-21 c17-18) linking lower Mid (r20 c16), B-Main
 *   (r21 c19) and a crawl (c17 r16-18) up into B-Hookah.
 * - **Site B (`2`, r6-8 c19-21)**: tighter site with `D` / `=` / `B` cover
 *   variety, **B-Window / Hookah** (`WW`, r11 c17-18) overlooking the site,
 *   B-Main archway (`OO`, r11 c20-21), and a fast CT-to-B archway (`O`, r2 c16).
 * - **Spawns**: Defender CT pads `E` (r2, z=-23) centrally placed for rotations;
 *   Attacker pads `A` (r25, z=+23) shielded from the Mid Window by `BB` (r24).
 */
export const DEFAULT_KILLHOUSE_GRID: string[] = [
  '########################', // r0  z -28..-26  North perimeter
  '#......#........#......#', // r1  z -26..-24  Heaven back / CT spawn / B back
  '#.PPPP.O.E..E.E.O......#', // r2  z -24..-22  A-Heaven deck | CT pads | CT->B archway
  '#.PPPP^#........#..DD..#', // r3  z -22..-20  Heaven + CT stair | B back boxes
  '#.v..v.#.##WW##.#.=....#', // r4  z -20..-18  Heaven stairs | CT Mid Window | CT-mid doors
  '#......#........###....#', // r5  z -18..-16  Site A top | Mid-Top | tight B neck
  '#.111B.#.=....=.#..222D#', // r6  z -16..-14  Site A / Site B plant zones
  '#.111..O........O..222.#', // r7  z -14..-12  A-Short & B-Short archways from Mid-Top
  '#.111D.#..B..B..#.=222B#', // r8  z -12..-10  Default plant cover
  '#...=..#........#.D....#', // r9  z -10.. -8  Retake angles
  '#..=...#.D....D.#......#', // r10 z  -8.. -6  Site exits / Mid-Top boxes
  '#..##O####....###WW#OO##', // r11 z  -6.. -4  A-Main arch | Mid neck | B-Window | B-Main arch
  '#..#...#........O..#...#', // r12 z  -4.. -2  A-Link | Mid | B-Link arch -> Hookah | B-Main
  '#..#.=.O......^^#.D#...#', // r13 z  -2..  0  A-Link arch | Catwalk stairs
  '#..#D..#..D...PP#..#.=.#', // r14 z   0.. +2  Mid Catwalk deck
  '#...#.##......PP#......#', // r15 z  +2.. +4  Long cubby | lurk crawl | Hookah->B-Main door
  '#..=#.##.=....PP#.##D..#', // r16 z  +4.. +6  Cubby lip | crawls
  '#..##.##......vv#.##...#', // r17 z  +6.. +8  Catwalk south stairs
  '#..##.##..=.....#.##..B#', // r18 z  +8..+10  Crawls | B-Main crate
  '#..#...#.D......#..#...#', // r19 z +10..+12  Lurk rooms
  '#.D..=.#..........=#...#', // r20 z +12..+14  Long<->West lurk | Mid<->East lurk
  '#..#.........=..#......#', // r21 z +14..+16  West lurk<->Mid | East lurk<->B-Main
  '#..#####........####...#', // r22 z +16..+18  Spawn-side lane mouths
  '#..=....=......=....=..#', // r23 z +18..+20  Attacker staging hall
  '#..........BB..........#', // r24 z +20..+22  Spawn shield vs Mid Window
  '#BB......A..A.A........#', // r25 z +22..+24  Attacker spawn pads
  '#......................#', // r26 z +24..+26  Attacker spawn back
  '########################', // r27 z +26..+28  South perimeter
];

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
 * Protects `buildArenaScene` / `rebuildArenaScene` against malformed user
 * edits or truncated / legacy-sized `localStorage` payloads.
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
