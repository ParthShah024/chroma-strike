# Chroma Strike

A fast-paced, *Valorant*-inspired **3v3 Tactical 3D First-Person Shooter** built completely from first principles in **TypeScript, Three.js, custom GLSL shaders, and procedural Web Audio** — with zero external engine black boxes, zero texture assets, and zero audio files.

> **Want to understand every single line and equation?** Read the complete interactive textbook **[docs/MASTERCLASS.md](docs/MASTERCLASS.md)** covering Delta-Time loops, Counter-Strafing physics, Slab/Sphere raycasting, Opaque GLSL Hollow Smokes, $4\times 4$ Forward Kinematics 3D character rigs, AI perception, Procedural PBR/Shadows, Headless **Blender 5.2 `.glb`** assets, and procedural audio synthesis.

---

## Key Features

- **Blender 5.2 "Ascent" (`84 m × 92 m`) True 3D S&D Compound & Breakable Blast Doors (ASCII Retired):**
  - Built from a single-source-of-truth Blender Python script ([`scripts/blender/build_ascent_map.py`](scripts/blender/build_ascent_map.py)) outputting both **`public/models/ascent_map.glb`** (`24,420` tris) and exact physics/nav/vector data ([`src/arena/ascentMapData.ts`](src/arena/ascentMapData.ts) — `150` static AABBs, `1,162` multi-level 3D waypoints, `100%` BFS reachability, and **`0` opening sightlines**).
  - Features thin architectural Venetian walls, curved stone archways, true **two-story A Heaven (`y = 3.00 m`) directly above A Hell (`y = 0.00 m`)** connected via a 7-tread CT staircase, sculpted **A Generator**, **A Dice**, **A Wine** oak barrels, raised **Mid Catwalk (`0.85 m`)**, roofed **Mid Market** (`1.10–2.50 m` window), **B Lane (`0.85 m`)**, enclosed **B Boat House** with sloped gable roof, skyline **Campanile Bell Tower**, and **`PCFSoftShadowMap`** sun shadows.
  - **Interactive Breakable Blast Doors (`A Tree Door` & `B Market Door`, `400 HP`):** Reset open every round; press **`[F]`** near wall switches to smoothly toggle (`0.6 s`) steel shutters in/out of `ARENA_COLLIDERS`, or shoot closed shutters (players & bots) to shatter them into tumbling debris!
- **Next-Gen `[M]` 3D Orbit + 2D Vector Tactical Viewer & Rotating Radar Minimap (`[CapsLock]` / `[N]`):**
  - Press **`[M]`** for the fullscreen **3D Orbit Viewer** (left-drag 360° orbit, wheel zoom, right-drag pan, 7 camera presets, projected 3D Ascent callout pins, live Buy Barrier & Blast Door toggles) OR switch to the **`2×` DPR 2D Vector Blueprint** featuring an interactive **Distance & Eye-Height (`1.62 m`) LoS Ruler**!
  - Corner **`2×` DPR Vector Radar Minimap (`210×230`)** rotates dynamically around the player (**`[N]`** toggles Fixed North-Up), shows live Blast Door status/HP bars, `'S'` Pedestal, Buy Barriers, and Pulse `[X]` sonar sweeps; hold **`[CapsLock]`** (or click the minimap) for the **Full Tactical Map Overlay** with all `20` Ascent callouts!
- **2-Site Search & Destroy Mode (`First to 6` + Single T-Spawn Spike Pedestal):**
  - Every round spawns **one physical Spike** on the **Attacker Spawn `'S'` Pedestal** (`{ 0, 0.05, 33 }` South T-Spawn, or North CT mirror after Round 5 Halftime) — walk over it (`1.8 m`) during Buy Phase or Combat to carry it on your back, drop with **`[G]`**, hold **`[F]` (`3.0 s`)** on Site `A`/`B` to plant (`45 s` detonation clock), or hold **`[F]` (`5.0 s`)** as Defender to defuse with a **permanent `50%` halfway checkpoint**!
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
| **`M`** | Open/Close **Fullscreen 3D Orbit Viewer & `2D` Tactical Blueprint** (w/ LoS & Distance Ruler) |
| **`CapsLock` / `N`** | Hold **`CapsLock`** (or click radar) for **Full Tactical Callout Map** / **`N`** toggles **Rotating Radar <-> Fixed** |
| **`F1` – `F5` / `V`** | Quick Switch Agent (**Blaze**..**Volt**) / Toggle **1P <-> 3P Camera** |
| **`C` / `Tab`** | **Crosshair Customizer** / Take Over Living Ally Bot when eliminated |

---

## Quick Start

### Option 1 — Standard Node.js (`>= 18`)
```bash
npm install
npm run dev
```
Open **http://127.0.0.1:5173/** in your browser and click the arena to lock your mouse and enable Web Audio.

### Regenerate Blender `.glb` Assets (Optional — Blender 5.2+ LTS)
```bash
blender --background --python scripts/blender/build_kayo_agent.py
blender --background --python scripts/blender/build_ascent_map.py
```

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
│   └── MASTERCLASS.md            # Complete Chapters 1–8 engineering & math handbook
├── public/
│   └── models/
│       ├── agent_kayo.glb        # Blender 5.2 KAY/O combat android (16 nodes, 5 dorsal kits)
│       └── ascent_map.glb        # Blender 5.2 Venetian Ascent 84x92m 3D compound + Blast Doors
├── scripts/
│   └── blender/
│       ├── build_ascent_map.py   # Single-source Blender generator -> ascent_map.glb + ascentMapData.ts
│       └── build_kayo_agent.py   # Headless Blender bmesh KAY/O generator -> agent_kayo.glb
├── src/
│   ├── abilities/
│   │   ├── definitions.ts        # Immutable 5-agent AGENT_ABILITIES spec table ([Q], [E], [X])
│   │   ├── shaders.ts            # Custom GLSL Smoke, Void, Singularity, Relay, Magma & Cryo shaders
│   │   └── system.ts             # 15 abilities (5 agents + 5 [X] Ultimates), slide/vortex & .dispose()
│   ├── ai/
│   │   └── botBrain.ts           # Multi-level 3D Nav (Heaven/Hell), Door Breaching, S&D & Ult AI
│   ├── arena/
│   │   ├── ascentMapData.ts      # Blender-exported 150 AABBs, 1,162 waypoints, Blast Doors & vectors
│   │   ├── map.ts                # GLB loader, in-place door colliders, Buy Barriers & Pedestal
│   │   └── textures.ts           # Cached seamless CanvasTexture albedo + hex Buy-Barrier masks
│   ├── audio/
│   │   └── sfx.ts                # Zero-dependency procedural Web Audio + Door/Ultimate/Spike SFX
│   ├── combat/
│   │   ├── arsenal.ts            # WEAPON_SPECS (with buyout costs), SHIELD_SPECS & piecewise falloff
│   │   ├── targets.ts            # Practice target module (Ch.1/2 sandbox)
│   │   └── weapons.ts            # 4 viewmodels + mechanical KAY/O 1P hands, door hit & tracers
│   ├── core/
│   │   └── types.ts              # Pure simulation, ArenaDoor, Economy, Ultimate & Spike contracts
│   ├── entities/
│   │   ├── characterModel.ts     # Modular Blender KAY/O mounting, FK gait/Slide, IK & procedural backup
│   │   ├── glbOverride.ts        # SPA-safe Blender .glb + GLTFLoader runtime loader
│   │   └── spikeModel.ts         # Procedural 3D Radianite Spike canister, dropped beam & blast
│   ├── match/
│   │   ├── economy.ts            # Valorant/CS credits, loss streak, delta shields & survivor carryover
│   │   └── roundManager.ts       # 2-Site S&D, single T-Spawn Spike, Blast Doors & 5-pt Ult economy
│   ├── physics/
│   │   └── movement.ts           # Counter-strafe, Power-Slide duck, externalVelocity & stair-stepping
│   ├── ui/
│   │   ├── agentSelect.ts        # Dual-renderer 3D Agent Select ([Q]/[E]/[X] cards & difficulty)
│   │   ├── buyMenu.ts            # Valorant/CS [B] Buyout Shop, Shield upgrades & Squad Economy
│   │   ├── crosshair.ts          # CSS-variable reactive Crosshair Customizer
│   │   ├── mapViewer.ts          # [M] Fullscreen 3D Orbit Viewer + 2D Vector Blueprint w/ LoS Ruler
│   │   └── minimap.ts            # 2x DPR Vector Rotating Radar Minimap & [CapsLock] Callout Overlay
│   └── main.ts                   # Game loop, PCFSoftShadowMap, [F] Door/Spike & HUD synchronization
├── index.html                    # Minimalist S&D HUD, Radar, Tactical Full Map & Viewer modals
├── package.json
├── play.bat                      # Windows one-click dev launcher
└── tsconfig.json
```
