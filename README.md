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
- **5 Color-Coded Agents & 10 Abilities (`[B]` Live 3D Agent Select during Buy Phase, `[F1]`–`[F5]` Quick Swap, `[Q]` & `[E]` to Cast):**
  - **Red — Blaze (Duelist):** **`[Q]` Crimson Dash** (`30 -> 8.2 m/s` cubic ease-out burst + `90°` FOV warp + 3D wind streaks) & **`[E]` Inferno Orb** (Voronoi magma shader, `0.95 m` scrolling flame crown, `28` swirling embers, `45 DPS`).
  - **Blue — Mist (Controller):** **`[Q]` Smoke Dome** (100% opaque Z-buffered `DoubleSide` GLSL hollow sphere with Fresnel rim, `smoothstep` shell seam masking, and `discard` dissolve — **zero see-through**) & **`[E]` Cryo Field** (ice fracture shader, `14` erupting 3D crystal spikes, `80%` target slow + jump lock).
  - **Green — Pulse (Initiator):** **`[Q]` Pop-Flash** (wall-bouncing `0.65 s` orb with warning chirp, 3D starbursts, wall occlusion & *Valorant*-style turn-away dot-product counterplay) & **`[E]` Bio-Stim Beacon** (`+24 HP/s` heal, `1.25x` move speed, `1.35x` fire/reload rate, `0.65x` recoil & overdrive rifle glow).
  - **Violet — Umbra (Shadow Smoker / Controller):** **`[Q]` Void Shroud** (**2-charge** `32 m/s` zero-drop phase orb — **tap `[Q]` again mid-flight** to bloom anywhere into an opaque double-domain-warped nebula smoke!) & **`[E]` Singularity** (`4.0 m` swirling accretion vortex pulling enemies inward, blocking jumps, and applying **`1.25x` Fragile** damage).
  - **Gold — Volt (Neon-Style Electric Duelist):** **`[Q]` Overdrive Slide** (`4.5 s` `1.45x` electric sprint + `Shift`/`Q` **`0.55 s` Electric Power-Slide** ducking under `1.28 m` cover with **0 moving spread**!) & **`[E]` Relay Bolt** (`34 m/s` 1-bounce lightning bolt spawning twin `3.2 m` ridged-FBM shockzones that deal `22` damage + `2.0 s` Concuss).
- **Live 3D Agent Select (`[B]`), Fair AI Difficulty & Indie HUD Juice:**
  - Launches directly into a **3-point rim-lit 3D Character Turntable** with `[1]`–`[5]` cards, role/ability callouts, **Casual (Default) / Tactical / Pro** AI Difficulty selector, and **LOCK IN `[Enter]`**.
  - Camera-relative `atan2` directional damage arcs, `x2`/`x3` multi-kill confirmation medals, `140 ms` jump & semi-auto fire input buffering, wall-proximity viewmodel tuck, low-ammo audio click cues, and non-duplicate 5-agent 3v3 team drafts.
- **Articulated 3D Person Models (Sculpted by Claude Opus) & `[V]` 1st/3rd-Person Camera:**
  - `THREE.LatheGeometry` revolution-sculpted torsos & tapered limbs with **70%+ vivid Red / Cobalt-Cyan / Emerald / Amethyst / Electric-Gold armor** paired with clean **Pearl-White (Ally) vs. Obsidian (Enemy)** undersuits & ground team rings — unmistakable at 30 m in any fight.
  - Distinct silhouettes (**Blaze** wing-fins & scarves; **Mist** cowl + cryo emitters; **Pulse** recon goggles + octahedron generator pack; **Umbra** `1.6π` bell cowl + bobbing spine censer vials + rippling shadow veils; **Volt** aero speedster helmet + dorsal `TorusKnot` lightning coils + sprint arc `THREE.Line` + **low Power-Slide pose**) and **analytic 2-bone arm IK**.
  - Toggle **`[V]`** anytime to view your own 3D model with a wall-clamped over-the-shoulder camera!
- **Daylight Killhouse Skirmish Arena (Zero Z-Fighting) & `[M]` Live Map Maker:**
  - Fast-paced `28 m × 34 m` (`14 × 17` 2 m ASCII grid) CoD Killhouse / *Valorant* Skirmish warehouse featuring a central climbable Watchtower (`0.45 m` stairs -> `0.90 m` deck), `1.28 m` chest-high head-glitch barriers, `2.20 m` shipping crates, `ACESFilmicToneMapping` daylight visibility, relief-extruded `frameSteel` posts + `polygonOffset` anti-flashing protection, **2D Greedy Meshing**, and auto-extracted BFS AI waypoints.
  - Press **`[M]`** anytime to open the interactive **Killhouse Map Maker** — paint walls, cover, stairs, highground, and spawns live in the browser (`localStorage`-saved) or copy the generated TypeScript ASCII array straight into [skirmishAscii.ts](src/arena/skirmishAscii.ts).
- **3v3 Round-Based AI Match (`First to 5`):**
  - Non-duplicate 5-agent squads with round-scaled loadouts (R1 Pistols, R2 SMGs, R3+ AR/Sniper), `7.0 s` `buy -> combat -> round_end -> match_over` loop (`[Space]` skip buy), non-cheating AI bots blocked by walls, smokes (`raycastSphere`), and flashes, plus **`[Tab]` Living Ally Bot Takeover** if eliminated early.
- **Crosshair Customizer (`[C]`) & Procedural Web Audio:**
  - Real-time reticle customizer (`Pro Dot`, `Valorant Classic`, `Dynamic Ring`, colors, center dot, length, thickness, gap, outline, spread error) persisted to `localStorage`.
  - Zero-dependency synthesized gunshots, metallic headshot *dinks*, distant gunfire attenuation, and ability foley.

---

## Controls

| Key / Input | Action |
| :--- | :--- |
| **`W A S D`** | Move & Counter-Strafe (`0.0 m/s` for 100% first-shot accuracy) |
| **`Shift` / `Space`** | Silent Walk (or **Power-Slide** during Volt Overdrive) / Jump (or Skip Buy Phase) |
| **`Left Click`** | Fire (Semi-auto click for Pistol/Sniper, Hold for SMG/AR) |
| **`Right Click`** | Optical Scope / ADS (`SMG`, `AR`, `Sniper`) |
| **`1` `2` `3` `4` / Wheel** | Equip Pistol / SMG / AR / Sniper |
| **`R`** | Reload |
| **`Q` / `E`** | Cast Agent Ability 1 / Ability 2 (Re-tap `Q` mid-flight on Umbra to bloom early!) |
| **`B`** | Open **Live 3D Agent Select & AI Difficulty** (during Buy Phase) |
| **`F1` – `F5`** | Quick Switch Agent (**Blaze** / **Mist** / **Pulse** / **Umbra** / **Volt**) |
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
│   └── MASTERCLASS.md            # Complete Chapters 1–5 engineering & math handbook
├── src/
│   ├── abilities/
│   │   ├── definitions.ts        # Immutable 5-agent AGENT_ABILITIES spec table
│   │   ├── shaders.ts            # Custom GLSL Smoke, Void, Singularity, Relay, Magma & Cryo shaders
│   │   └── system.ts             # 10 abilities (5 agents), slide/vortex curves, bot cast & .dispose()
│   ├── ai/
│   │   └── botBrain.ts           # Casual/Tactical/Pro AI FSM, BFS routing & perception gates
│   ├── arena/
│   │   ├── map.ts                # Z-fighting-free Killhouse 3D map, Greedy Meshing & waypoints
│   │   └── skirmishAscii.ts      # 14x17 2m ASCII Killhouse grid format + normalization
│   ├── audio/
│   │   └── sfx.ts                # Zero-dependency procedural Web Audio synthesizer
│   ├── combat/
│   │   ├── arsenal.ts            # WEAPON_SPECS & piecewise linear damage falloff
│   │   ├── targets.ts            # Practice target module (Ch.1/2 sandbox)
│   │   └── weapons.ts            # 4 viewmodels, wall-tuck, trigger gating, scope & tracers
│   ├── core/
│   │   └── types.ts              # Pure simulation contracts (zero Three.js coupling)
│   ├── entities/
│   │   └── characterModel.ts     # Opus sculpted 5-agent LatheGeometry rigs, FK gait, Slide & 2-bone IK
│   ├── match/
│   │   └── roundManager.ts       # Non-duplicate 3v3 round loop, killfeed, bot takeover & rig sync
│   ├── physics/
│   │   └── movement.ts           # Counter-strafe, Power-Slide duck, externalVelocity & stair-stepping
│   ├── ui/
│   │   ├── agentSelect.ts        # Dual-renderer 3D Agent Select turntable & difficulty selector
│   │   ├── crosshair.ts          # CSS-variable reactive Crosshair Customizer
│   │   └── mapEditor.ts          # Interactive [M] Killhouse Live Map Maker & TS exporter
│   └── main.ts                   # Game loop, focal-length zoom, damage arcs, kill medals & HUD
├── index.html                    # Minimalist color-driven HUD, #scope-overlay & modals
├── package.json
├── play.bat                      # Windows one-click dev launcher
└── tsconfig.json
```
