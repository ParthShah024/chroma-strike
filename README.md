# Chroma Strike

A fast-paced, *Valorant*-inspired **3v3 Tactical 3D First-Person Shooter** built completely from first principles in **TypeScript, Three.js, custom GLSL shaders, and procedural Web Audio** — with zero external engine black boxes, zero texture assets, and zero audio files.

> **Want to understand every single line and equation?** Read the complete interactive textbook **[docs/MASTERCLASS.md](docs/MASTERCLASS.md)** covering Delta-Time loops, Counter-Strafing physics, Slab/Sphere raycasting, Opaque GLSL Hollow Smokes, $4\times 4$ Forward Kinematics 3D character rigs, AI perception, Procedural PBR/Shadows, Blender `.glb` integration, and procedural audio synthesis.

---

## Key Features

- **"Chroma Ascent" (`72 m × 80 m`, `36×40` 2-Site S&D Map) & Proven Zero Opening LoS:**
  - Three architectural zones with distinct procedural `CanvasTexture` + `bumpMap` materials and real `PCFSoftShadowMap` sun shadows: **West Wing Site A** (warm sandstone & terracotta, `50 m` A-Long, walkable `0.90 m` A-Heaven deck, A-Tree Window `W`), **Mid Plaza** (slate concrete, Sniper `WW` Nest, walkable Catwalk `P`, West/East lurk rooms), and **East Wing Site B** (cool cobalt steel & hazard striping, B-Tunnels, B-Main `OO` arch, B-Hookah `P`/`WW` overlook **`48 m`** away from Site A).
  - South T-Spawn & North CT-Spawn feature **translucent animated Buy-Phase Setup Barriers** at `z = +18` / `z = -14` and `90°` dog-leg lane exits guaranteeing **0 / 63,054** opening sightlines at round start!
- **2-Site Search & Destroy Mode (`First to 6` + Single T-Spawn Spike Pedestal + Minimap):**
  - Every round spawns **one physical Spike** on the **Attacker Spawn `'S'` Pedestal** (South T-Spawn, or North CT mirror after Round 5 Halftime) — walk over it (`1.8 m`) during Buy Phase or Combat to carry it on your back, drop with **`[G]`**, hold **`[F]` (`3.0 s`)** on Site `A`/`B` to plant (`45 s` detonation clock), or hold **`[F]` (`5.0 s`)** as Defender to defuse with a **permanent `50%` halfway checkpoint**!
  - Offscreen-cached **`180×200` 2D Tactical Minimap** displays `'S'` Pedestal, cyan dashed Buy Barriers during Buy Phase, your FOV cone, teammates, Spike alerts, LoS-spotted enemies, and Pulse **`[X]` Orbital Recon** emerald sonar rings!
- **Valorant / CS Financial Economy & `[B]` Buyout Shop:**
  - Start at **`800¤`** (`9000¤` cap), earn **`+3000¤`** win / **`1900 / 2400 / 2900¤`** loss-streak bonus, **`+200¤`** per kill, and **`+300¤`** team plant/defuse bonuses. Survivors carry over weapons and remaining shield armor!
  - Press **`[B]`** during the Buy Phase to buy **Sidearm (`0¤`)**, **Spectre SMG (`1600¤`)**, **Pulse Rifle AR (`2900¤`)**, **Rail Sniper (`4700¤`)**, **Light Shield (`400¤`, `+25` Armor)**, or **Heavy Shield (`1000¤`, `+50` Armor)** with smart delta upgrades, **100% same-round `[R]` refunds**, squad economy strip, and `[P]` Attack/Defend side swap.
- **4-Weapon Tactical Arsenal (`[1]`–`[4]` + Right-Click ADS/Scope + 1st-Person Agent Hands):**
  - Articulated dark-carbon tactical gloves & **Agent-colored forearm gauntlets** (updating dynamically when switching Agents & flaring during stim/overdrive) grip all 4 weapons, alongside holo reflex sights and a fluted Sniper barrel.
  - **`[1]` Sidearm (`0¤`):** Semi-auto trigger gating, `115` close headshot, `1.05x` mobility. **`[2]` Spectre SMG (`1600¤`):** `0.062 s` fire interval, `64°` ADS. **`[3]` Pulse Rifle AR (`2900¤`):** Pinpoint `160` 1-tap headshots, `58°` ADS. **`[4]` Rail Sniper (`4700¤`):** `150` body / `255` head damage, `3.2x` (`24°`) scope with focal-length sensitivity scaling $\tan(\text{FOV}/2)$.
- **5 Color-Coded Agents & 15 Abilities (`[Q]`, `[E]`, & 5-Point `[X]` Signatures):**
  - Earn **`5` Ult Points** (`2/5` at start of each half, `+1` per kill / death / plant / defuse) to unleash each Agent's signature **`[X]` Ultimate**!
  - **Red — Blaze (Duelist):** `[Q]` Crimson Dash, `[E]` Inferno Orb, & **`[X]` Inferno Overdrive** (`8 s` `1.35x` fire rate + kills instantly reset Dash!).
  - **Blue — Mist (Controller):** `[Q]` Opaque Smoke Dome, `[E]` Cryo Field, & **`[X]` Glacial Whiteout** (`8.5 m` 75%-slow blizzard + `4.8 m` Frost Smoke Dome).
  - **Green — Pulse (Initiator):** `[Q]` Wall-Bouncing Pop-Flash, `[E]` Bio-Stim Beacon, & **`[X]` Orbital Recon** (3 arena-wide emerald sonar pulses revealing all living foes on the minimap!).
  - **Violet — Umbra (Shadow Controller):** `[Q]` 2-charge Phase Void Shroud, `[E]` Singularity Vortex (`1.25x` Fragile), & **`[X]` Eclipse Curtain** (~`26 m` wall of 5 opaque Void spheres).
  - **Gold — Volt (Electric Duelist):** `[Q]` Overdrive + Electric Power-Slide, `[E]` 1-Bounce Relay Bolt, & **`[X]` Thunderstorm** (`1.50x` sprint, `0.6 s` slides & auto `8.5 m` chain-lightning zaps!).
- **Agent Select (`[H]`), Articulated V3 Models, Blender `.glb` Support & `[M]` `36×40` Map Maker:**
  - Launches into a **3-point rim-lit 3D Character Turntable** showing `[Q]`/`[E]`/`[X]` loadouts, **Casual / Tactical / Pro** AI difficulty, and **LOCK IN `[Enter]`**.
  - `THREE.LatheGeometry` Agent rigs (`castShadow`), one-knee **Spike plant/defuse crouch + 12-key holo-keypad**, **back-mounted carrying Spike**, pulsing **Ult Overcharge rings**, plus optional **drop-in Blender `public/models/agent_<id>.glb` runtime overrides** (`loadOptionalGlbAsset`, auto-scaled to `1.82 m`) and **`[V]`** 3rd-person toggle.
  - Press **`[M]`** to open the **`36×40` Ascent Map Maker** (including the `'S'` Spike Pedestal brush, `'W'` Windows, `'O'` Archways, and Sites `1`/`2`).

---

## Controls

| Key / Input | Action |
| :--- | :--- |
| **`W A S D`** | Move & Counter-Strafe (`0.0 m/s` for 100% first-shot accuracy) |
| **`Shift` / `Space`** | Silent Walk (or **Power-Slide** during Volt Overdrive) / Jump (or Skip Buy Phase) |
| **`Left Click`** | Fire (Semi-auto click for Pistol/Sniper, Hold for SMG/AR) |
| **`Right Click`** | Optical Scope / ADS (`SMG`, `AR`, `Sniper`) |
| **`1` `2` `3` `4` / Wheel** | Equip Purchased Weapons (`Sidearm` / Owned Primary) — Buys Weapons in Shop |
| **`R`** | Reload (or 100% Weapon Refund in `[B]` Buy Shop) |
| **`Q` / `E` / `X`** | Cast Agent Ability 1 / Ability 2 / **Signature `[X]` Ultimate** (`5` Ult Points) |
| **`F` / `G`** | Hold **`F`** to **Plant / Defuse Spike** (`3 s` / `5 s w/ 50% checkpoint`); Press **`G`** to **Drop Spike** |
| **`B` / `H`** | Open **`[B]` Buyout Shop & Economy** / **`[H]` 3D Agent Select & AI Difficulty** (during Buy Phase) |
| **`F1` – `F5`** | Quick Switch Agent (**Blaze** / **Mist** / **Pulse** / **Umbra** / **Volt**) |
| **`V`** | Toggle **1st-Person FPS** <-> **3rd-Person 3D Person Model View** |
| **`M`** | Open/Close **`36×40` Ascent S&D Map Maker** (Paint Spike Pedestal `S`, Windows `W`, Sites `1`/`2` & Export ASCII) |
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
│   └── MASTERCLASS.md            # Complete Chapters 1–7 engineering & math handbook
├── src/
│   ├── abilities/
│   │   ├── definitions.ts        # Immutable 5-agent AGENT_ABILITIES spec table ([Q], [E], [X])
│   │   ├── shaders.ts            # Custom GLSL Smoke, Void, Singularity, Relay, Magma & Cryo shaders
│   │   └── system.ts             # 15 abilities (5 agents + 5 [X] Ultimates), slide/vortex & .dispose()
│   ├── ai/
│   │   └── botBrain.ts           # S&D Buy Setup, Spike Fetch, Execute, Lurk, Anchor, Retake & Ult AI
│   ├── arena/
│   │   ├── map.ts                # Multi-band Greedy Meshing, shadows, Buy Barriers & 'S' Pedestal
│   │   ├── skirmishAscii.ts      # 36x40 (72x80m) "Chroma Ascent" 0-LoS S&D ASCII grid format
│   │   └── textures.ts           # Cached seamless CanvasTexture albedo + bumpMap PBR library
│   ├── audio/
│   │   └── sfx.ts                # Zero-dependency procedural Web Audio + Ultimate/Barrier/Spike SFX
│   ├── combat/
│   │   ├── arsenal.ts            # WEAPON_SPECS (with buyout costs), SHIELD_SPECS & piecewise falloff
│   │   ├── targets.ts            # Practice target module (Ch.1/2 sandbox)
│   │   └── weapons.ts            # 4 viewmodels + 1P Agent gloves/gauntlets, holo sights, scope & tracers
│   ├── core/
│   │   └── types.ts              # Pure simulation, Economy, Ultimate & S&D Spike contracts
│   ├── entities/
│   │   ├── characterModel.ts     # Sculpted 5-agent rigs, plant kneel, back-Spike, Ult aura & .glb hook
│   │   ├── glbOverride.ts        # SPA-safe optional Blender .glb + GLTFLoader runtime override
│   │   └── spikeModel.ts         # Procedural 3D Radianite Spike canister, dropped beam & blast
│   ├── match/
│   │   ├── economy.ts            # Valorant/CS credits, loss streak, delta shields & survivor carryover
│   │   └── roundManager.ts       # 2-Site S&D, single T-Spawn Spike, 5-pt Ult economy & Halftime swap
│   ├── physics/
│   │   └── movement.ts           # Counter-strafe, Power-Slide duck, externalVelocity & stair-stepping
│   ├── ui/
│   │   ├── agentSelect.ts        # Dual-renderer 3D Agent Select ([Q]/[E]/[X] cards & difficulty)
│   │   ├── buyMenu.ts            # Valorant/CS [B] Buyout Shop, Shield upgrades & Squad Economy
│   │   ├── crosshair.ts          # CSS-variable reactive Crosshair Customizer
│   │   ├── mapEditor.ts          # Interactive [M] 36x40 S&D Map Maker (Spike 'S', Windows, Sites)
│   │   └── minimap.ts            # Offscreen-cached 180x200 2D Minimap, Buy Barriers & Sonar Pulse
│   └── main.ts                   # Game loop, PCFSoftShadowMap, [X] Ult HUD & input buffering
├── index.html                    # Minimalist S&D HUD, Minimap, Buy Shop, Ult HUD & modals
├── package.json
├── play.bat                      # Windows one-click dev launcher
└── tsconfig.json
```
