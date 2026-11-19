# Chroma Strike

A fast-paced, *Valorant*-inspired **3v3 Tactical 3D First-Person Shooter** built completely from first principles in **TypeScript, Three.js, custom GLSL shaders, and procedural Web Audio** — with zero external engine black boxes, zero texture assets, and zero audio files.

> **Want to understand every single line and equation?** Read the complete interactive textbook **[docs/MASTERCLASS.md](docs/MASTERCLASS.md)** covering Delta-Time loops, Counter-Strafing physics, Slab/Sphere raycasting, Opaque GLSL Hollow Smokes, $4\times 4$ Forward Kinematics 3D character rigs, AI perception, Procedural PBR/Shadows, Headless **Blender 5.2 `.glb`** assets, 6-player RFC 6455 WebSocket netcode, and procedural audio synthesis.

---

## Key Features

- **Team Select Lobby -> Agent Select & 6-Player WebSocket Server (`3v3` Max):**
  - Launches cleanly into a **Valorant Custom Game Lobby** ([`src/ui/lobby.ts`](src/ui/lobby.ts)): pick **Attackers (`0–3/3`)** or **Defenders (`0–3/3`)**, set difficulty & match format, adjust settings, and click **`START MATCH -> AGENT SELECT`**.
  - Powered by a zero-dependency Node.js RFC 6455 WebSocket server ([`server/gameServer.mjs`](server/gameServer.mjs), port `5174`, `npm run server`) strictly capped at **6 players (`3/team`)** with AI bot auto-fill for empty slots — or play solo offline seamlessly with zero setup!
- **Near 1:1 Blender 5.2 "Ascent" Replica (`84 m × 92 m`) & Breakable Blast Doors (ASCII Retired):**
  - Built from a single-source-of-truth Blender Python script ([`scripts/blender/build_ascent_map.py`](scripts/blender/build_ascent_map.py)) outputting both **`public/models/ascent_map.glb`** (`35,540` tris) and exact physics/nav/vector data ([`src/arena/ascentMapData.ts`](src/arena/ascentMapData.ts) — `182` static AABBs, `1,204` multi-level 3D waypoints, `100%` BFS reachability, and **`0` opening sightlines**).
  - Authentic 1:1 landmarks: sculpted 3D Olive Tree in **A Tree** + pergola + **CT/Heaven connector**, arched **A Wine** barrel alcove, **A Lobby <-> Mid Tiles**, **two-story A Heaven (`y = 3.00 m`) directly above A Hell (`y = 0.00 m`)**, **A Generator** turbine, **A Dice**, **Mid Subroza** cubby + **Catwalk (`0.85 m`)**, **Mid Pizza**, arched **Mid Market** (`1.10–2.50 m` window), enclosed **B Main** garage, **B Logs**, **B Lane (`0.85 m`)**, **B Boat House** dock + gondola + gable terracotta roof, and skyline palazzos + **Campanile Bell Tower**.
  - **Interactive Breakable Blast Doors (`A Tree Door` & `B Market Door`, `400 HP`):** Reset open every round; press **`[F]`** near wall switches to smoothly toggle (`0.6 s`) steel shutters in/out of `ARENA_COLLIDERS`, or shoot closed shutters (players & bots) to shatter them into tumbling debris!
- **Large 2D Valorant Map (`[M]` Default), Unified Settings (`[O]` / `[C]`) & Rotating Radar (`[CapsLock]` / `[N]`):**
  - Press **`[M]`** for a large **`620×680 px`** (`2×` DPR) **2D Valorant Top-Down Tactical Map** (all 20 callouts, elevation coding, live Blast Door HP, Spike, FOV cones, Distance/LoS Ruler), with a **`[3D FLYOVER]`** toggle for live 3D camera inspection!
  - Corner **`2×` DPR Vector Radar Minimap** (`compact` / `standard` / `large`) rotates around the player (**`[N]`** toggles Fixed North-Up); hold **`[CapsLock]`** for the **`560×614 px`** Full Tactical Overlay.
  - Press **`[O]`** anytime for **Unified Settings** (`Controls`, **`Crosshair` `[C]`**, `Video & Minimap`, `Audio` volume/mute, and `Match` rules persisted to `localStorage`).
- **2-Site Search & Destroy (`5 Attack / 5 Defense Swap, First to 10 Wins`) & Deliberate Pacing:**
  - Plays **5 rounds on your chosen starting side**, **swaps Attack <-> Defense every 5 rounds** with `800¤` economy/ult resets, and crowns the **First to 10** (`First to 6` quick option in Lobby/Settings)!
  - Calm tactical pacing (`6.2 m/s` run, `3.2 m/s` walk, `15 s` buy / `100 s` combat / `45 s` post-plant, readable AI reactions) paired with the **Single Physical T-Spawn Spike Pedestal** (`1.8 m` pickup, `[G]` drop, `3.0 s` `[F]` plant, `5.0 s` defuse w/ `50%` checkpoint).
- **Valorant / CS Financial Economy & `[B]` Buyout Shop:**
  - Start at **`800¤`** (`9000¤` cap), earn **`+3000¤`** win / **`1900 / 2400 / 2900¤`** loss-streak bonus, **`+200¤`** per kill, and **`+300¤`** team plant/defuse bonuses. Survivors carry over weapons and remaining shield armor!
  - Press **`[B]`** during the Buy Phase to buy **Sidearm (`0¤`)**, **Spectre SMG (`1600¤`)**, **Pulse Rifle AR (`2900¤`)**, **Rail Sniper (`4700¤`)**, **Light Shield (`400¤`, `+25` Armor)**, or **Heavy Shield (`1000¤`, `+50` Armor)** with smart delta upgrades, **100% same-round `[R]` refunds**, squad economy strip, and `[P]` Attack/Defend side swap.
- **4-Weapon Tactical Arsenal (`[1]`–`[4]` + Right-Click ADS/Scope + Mechanical 1P Android Hands):**
  - Articulated **dark-titanium mechanical KAY/O fingers**, knuckle actuators, **Agent-colored wrist plates & glowing LED bars** grip all 4 weapons, alongside reflex sights and a fluted Sniper barrel.
  - **`[1]` Sidearm (`0¤`):** Semi-auto trigger gating, `115` close headshot, `1.05x` mobility. **`[2]` Spectre SMG (`1600¤`):** `0.062 s` fire interval, `64°` ADS. **`[3]` Pulse Rifle AR (`2900¤`):** Pinpoint `160` 1-tap headshots, `58°` ADS. **`[4]` Rail Sniper (`4700¤`):** `150` body / `255` head damage, `3.2x` (`24°`) scope with focal-length sensitivity scaling $\tan(\text{FOV}/2)$.
- **5 Color-Coded Blender KAY/O Agents & 15 Abilities (`[Q]`, `[E]`, & 5-Point `[X]` Signatures):**
  - Articulated **`public/models/agent_kayo.glb`** sculpted in Blender 5.2 (`16` modular bone segments mounted into FK/IK limbs + distinct dorsal kits `Kit_Red..Kit_Gold`, glowing `Mat_VisorLED` visors, **Ally Pearl-Titanium vs. Enemy Obsidian-Gunmetal** readability, one-knee Spike kneel + holo-keypad, back-Spike, & Ult Overcharge rings).
  - Earn **`5` Ult Points** (`2/5` at start of each half, `+1` per kill / death / plant / defuse) to unleash each Agent's signature **`[X]` Ultimate**:
    - **Red — Blaze (Duelist):** `[Q]` Crimson Dash, `[E]` Inferno Orb, & **`[X]` Inferno Overdrive** (`8 s` `1.35x` fire rate + kills reset Dash!).
    - **Blue — Mist (Controller):** `[Q]` Opaque Smoke Dome, `[E]` Cryo Field, & **`[X]` Glacial Whiteout** (`8.5 m` 75%-slow blizzard + `4.8 m` Frost Smoke).
    - **Green — Pulse (Initiator):** `[Q]` Wall-Bouncing Pop-Flash, `[E]` Bio-Stim Beacon, & **`[X]` Orbital Recon** (3 arena-wide emerald sonar pulses revealing all foes on Minimap!).
    - **Violet — Umbra (Shadow Controller):** `[Q]` 2-charge Phase Void Shroud, `[E]` Singularity Vortex (`1.25x` Fragile), & **`[X]` Eclipse Curtain** (~`26 m` wall of 5 Void spheres).
    - **Gold — Volt (Electric Duelist):** `[Q]` Overdrive + Electric Power-Slide, `[E]` 1-Bounce Relay Bolt, & **`[X]` Thunderstorm** (`1.50x` sprint, `0.6 s` slides & `8.5 m` chain-lightning zaps!).

---

## Controls

| Key / Input | Action |
| :--- | :--- |
| **`W A S D`** | Move & Counter-Strafe (`0.0 m/s` for 100% first-shot accuracy) |
| **`Shift` / `Space`** | Silent Walk (or **Power-Slide** during Volt Overdrive) / Jump (or Skip Buy Phase) |
| **`Left Click`** | Fire (Semi-auto click for Pistol/Sniper, Hold for SMG/AR — damages closed Blast Doors!) |
| **`Right Click`** | Optical Scope / ADS (`SMG`, `AR`, `Sniper`) |
| **`1` `2` `3` `4` / Wheel** | Equip Purchased Weapons (`Sidearm` / Owned Primary) — Buys Weapons in Shop |
| **`R`** | Reload (or 100% Weapon Refund in `[B]` Buy Shop) |
| **`Q` / `E` / `X`** | Cast Agent Ability 1 / Ability 2 / **Signature `[X]` Ultimate** (`5` Ult Points) |
| **`F` / `G`** | Hold **`F`** to **Plant / Defuse Spike** (`3 s` / `5 s`); Tap **`F`** at switches to **Toggle Blast Doors**; **`G`** to **Drop Spike** |
| **`B` / `H`** | Open **`[B]` Buyout Shop & Economy** / **`[H]` 3D Agent Select & AI Difficulty** (during Buy Phase) |
| **`M`** | Open/Close **Large `2D` Valorant Tactical Map** (`[3D FLYOVER]` toggle + LoS & Distance Ruler) |
| **`CapsLock` / `N`** | Hold **`CapsLock`** (or click radar) for **Full Tactical Callout Map** / **`N`** toggles **Rotating Radar <-> Fixed** |
| **`O` / `C`** | Open **Unified Settings (`Controls` / `Video` / `Audio` / `Match`)** / **Crosshair Tab** |
| **`F1` – `F5` / `V`** | Quick Switch Agent (**Blaze**..**Volt**) / Toggle **1P <-> 3P Camera** |
| **`Tab`** | Take Over Living Ally Bot when eliminated |

---

## Quick Start

### Option 1 — Standard Node.js (`>= 18`)
```bash
npm install
npm run server   # optional: 6-player WebSocket lobby server on ws://127.0.0.1:5174
npm run dev      # client dev server on http://127.0.0.1:5173
```
Open **http://127.0.0.1:5173/** in your browser — pick **Attackers** or **Defenders** in the Lobby (`1–6` humans + bot fill), lock your Agent, and click the arena to lock your mouse!

### Regenerate Blender `.glb` Assets (Optional — Blender 5.2+ LTS)
```bash
blender --background --python scripts/blender/build_kayo_agent.py
blender --background --python scripts/blender/build_ascent_map.py
```

### Option 2 — Windows One-Click Launcher
Double-click **[play.bat](play.bat)** (starts the 6-player WS server `5174` + Vite `5173` and opens your browser automatically).

### Production Build Check
```bash
npm run build
```

---

## Project Structure

```text
chroma-strike/
├── docs/
│   └── MASTERCLASS.md            # Complete Chapters 1–9 engineering & math handbook
├── public/
│   └── models/
│       ├── agent_kayo.glb        # Blender 5.2 KAY/O combat android (16 nodes, 5 dorsal kits)
│       └── ascent_map.glb        # Blender 5.2 1:1 Venetian Ascent 84x92m 3D compound + Blast Doors
├── scripts/
│   └── blender/
│       ├── build_ascent_map.py   # Single-source Blender generator -> ascent_map.glb + ascentMapData.ts
│       └── build_kayo_agent.py   # Headless Blender bmesh KAY/O generator -> agent_kayo.glb
├── server/
│   └── gameServer.mjs            # Zero-dependency 6-player (3v3 max) RFC 6455 WebSocket lobby/relay server
├── src/
│   ├── abilities/
│   │   ├── definitions.ts        # Immutable 5-agent AGENT_ABILITIES spec table ([Q], [E], [X])
│   │   ├── shaders.ts            # Custom GLSL Smoke, Void, Singularity, Relay, Magma & Cryo shaders
│   │   └── system.ts             # 15 abilities (5 agents + 5 [X] Ultimates), calm pacing & .dispose()
│   ├── ai/
│   │   └── botBrain.ts           # Multi-level 3D Nav (Heaven/Hell), Door Breaching, S&D & calm AI
│   ├── arena/
│   │   ├── ascentMapData.ts      # Blender-exported 182 AABBs, 1,204 waypoints, Blast Doors & vectors
│   │   ├── map.ts                # GLB loader, in-place door colliders, Buy Barriers & Pedestal
│   │   └── textures.ts           # Cached seamless CanvasTexture albedo + hex Buy-Barrier masks
│   ├── audio/
│   │   └── sfx.ts                # Procedural Web Audio + master volume/mute & Door/Ult/Spike SFX
│   ├── combat/
│   │   ├── arsenal.ts            # WEAPON_SPECS (with buyout costs), SHIELD_SPECS & piecewise falloff
│   │   ├── targets.ts            # Practice target module (Ch.1/2 sandbox)
│   │   └── weapons.ts            # 4 viewmodels + mechanical KAY/O 1P hands, door hit & tracers
│   ├── core/
│   │   └── types.ts              # Simulation, GameSettings, Lobby, ArenaDoor, Economy & Spike contracts
│   ├── entities/
│   │   ├── characterModel.ts     # Modular Blender KAY/O mounting, FK gait/Slide, IK & procedural backup
│   │   ├── glbOverride.ts        # SPA-safe Blender .glb + GLTFLoader runtime loader
│   │   └── spikeModel.ts         # Procedural 3D Radianite Spike canister, dropped beam & blast
│   ├── match/
│   │   ├── economy.ts            # Valorant/CS credits, loss streak, delta shields & survivor carryover
│   │   └── roundManager.ts       # 5 ATK/5 DEF swaps, First to 10 (or 6), net sync & Single Spike
│   ├── net/
│   │   └── multiplayer.ts        # 6-player WebSocket client w/ 2.5s offline Solo Lobby fallback
│   ├── physics/
│   │   └── movement.ts           # Calm counter-strafe (6.2 m/s), Power-Slide & stair-stepping
│   ├── ui/
│   │   ├── agentSelect.ts        # Overlap-free 3D Agent Select ([Q]/[E]/[X] inspector & net locks)
│   │   ├── buyMenu.ts            # Valorant/CS [B] Buyout Shop, Shield upgrades & Squad Economy
│   │   ├── crosshair.ts          # CSS-variable reactive Crosshair Customizer (Settings Crosshair tab)
│   │   ├── lobby.ts              # Attack/Defend Team Select Lobby (`0-3/3` per side, Start Match)
│   │   ├── mapViewer.ts          # [M] Default Large 2D Valorant Map (+ 3D Flyover & LoS Ruler)
│   │   ├── minimap.ts            # 2x DPR Vector Rotating Radar Minimap & [CapsLock] Callout Overlay
│   │   └── settings.ts           # Persistent 5-tab Settings ([O] Controls/Crosshair/Video/Audio/Match)
│   └── main.ts                   # Lobby -> Agent Select -> Match orchestrator, Settings & Net loop
├── index.html                    # Lobby, Agent Select, Settings, S&D HUD, Radar & 2D Map modals
├── package.json
├── play.bat                      # Windows one-click server + Vite dev launcher
└── tsconfig.json
