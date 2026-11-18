/**
 * ============================================================================
 * 2D ASCII Map Format & Default "Chroma Ascent" Search & Destroy Grid (`72m x 80m`)
 * ============================================================================
 *
 * HOW TO DESIGN YOUR OWN ARENA
 * ----------------------------
 * Arenas are plain 2D text grids (`string[]`). Each character is ONE square
 * `2.0m x 2.0m` (`TILE_SIZE_M`) tile:
 *
 *   - Columns (`c = 0..35`, left -> right) map to World X: `[-36m .. +36m]`
 *     `xMin = -36 + c * 2.0`,  tile center `x = -36 + (c + 0.5) * 2.0`
 *   - Rows    (`r = 0..39`, top  -> bottom) map to World Z: `[-40m .. +40m]`
 *     `zMin = -40 + r * 2.0`,  tile center `z = -40 + (r + 0.5) * 2.0`
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
 *   |  D   | Double-Stacked Olive Cargo Box      | 1.72 m       | Blocks standing head      |
 *   |  B   | Tall Radianite Crate                | 2.25 m       | Full-body cover           |
 *   |  P   | Heaven / Catwalk / Overlook Deck    | 0.90 m       | Walkable highground       |
 *   |  ^   | North-Side Step-Up Stairs           | 0.45 m       | Walkable step-up          |
 *   |  v   | South-Side Step-Up Stairs           | 0.45 m       | Walkable step-up          |
 *   |  1   | Bomb Site A Plant Zone              | 0.00 m       | Walkable floor            |
 *   |  2   | Bomb Site B Plant Zone              | 0.00 m       | Walkable floor            |
 *   |  S   | Spike Spawn Pedestal (ONE tile)     | 0.00 m       | Walkable floor            |
 *   |  A   | Attacker Spawn Pad (South `+Z`)     | 0.00 m       | Walkable floor            |
 *   |  E   | Defender Spawn Pad (North `-Z`)     | 0.00 m       | Walkable floor            |
 *   |  .   | Open Concrete Floor                 | 0.00 m       | Walkable floor            |
 *   +------+-------------------------------------+--------------+---------------------------+
 *
 * QUICK EDITING RULES:
 * 1. Keep 40 rows (`GRID_ROWS`) and 36 characters per row (`GRID_COLS`).
 * 2. Keep the outer border ring as `#` so nobody walks out of bounds.
 * 3. Place up to 3 `A` tiles in the south rows (`+Z`) and 3 `E` tiles in the
 *    north rows (`-Z`). Missing pads fall back to open south/north tiles.
 * 4. Place exactly ONE `S` tile in Attacker spawn: the round's single physical
 *    Spike rests on its glowing Radianite pedestal until someone picks it up.
 * 5. Paint each bomb site as a contiguous cluster of `1` / `2` tiles; the
 *    site's plant zone is the bounding box of its tiles.
 * 6. Connect `P` (0.90m) decks to floor via `^` / `v` (0.45m) stairs; every
 *    traversable step must be `<= 0.50m`.
 * 7. Buy-phase barriers sit at `z = +18` (Attackers stay south of it) and
 *    `z = -14` (Defenders stay north of it). Every opening that crosses the
 *    `z = +18` line (row 28 / 29 seam) must turn 90 degrees immediately
 *    (a lateral dog-leg corridor capped by a solid wall), so NO opening-round
 *    sightline ever connects the two buy zones.
 */

/** Number of columns in every ASCII grid (`36 * 2.0m = 72m` wide). */
export const GRID_COLS = 36;

/** Number of rows in every ASCII grid (`40 * 2.0m = 80m` deep). */
export const GRID_ROWS = 40;

/** World-space side length of one ASCII tile in meters (1 Three.js unit = 1m). */
export const TILE_SIZE_M = 2.0;

/** Total world width in meters (`72m`, spanning `x: [-36, +36]`). */
export const ARENA_WIDTH_M = GRID_COLS * TILE_SIZE_M;

/** Total world depth in meters (`80m`, spanning `z: [-40, +40]`). */
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
  | 'S'
  | 'A'
  | 'E'
  | '.';

/**
 * Default "Chroma Ascent" 2-Site S&D Layout (`72m x 80m`, `x: [-36, 36]`, `z: [-40, 40]`).
 *
 * Column bands: c1-11 West Wing (Site A, warm sandstone) | c12 wall |
 *               c13-22 Mid Plaza (slate) | c23 wall | c24-34 East Wing (Site B, cobalt steel)
 *
 * - **North CT-Spawn Sanctuary (r1-4, z -38..-30)**: 3 `E` pads (r2), with
 *   covered rotation corridors (r1-2) running West to A-Heaven / A-CT and East
 *   to B-CT, plus two doors (r5) down into the **Mid Defender Nest** (r6-11).
 * - **Site A (`1`, 4x4 r8-11 c5-8, center x=-22)**: landmark **Central
 *   Generator Pillar** (`B` / `D` / `=` / `B` 2x2 core), **A-Heaven** (`P`
 *   0.90m deck r3-4 with `^` CT stairs r2 and `v` site stairs r5 behind a `===`
 *   railing), A-Long door pillars (c4), **A-Short** entry (r13 c9-10) and the
 *   **A-Tree window** (`W`, r13 c7) looking from A-Short into the site.
 * - **A-Long (c1-3, r3-27)**: a 50m rifle/sniper lane with a cubby (r18 c4),
 *   a lurk door (r22 c4) and staggered `D` / `=` cover that never seals it.
 * - **Mid Plaza (c13-22, r13-24)**: offset **Mid Cubby Pillar** (r17-19
 *   c16-17), **Mid Sniper Window** (`WW`, r12 c17-18) from the Nest, **Mid
 *   Catwalk** (`P` r16-20 c21-22 with `^` / `v` stairs), A-Short arch (r15 c12),
 *   B-Short arch (r15 c23) and **West / East Lurk** arches (r21 c12 / c23) into
 *   quiet lurk rooms that link Mid -> A-Short (crawl c10) and Mid -> B-Hookah.
 * - **Site B (`2`, 4x4 r8-11 c29-32, center x=+26)**: Reactor Container Bay
 *   with `B` / `D` / `=` multi-height boxes, **B-Main** archway (`OO`, r13
 *   c32-33) fed by the 3-wide **B-Tunnels** (c32-34), **B-Short** arch (r13
 *   c24), and the elevated **B-Hookah Overlook** (`P` r14-15 c25-27 behind the
 *   `WW` window r13 c26-27) looking down into the site.
 * - **Dog-leg buy exits (r26-28)**: every South exit crosses the `z = +18`
 *   seam through a 2-wide door (r28 c8-9 / c20-21 / c26-27) into a lateral
 *   corridor (r26-27) capped by solid walls (r25), then turns into A-Long, the
 *   Mid neck (r25 c13-15) or B-Tunnels: zero round-start sightlines.
 * - **South T-Spawn Courtyard (r34-38, z +28..+38)**: 3 `A` pads (r36), ONE
 *   `S` Spike Pedestal (r34 c18) right in front of them, and 3 dog-leg exits
 *   into **A-Lobby** (West, r29-33), **Top-Mid** (Center, r29-32) and
 *   **B-Lobby** (East, r29-33).
 */
export const DEFAULT_KILLHOUSE_GRID: string[] = [
  '####################################', // r0  z -40..-38  North perimeter
  '#..................................#', // r1  z -38..-36  A-CT | CT spawn | B-CT rotation corridors
  '#.......^^....E...E..E.............#', // r2  z -36..-34  Heaven CT stairs | Defender pads
  '#...#PPPPP..#..........#..#######..#', // r3  z -34..-32  A-Heaven deck | CT spawn | B-CT drops
  '#...#PPPPP..#..........#...........#', // r4  z -32..-30  A-Heaven deck | B back
  '#...#vv===..####.##.####........=..#', // r5  z -30..-28  Heaven stairs + railing | Nest doors
  '#...#....=..#..........#..BD.......#', // r6  z -28..-26  Site A top | Mid Nest | B back boxes
  '#...........O..........O..........B#', // r7  z -26..-24  Nest -> A / Nest -> B arches
  '#....1111...#.D......D.#.....2222..#', // r8  z -24..-22  Site A / Site B plant zones
  '#...B1BD1...#..........#.....2BD2..#', // r9  z -22..-20  Generator pillar | Reactor containers
  '#....1=B1...#...=..=...#.....2=22..#', // r10 z -20..-18  Generator pillar | Reactor low box
  '#....1111.D.#..........#.D...2222..#', // r11 z -18..-16  Plant zones (south rows)
  '#...#.=.....##O##WW##O##...........#', // r12 z -16..-14  Mid Sniper Window + Nest arches
  '#...###W#..##..........#O#WW####OO##', // r13 z -14..-12  A-Tree W | A-Short | B-Short | Hookah WW | B-Main OO
  '#...##......#..=.......#.PPP...#...#', // r14 z -12..-10  A-Short room | Mid | Hookah deck
  '#...##......O........^^O.PPP...#...#', // r15 z -10.. -8  A-Short arch | Catwalk ^ | B-Short arch
  '#..D##......#........PP#.vvv...#...#', // r16 z  -8.. -6  Long box | Catwalk | Hookah stairs
  '#...######.##...##...PP#.......#...#', // r17 z  -6.. -4  A crawl | Mid cubby pillar
  '#....#####.##...##...PP#...........#', // r18 z  -4.. -2  Long cubby | Hookah -> Tunnels
  '#...######.##...##...PP#####.###...#', // r19 z  -2..  0  Hookah -> East lurk door
  '#...#.......#......B.PP#.......#..D#', // r20 z   0.. +2  Lurk rooms | Tunnel box
  '#=..#.......O........vvO.......#...#', // r21 z  +2.. +4  West / East lurk arches | Catwalk v
  '#...........#..D.......#...........#', // r22 z  +4.. +6  Long <-> West lurk | East lurk <-> Tunnels
  '#...#.......#..........#.......#...#', // r23 z  +6.. +8  Lurk rooms
  '#...#########..........#########=..#', // r24 z  +8..+10  Lower Mid
  '#.=.#########...################...#', // r25 z +10..+12  Dog-leg caps | Mid neck
  '#.........###.........####.........#', // r26 z +12..+14  Lateral dog-leg corridors
  '#.........###.........####.........#', // r27 z +14..+16  Lateral dog-leg corridors
  '########..##########..####..########', // r28 z +16..+18  Buy-exit doors (A / Top-Mid / B)
  '####......####........####......####', // r29 z +18..+20  A-Lobby | Top-Mid | B-Lobby
  '####.D....####...D....####......####', // r30 z +20..+22
  '####......###.........####......####', // r31 z +22..+24  Top-Mid side door
  '####......###.........####....D.####', // r32 z +24..+26
  '####......###.############......####', // r33 z +26..+28  Courtyard north wall
  '######..###.......S......###..######', // r34 z +28..+30  Spike Pedestal
  '######..###.=............###..######', // r35 z +30..+32
  '######.........A..A..A........######', // r36 z +32..+34  Attacker pads + West / East exits
  '######.................=......######', // r37 z +34..+36
  '###########B............B###########', // r38 z +36..+38  Courtyard back
  '####################################', // r39 z +38..+40  South perimeter
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
  'S',
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
