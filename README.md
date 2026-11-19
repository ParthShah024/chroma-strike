# Chroma Strike

A fast-paced, *Valorant*-inspired **3v3 Tactical 3D First-Person Shooter** built completely from first principles in **TypeScript, Three.js, custom GLSL shaders, and procedural Web Audio** — with zero external engine black boxes, zero texture assets, and zero audio files.

> **Want to understand every single line and equation?** Read the complete interactive textbook **[docs/MASTERCLASS.md](docs/MASTERCLASS.md)** covering Delta-Time loops, Counter-Strafing physics, Slab/Sphere raycasting, Opaque GLSL Hollow Smokes, $4\times 4$ Forward Kinematics 3D character rigs, AI perception, Procedural PBR/Shadows, Headless **Blender 5.2 `.glb`** assets, 6-player RFC 6455 WebSocket netcode, and procedural audio synthesis.

---

## Key Features

- **Team Select Lobby -> Agent Select, Custom Names, Surrender & Single-Port `5174` Server (`3v3` Max):**
  - Launches cleanly into a **Valorant Custom Game Lobby** ([`src/ui/lobby.ts`](src/ui/lobby.ts)): set your **Custom Callsign**, pick **Attackers (`0–3/3`)** or **Defenders (`0–3/3`)**, copy the **Shareable LAN/Tunnel URL**, adjust settings, and click **`START MATCH -> AGENT SELECT`**.
  - Powered by a zero-dependency Node.js **Single-Port HTTP + RFC 6455 WebSocket Server** ([`server/gameServer.mjs`](server/gameServer.mjs), `0.0.0.0:5174`, `npm start`) serving BOTH the built game (`dist/`) AND 6-player WebSockets on one port (`http://<LAN_IP>:5174/` on local Wi-Fi, or ONE `cloudflared tunnel --url http://127.0.0.1:5174` URL over the internet!), plus Pause/Settings **Match Surrender**.
- **Near 1:1 Blender 5.2 "Ascent" Replica (`84 m × 92 m`, Zero Z-Fighting) & Breakable Blast Doors:**
  - Built from a single-source-of-truth Blender Python script ([`scripts/blender/build_ascent_map.py`](scripts/blender/build_ascent_map.py)) outputting both **`public/models/ascent_map.glb`** (`33,528` tris) and exact physics/nav/vector data ([`src/arena/ascentMapData.ts`](src/arena/ascentMapData.ts) — `185` static AABBs, `1,204` multi-level 3D waypoints, `100%` BFS reachability, **`0` opening sightlines**, and **`0` coplanar Z-fighting overlaps**).
  - Authentic 1:1 landmarks: sculpted 3D Olive Tree in **A Tree** + pergola + **CT/Heaven connector**, arched **A Wine** barrel alcove, **A Lobby <-> Mid Tiles**, **two-story A Heaven (`y = 3.00 m`) directly above A Hell (`y = 0.00 m`)**, **A Generator** turbine, **A Dice**, **Mid Subroza** cubby + **Catwalk (`0.85 m`)**, **Mid Pizza**, arched **Mid Market** (`1.10–2.50 m` window), enclosed **B Main** garage, **B Logs**, **B Lane (`0.85 m`)**, **B Boat House** dock + gondola + gable terracotta roof, and skyline palazzos + **Campanile Bell Tower**.
  - **Interactive Breakable Blast Doors (`A Tree Door` & `B Market Door`, `400 HP`):** Reset open every round; press **`[F]`** near wall switches to smoothly toggle (`0.6 s`) steel shutters in/out of `ARENA_COLLIDERS`, or shoot closed shutters (players & bots) to shatter them into tumbling debris!
- **Auto-Spectate, Post-Round Combat Report & Unmistakable Enemy/Ally IFF:**
  - **Auto-Spectate on Death:** Automatically follows living teammates over-the-shoulder when eliminated (`Left/Right Click` cycles teammates, `[Tab]` takes over a bot) alongside a sleek **Post-Round Combat Report** showing exact `OUT` vs. `IN` damage and head/body hits per opponent.
  - **Crystal-Clear Team Readability:** Enemies carry vivid **crimson rim highlights, ground rings, tracers & LoS-gated `ENEMY • NAME` plates**, Allies show **cyan rings, tracers & `ALLY • NAME` plates**, aiming over unoccluded players displays a live reticle ID tag, and hits flash a crisp **X-hitmarker**.
- **Large 2D Valorant Map (`[M]` Default), Unified Settings (`[O]` / `[C]`) & Mouse-Button Ability Rebinds:**
  - Press **`[M]`** for a large **`620×680 px`** (`2×` DPR) **2D Valorant Top-Down Tactical Map** (all 20 callouts, elevation coding, live Blast Door HP, Spike, FOV cones, Distance/LoS Ruler), with a **`[3D FLYOVER]`** toggle; **`[CapsLock]`** holds the Full Tactical Overlay and **`[N]`** toggles Rotating Radar <-> Fixed North-Up.
  - Press **`[O]`** anytime for **Unified Settings** (`Controls` incl. **Hold/Toggle ADS** & **Click-to-Rebind `[Q]/[E]/[X]` to Keyboard or `Mouse3/Mouse4/Mouse5`**, **`Crosshair` `[C]`**, `Video & Minimap`, `Audio` volume/mute, and `Match` rules & **Custom Name**).
- **2-Site Search & Destroy (`5/5 Swap, First to 10`) & Strictly 2/Round Ability Charges:**
  - Plays **5 rounds on your chosen starting side**, **swaps Attack <-> Defense every 5 rounds** with `800¤` economy/ult resets, and crowns the **First to 10** (`First to 6` quick option); deliberate tactical pacing (`6.2 m/s` run, `3.2 m/s` walk) and Single T-Spawn Spike Pedestal.
  - Every Agent's **`[Q]` & `[E]` are limited to strictly `2` charges per round** (no unlimited timer refills; `[X]` requires `5` Ult Points).
- **Valorant / CS Financial Economy & `[B]` Buyout Shop:**
  - Start at **`800¤`** (`9000¤` cap), earn **`+3000¤`** win / **`1900 / 2400 / 2900¤`** loss-streak bonus, **`+200¤`** per kill, and **`+300¤`** team plant/defuse bonuses. Survivors carry over weapons and remaining shield armor!
  - Press **`[B]`** during the Buy Phase to buy **Sidearm (`0¤`)**, **Spectre SMG (`1600¤`)**, **Pulse Rifle AR (`2900¤`)**, **Rail Sniper (`4700¤`)**, **Light Shield (`400¤`, `+25` Armor)**, or **Heavy Shield (`1000¤`, `+50` Armor)** with smart delta upgrades, **100% same-round `[R]` refunds**, squad economy strip, and `[P]` Attack/Defend side swap.
- **Centered True ADS Across All 4 Weapons (`[1]`–`[4]` + Right-Click ADS/Scope + Mechanical 1P Android Hands):**
  - All 4 weapons align dead-center (`x = 0`) during ADS with `85%` sway suppression and hipfire reticle fade: **3-dot luminous tritium iron sights** on **`[1]` Sidearm (`72°`)**, sculpted open-frame **Reflex Holo Optics** on **`[2]` Spectre SMG (`64°`)** & **`[3]` Pulse Rifle AR (`58°`)**, and `3.2x` (`24°`) scope on **`[4]` Rail Sniper**.
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

### Option 1 — Single-Port Server (Easy LAN / Friend Joining)
```bash
npm install
npm run build
npm start        # serves game + 6-player WS server on http://0.0.0.0:5174/
```
Friends on the same Wi-Fi/LAN simply open **`http://<YOUR_LAN_IP>:5174/`** (shown in Lobby & terminal), or expose it online with one command: `cloudflared tunnel --url http://127.0.0.1:5174`.

### Option 2 — Vite Dev Mode (`http://127.0.0.1:5173/`)
```bash
npm run server   # 6-player WS server on 0.0.0.0:5174
npm run dev      # Vite dev server on 0.0.0.0:5173
```

### Regenerate Blender `.glb` Assets (Optional — Blender 5.2+ LTS)
```bash
blender --background --python scripts/blender/build_kayo_agent.py
blender --background --python scripts/blender/build_ascent_map.py
```

### Option 3 — Windows One-Click Launcher
Double-click **[play.bat](play.bat)** (starts the 6-player server `5174` + Vite `5173` on `0.0.0.0` and opens your browser automatically).

---

## Project Structure

```text
chroma-strike/
├── docs/
│   └── MASTERCLASS.md            # Complete Chapters 1–10 engineering & math handbook
├── public/
│   └── models/
│       ├── agent_kayo.glb        # Blender 5.2 KAY/O combat android (16 nodes, 5 dorsal kits)
│       └── ascent_map.glb        # Blender 5.2 1:1 Venetian Ascent 3D compound (0 Z-fighting overlaps)
├── scripts/
│   └── blender/
│       ├── build_ascent_map.py   # Single-source Blender generator -> ascent_map.glb + ascentMapData.ts
│       └── build_kayo_agent.py   # Headless Blender bmesh KAY/O generator -> agent_kayo.glb
├── server/
│   └── gameServer.mjs            # Single-port HTTP + 6-player (3v3 max) RFC 6455 WebSocket lobby/relay
├── src/
│   ├── abilities/
│   │   ├── definitions.ts        # Immutable 5-agent AGENT_ABILITIES spec table ([Q], [E], [X])
│   │   ├── shaders.ts            # Custom GLSL Smoke, Void, Singularity, Relay, Magma & Cryo shaders
│   │   └── system.ts             # 15 abilities (2 Q/E charges/round, calm pacing & .dispose())
│   ├── ai/
│   │   └── botBrain.ts           # Multi-level 3D Nav (Heaven/Hell), Door Breaching, S&D & calm AI
│   ├── arena/
│   │   ├── ascentMapData.ts      # Blender-exported 185 AABBs, 1,204 waypoints, Blast Doors & vectors
│   │   ├── map.ts                # GLB loader, raised decals, in-place door colliders & Buy Barriers
│   │   └── textures.ts           # Cached seamless CanvasTexture albedo + hex Buy-Barrier masks
│   ├── audio/
│   │   └── sfx.ts                # Procedural Web Audio + master volume/mute & Door/Ult/Spike SFX
│   ├── combat/
│   │   ├── arsenal.ts            # WEAPON_SPECS (ADS FOV/spread/recoil & buyouts), SHIELD_SPECS & falloff
│   │   ├── targets.ts            # Practice target module (Ch.1/2 sandbox)
│   │   └── weapons.ts            # 4 centered-ADS viewmodels + KAY/O 1P hands, door hit & tracers
│   ├── core/
│   │   └── types.ts              # Simulation, AbilityKeybinds, Lobby, CombatReport, Economy & Spike types
│   ├── entities/
│   │   ├── characterModel.ts     # Modular Blender KAY/O, Enemy/Ally IFF rims, 3D nameplates & FK gait
│   │   ├── glbOverride.ts        # SPA-safe Blender .glb + GLTFLoader runtime loader
│   │   └── spikeModel.ts         # Procedural 3D Radianite Spike canister, dropped beam & blast
│   ├── match/
│   │   ├── economy.ts            # Valorant/CS credits, loss streak, delta shields & survivor carryover
│   │   └── roundManager.ts       # 5 ATK/5 DEF swaps, First to 10 (or 6), Combat Report, Surrender & Spike
│   ├── net/
│   │   └── multiplayer.ts        # 6-player WebSocket client w/ custom callsigns & ?server= override
│   ├── physics/
│   │   └── movement.ts           # Calm counter-strafe (6.2 m/s), Power-Slide & stair-stepping
│   ├── ui/
│   │   ├── agentSelect.ts        # Clean 3D Agent Select ([Q]/[E]/[X] inspector, no overhead UI & locks)
│   │   ├── buyMenu.ts            # Valorant/CS [B] Buyout Shop, Shield upgrades & Squad Economy
│   │   ├── crosshair.ts          # CSS-variable reactive Crosshair Customizer (Settings Crosshair tab)
│   │   ├── lobby.ts              # Attack/Defend Team Select Lobby (`0-3/3`, Invite URL & Callsign)
│   │   ├── mapViewer.ts          # [M] Default Large 2D Valorant Map (+ 3D Flyover & LoS Ruler)
│   │   ├── minimap.ts            # 2x DPR Vector Rotating Radar Minimap & [CapsLock] Callout Overlay
│   │   └── settings.ts           # Persistent 5-tab Settings ([O] Mouse3/4/5 binds, ADS, Name & Surrender)
│   └── main.ts                   # Lobby -> Agent Select -> Match, Auto-Spectate, ADS, IFF & Net loop
├── index.html                    # Lobby, Agent Select, Settings, Spectate, Combat Report & HUD modals
├── package.json
├── play.bat                      # Windows one-click server + Vite dev launcher
└── tsconfig.json
```
