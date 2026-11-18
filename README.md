# Chroma Strike

A fast-paced, *Valorant*-inspired **3v3 Tactical 3D First-Person Shooter** built completely from first principles in **TypeScript, Three.js, custom GLSL shaders, and procedural Web Audio** — with zero external engine black boxes, zero texture assets, and zero audio files.

> **Want to understand every single line and equation?** Read the complete interactive textbook **[docs/MASTERCLASS.md](docs/MASTERCLASS.md)** covering Delta-Time loops, Counter-Strafing physics, Slab/Sphere raycasting, Opaque GLSL Hollow Smokes, $4\times 4$ Forward Kinematics 3D character rigs, AI perception, and procedural audio synthesis.

---

## Key Features

- **4-Weapon Tactical Arsenal (`[1]`–`[4]` & Scroll Wheel + Right-Click ADS/Scope):**
  - **`[1]` Sidearm (Pistol):** Semi-auto trigger gating, `115` close-range headshot (`18–42 m` piecewise falloff), fastest `1.05x` mobility.
  - **`[2]` Spectre SMG:** Rapid `0.062 s` fire interval, forgiving moving spread, `1.02x` mobility, `64°` ADS.
  - **`[3]` Pulse Rifle (AR):** Pinpoint `160` 1-tap headshots when stationary/counter-strafed, `58°` ADS.
  - **`[4]` Rail Sniper:** `150` body / `255` head damage, `3.2x` (`24°`) optical scope with **focal-length sensitivity scaling** $\tan(\text{FOV}/2)$, thick rail beam tracers, and mechanical bolt-rack audio.
- **3 Color-Coded Agents & 6 Abilities (`[F1]`–`[F3]` to swap Agent, `[Q]` & `[E]` to cast):**
  - **Red — Blaze (Duelist):** **`[Q]` Crimson Dash** (`30 -> 8.2 m/s` cubic ease-out burst + `90°` FOV warp + 3D wind streaks) & **`[E]` Inferno Orb** (Voronoi magma shader, `0.95 m` scrolling flame crown, `28` swirling embers, `45 DPS`).
  - **Blue — Mist (Controller):** **`[Q]` Smoke Dome** (100% opaque Z-buffered `DoubleSide` GLSL hollow sphere with Fresnel rim, `smoothstep` shell seam masking, and `discard` dissolve — **zero see-through**) & **`[E]` Cryo Field** (ice fracture shader, `14` erupting 3D crystal spikes, `80%` target slow + jump lock).
  - **Green — Pulse (Initiator):** **`[Q]` Pop-Flash** (wall-bouncing `0.65 s` orb with warning chirp, 3D starbursts, wall occlusion & *Valorant*-style turn-away dot-product counterplay) & **`[E]` Bio-Stim Beacon** (`+24 HP/s` heal, `1.25x` move speed, `1.35x` fire/reload rate, `0.65x` recoil & overdrive rifle glow).
- **Articulated 3D Person Models (Sculpted by Claude Opus) & `[V]` 1st/3rd-Person Camera:**
  - `THREE.LatheGeometry` revolution-sculpted torsos & tapered limbs with **70%+ vivid Red / Cobalt-Cyan / Emerald armor** (`emissiveIntensity: 0.28`) paired with clean **Pearl-White (Ally) vs. Obsidian (Enemy)** undersuits & ground team rings — unmistakable at 30 m in any fight.
  - Distinct role silhouettes (**Blaze** chevron V-visor, swept wing-fins & animated scarves; **Mist** hooded shadow mask with 3 optic slits & hovering cryo-emitters; **Pulse** emerald recon goggles, comms antenna & spinning octahedron generator pack), backward-only knee gait FK, and **analytic 2-bone arm IK** onto every weapon grip.
  - Toggle **`[V]`** anytime to view your own 3D model with a wall-clamped over-the-shoulder camera!
- **Daylight Killhouse Skirmish Arena & `[M]` Live Map Maker:**
  - Fast-paced `28 m × 34 m` (`14 × 17` 2 m ASCII grid) CoD Killhouse / *Valorant* Skirmish warehouse featuring a central climbable Watchtower (`0.45 m` stairs -> `0.90 m` deck), `1.28 m` chest-high head-glitch barriers, `2.20 m` shipping crates, `ACESFilmicToneMapping` daylight visibility, **2D Greedy Meshing**, and auto-extracted BFS AI waypoints.
  - Press **`[M]`** anytime to open the interactive **Killhouse Map Maker** — paint walls, cover, stairs, highground, and spawns live in the browser (`localStorage`-saved) or copy the generated TypeScript ASCII array straight into [skirmishAscii.ts](src/arena/skirmishAscii.ts).
- **3v3 Round-Based AI Match (`First to 5`):**
  - Round-scaled loadouts (R1 Pistols, R2 SMGs, R3+ AR/Sniper), `buy -> combat -> round_end -> match_over` loop, non-cheating AI bots blocked by walls, smokes (`raycastSphere`), and flashes, plus **`[Tab]` Living Ally Bot Takeover** if eliminated early.
- **Crosshair Customizer (`[C]`) & Procedural Web Audio:**
  - Real-time reticle customizer (`Pro Dot`, `Valorant Classic`, `Dynamic Ring`, colors, center dot, length, thickness, gap, outline, spread error) persisted to `localStorage`.
  - Zero-dependency synthesized gunshots, metallic headshot *dinks*, distant gunfire attenuation, and ability foley.

---

## Controls

| Key / Input | Action |
| :--- | :--- |
| **`W A S D`** | Move & Counter-Strafe (`0.0 m/s` for 100% first-shot accuracy) |
| **`Shift` / `Space`** | Silent Walk / Jump (or Skip Buy Phase) |
| **`Left Click`** | Fire (Semi-auto click for Pistol/Sniper, Hold for SMG/AR) |
| **`Right Click`** | Optical Scope / ADS (`SMG`, `AR`, `Sniper`) |
| **`1` `2` `3` `4` / Wheel** | Equip Pistol / SMG / AR / Sniper |
| **`R`** | Reload |
| **`Q` / `E`** | Cast Agent Ability 1 / Ability 2 |
| **`F1` / `F2` / `F3`** | Switch Active Agent (**Red** / **Blue** / **Green**) |
| **`V`** | Toggle **1st-Person FPS** <-> **3rd-Person 3D Person Model View** |
| **`M`** | Open/Close **Killhouse Live Map Maker** (Paint & Export ASCII Maps) |
| **`C`** | Open/Close **Crosshair Customizer** |
| **`Tab`** | Take Over a Living Ally Bot (when eliminated) |

---

## Quick Start

### Option 1 — Standard Node.js (`>= 18`)
```bash
npm install
npm run dev
```
Open **http://127.0.0.1:5173/** in your browser and click the arena to lock your mouse and enable Web Audio.

### Option 2 — Windows One-Click Launcher
Double-click **[play.bat](play.bat)** (automatically detects standard or portable Node.js, installs dependencies if needed, opens your browser, and launches Vite).

### Production Build Check
```bash
npm run build
```

---

## Project Structure

```text
chroma-strike/
├── docs/
│   └── MASTERCLASS.md            # Complete Chapters 1–4 engineering & math handbook
├── src/
│   ├── abilities/
│   │   ├── definitions.ts        # Immutable AGENT_ABILITIES spec table
│   │   ├── shaders.ts            # Custom GLSL Smoke, Magma, Flame Wall & Cryo shaders
│   │   └── system.ts             # 6 abilities, particles, dash curves, bot cast & .dispose()
│   ├── ai/
│   │   └── botBrain.ts           # 4-state AI FSM, BFS lane routing & multi-gate perception
│   ├── arena/
│   │   ├── map.ts                # 2D Greedy Meshing, Auto-Waypoints, Spawns & Killhouse 3D map
│   │   └── skirmishAscii.ts      # 14x17 2m ASCII Killhouse grid format + normalization
│   ├── audio/
│   │   └── sfx.ts                # Zero-dependency procedural Web Audio synthesizer
│   ├── combat/
│   │   ├── arsenal.ts            # WEAPON_SPECS & piecewise linear damage falloff
│   │   ├── targets.ts            # Practice target module (Ch.1/2 sandbox)
│   │   └── weapons.ts            # 4 viewmodels, trigger gating, scope & shared tracers
│   ├── core/
│   │   └── types.ts              # Pure simulation contracts (zero Three.js coupling)
│   ├── entities/
│   │   └── characterModel.ts     # Opus sculpted LatheGeometry 3D rigs, FK gait & 2-bone arm IK
│   ├── match/
│   │   └── roundManager.ts       # 3v3 round loop, killfeed, bot takeover & rig sync
│   ├── physics/
│   │   └── movement.ts           # Counter-strafe physics, stair-stepping, AABB/Sphere raycasts
│   ├── ui/
│   │   ├── crosshair.ts          # CSS-variable reactive Crosshair Customizer
│   │   └── mapEditor.ts          # Interactive [M] Killhouse Live Map Maker & TS exporter
│   └── main.ts                   # Game loop, focal-length sensitivity, 1P/3P camera & HUD
├── index.html                    # Minimalist color-driven HUD, #scope-overlay & modals
├── package.json
├── play.bat                      # Windows one-click dev launcher
└── tsconfig.json
```
