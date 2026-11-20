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
- **Valorant-Style Top-Bar HUD, Enemy Red Outline & 1P-Only Camera/Spectate:**
  - **Clean Battlefield & Top-Bar Telemetry (`#hud-top`):** Floating in-world health bars and team rims are gone, and **enemy HP is never shown anywhere on-screen**. Instead, `#hud-top` displays compact **teammate HP bars/numbers** alongside clear **gold `ULT` ready/active pills** for both allies and enemies.
  - **Enemy Red Silhouette Outline:** Enemy agents (both procedural rigs and Blender `.glb` chassis) wear a vivid `#ff223e` `BackSide` inverted-hull outline while alive for instant Valorant-style Friend-or-Foe contrast.
  - **1st-Person-Only Camera:** The `[V]` 3rd-person camera toggle has been removed; combat stays crisp 1st-person and eliminated players auto-spectate living teammates from true **1st-person POV** (`Left/Right Click` cycles teammates, `[Tab]` takes over a bot), paired with an upgraded **Combat Report** showing a per-round **Kills / Assists / DMG OUT / DMG IN** summary strip plus `[KILL]`, `[ASSIST]` (`>=25 DMG` threshold), and `[KO]` badges per opponent.
- **Post-Match Ranked Performance Summary & Brimstone-Style Controller Smoke Tablet:**
  - **Ranked End-of-Match Scoreboard:** When a match finishes (`#match-summary-modal`), every combatant is ranked `#1..#6` with **`S+ / S / A / B / C` tiers**, **Match MVP** banner, `K / D / A`, Total Damage, `ADR`, `HS%`, and Average Combat Score (`ACS = round((150*K + 50*A + DMG) / Rounds)`), plus `[Enter]` Rematch & `[L]` Return to Lobby buttons.
  - **Bigger, Easier Controller Smoke Tablet (`620×680` / `1240×1360` Canvas):** Pressing `[Q]` on **Mist** or **Umbra** opens a larger top-down Brimstone-style Ascent tablet ([`src/ui/smokeTablet.ts`](src/ui/smokeTablet.ts)) showing active smokes, teammates, doors, callout target badge, and shaded `40 m` deployment radius (`Left-Click` places opaque Frost/Void smoke; `Right-Click` / `[Q]` / `[Esc]` cancels).
- **Unified `[M]` 2D/3D Map (No Sightlines), `[C / Ctrl]` Crouching & Mouse Rebinds:**
  - Press **`[M]`** (or click the minimap) to open the large **`620×680 px`** (`2×` DPR) **2D Valorant Top-Down Tactical Map** (`[3D FLYOVER]` secondary tab, clean pan & scroll zoom with **no sightline clutter**; duplicate `[CapsLock]` overlay removed), while **`[N]`** toggles Rotating Radar <-> Fixed North-Up.
  - Hold **`[C]`** or **`[Ctrl]`** to **Crouch** (`2.45 m/s` speed, `1.24 m` standing-clearance-checked capsule, `-0.52 m` 1P camera & `-0.46 m` hitbox profile drop, `~22–28%` tighter crouching weapon spread, and crouched 3D leg IK).
  - Press **`[O]`** anytime for **Unified Settings** (`Controls` incl. **Hold/Toggle ADS**, click-to-rebind **`[Q]/[E]/[X]` to Keyboard, `Mouse3/4/5`, or `WheelUp/Down`**, PLUS 1-click **`M3` / `M4` / `M5`** quick-bind pills, **`Crosshair`**, `Video & Minimap`, `Audio`, and `Match` rules).
- **2-Site Search & Destroy (`25 s` Forward Buy Phase, `5/5` Swap, First to 10) & Responsive B-Hop / `5.55 m/s` Tactical Pacing:**
  - Plays **5 rounds on your chosen starting side**, **swaps Attack <-> Defense every 5 rounds** with `800¤` economy/ult resets, and crowns the **First to 10** (`First to 5` quick option); deliberate tactical pacing (`5.55 m/s` normal run, `3.0 m/s` walk, `2.45 m/s` crouch) plus crisp **edge-triggered B-Hopping** (`6.7 m/s` jump, `0.075 s` pre-land tap buffer, momentum preserved on timed re-jumps while holding `Space` still blocks auto-bouncing), always-equipped **Tactical Knife** in slot `[3]` (2 close-range hits kill), and Single T-Spawn Spike Pedestal.
  - **25-Second Opaque Forward Buy Phase (`11` Ascent Setup Chokes):** Opaque (`depthWrite: true`) Buy Barriers sit at **12 forward segments across 11 Ascent chokes** (with real temporary `ARENA_COLLIDERS` walls during Buy Phase blocking both movement and pre-round sightlines completely), letting **Defenders stage directly inside Site A, A Tree, Market, and Site B** while **Attackers advance right up to A Lobby, Top-Mid, and B Lobby**.
  - Every Agent's **`[Q]` & `[E]` are limited to strictly `2` charges per round** (no unlimited timer refills; `[X]` requires `5` Ult Points).
- **Valorant / CS Financial Economy & Single-Shield `[B]` Buyout Shop:**
  - Start at **`800¤`** (`9000¤` cap), earn **`+3000¤`** win / **`1900 / 2400 / 2900¤`** loss-streak bonus, **`+200¤`** per kill, and **`+300¤`** team plant/defuse bonuses. Survivors carry over weapons and remaining shield armor!
  - Press **`[B]`** during the Buy Phase to buy **Sidearm (`0¤`)**, **Spectre SMG (`1600¤`)**, **Pulse Rifle AR (`2900¤`)**, **Rail Sniper (`4700¤`)**, **Light Shield (`400¤`, `+25` Armor)**, or **Heavy Shield (`1000¤`, `+50` Armor)**. **Only one shield tier may be chosen at a time** (buying/owning one locks the other; clicking your same-round shield refunds 100%), alongside `[R]` weapon refunds, squad economy strip, and `[P]` Attack/Defend side swap.
- **Centered True ADS Across All 4 Weapons (`[1]`–`[4]` + Right-Click ADS/Scope + Mechanical 1P Android Hands):**
  - All 4 weapons align dead-center (`x = 0`) during ADS with `85%` sway suppression and hipfire reticle fade: **3-dot luminous tritium iron sights** on **`[1]` Sidearm (`72°`)**, sculpted open-frame **Reflex Holo Optics** on **`[2]` Spectre SMG (`64°`)** & **`[3]` Pulse Rifle AR (`58°`)**, and `3.2x` (`24°`) scope on **`[4]` Rail Sniper**.
- **6 Color-Coded Blender KAY/O Agents & 18 Abilities (`[Q]`, `[E]`, & 5-Point `[X]` Signatures):**
  - Articulated **`public/models/agent_kayo.glb`** sculpted in Blender 5.2 (`16` modular bone segments mounted into FK/IK limbs + distinct dorsal kits & custom aero-vanes, glowing `Mat_VisorLED` visors, **Ally Pearl-Titanium vs. Enemy Obsidian + Red Outline**, one-knee Spike kneel + holo-keypad, back-Spike, & Ult Overcharge rings).
  - Earn **`5` Ult Points** (`2/5` at start of each half, `+1` per kill / death / plant / defuse) to unleash each Agent's signature **`[X]` Ultimate**:
    - **Red — Blaze (Duelist):** `[Q]` Crimson Dash, `[E]` Inferno Orb, & **`[X]` Inferno Overdrive** (`8 s` `1.35x` fire rate + kills reset Dash!).
    - **Blue — Mist (Controller):** `[Q]` **Tactical Tablet Smoke Dome** (`40 m` top-down placement), `[E]` Cryo Field, & **`[X]` Glacial Whiteout** (`8.5 m` 75%-slow blizzard + `4.8 m` Frost Smoke).
    - **Green — Pulse (Initiator):** `[Q]` Wall-Bouncing Pop-Flash, `[E]` Bio-Stim Beacon, & **`[X]` Orbital Recon** (3 arena-wide emerald sonar pulses revealing all foes on Minimap!).
    - **Violet — Umbra (Shadow Controller):** `[Q]` **Tactical Tablet Void Shroud** (`40 m` top-down placement), `[E]` Singularity Vortex (`1.25x` Fragile), & **`[X]` Eclipse Curtain** (~`26 m` wall of 5 Void spheres).
    - **Gold — Volt (Electric Duelist):** `[Q]` Overdrive + Electric Power-Slide, `[E]` 1-Bounce Relay Bolt, & **`[X]` Thunderstorm** (`1.50x` sprint, `0.6 s` slides & `8.5 m` chain-lightning zaps!).
    - **Cyan — Windy (Sky Duelist — Jett-Inspired):** `[Q]` **Updraft** (`11.8 m/s` vertical boost to reach Heaven & crates), `[E]` **Tailwind Dash** (`24 m/s` wind dash chaining seamlessly mid-air after Updraft), Passive **`Space` Tailwind Drift** (`-2.2 m/s` slow fall), & **`[X]` Blade Storm** (`9 s` zero mid-air spread, `1.30x` fire rate, `0.45x` recoil, and kills refresh Dash + extend by `2.5 s`!).

---

## Controls

| Key / Input | Action |
| :--- | :--- |
| **`W A S D`** | Move & Counter-Strafe (`5.55 m/s` run, `0.0 m/s` for 100% first-shot accuracy) |
| **`Shift` / `C` or `Ctrl`** | Silent Walk (`3.0 m/s`, or **Power-Slide** during Volt Overdrive) / **Crouch** (`2.45 m/s`, steadier spread, lower hitbox) |
| **`Space`** | Jump, **Windy Slow-Fall Glide**, or Skip Buy Phase |
| **`Left Click`** | Fire (Semi-auto click for Pistol/Sniper, Hold for SMG/AR — damages closed Blast Doors!) |
| **`Right Click`** | Optical Scope / ADS (`Sidearm`, `SMG`, `AR`, `Sniper`) |
| **`1` `2` `3` / Wheel** | Equip Loadout (**`[1]` Owned Primary**, **`[2]` Sidearm Pistol**, **`[3]` 2-Hit Knife**) |
| **`R`** | Reload (or 100% Weapon Refund in `[B]` Buy Shop) |
| **`Q` / `E` / `X`** | Cast Abilities (`Q` opens **Smoke Tablet** for Controllers Mist/Umbra) / **Ultimate** (`5` Pts — bindable to `M3`/`M4`/`M5`/Wheel) |
| **`F` / `G`** | Hold **`F`** to **Plant / Defuse Spike** (`3 s` / `5 s`); Tap **`F`** at switches to **Toggle Blast Doors**; **`G`** to **Drop Spike** |
| **`B` / `H`** | Open **`[B]` Buyout Shop & Economy** (`25 s` setup window) / **`[H]` 3D Agent Select & AI Difficulty** |
| **`M` / `N`** | Open/Close **Unified 2D Tactical Map** (`[3D FLYOVER]` tab; click radar) / **`N`** toggles **Rotating Radar <-> Fixed** |
| **`O`** | Open **Unified Settings (`Controls` incl. `M3`/`M4`/`M5` pills / `Crosshair` / `Video` / `Audio` / `Match`)** |
| **`F1` – `F6`** | Quick Switch Agent (**Blaze**, **Mist**, **Pulse**, **Umbra**, **Volt**, **Windy**) |
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
│   └── MASTERCLASS.md            # Complete Chapters 1–12 engineering & math handbook
├── public/
│   └── models/
│       ├── agent_kayo.glb        # Blender 5.2 KAY/O combat android (16 nodes + dorsal kits)
│       └── ascent_map.glb        # Blender 5.2 1:1 Venetian Ascent 3D compound (`33,528` tris)
├── scripts/
│   └── blender/
│       ├── build_ascent_map.py   # Single-source Blender generator -> ascent_map.glb + ascentMapData.ts
│       └── build_kayo_agent.py   # Headless Blender bmesh KAY/O generator -> agent_kayo.glb
├── server/
│   └── gameServer.mjs            # Single-port HTTP + 6-player (3v3 max, 6 agents) RFC 6455 relay
├── src/
│   ├── abilities/
│   │   ├── definitions.ts        # Immutable 6-agent AGENT_ABILITIES spec table ([Q], [E], [X])
│   │   ├── shaders.ts            # Custom GLSL Smoke, Void, Singularity, Relay, Magma & Cryo shaders
│   │   └── system.ts             # 18 abilities incl. Windy & Controller remote map smoke (`40m` tablet)
│   ├── ai/
│   │   └── botBrain.ts           # Multi-level 3D Nav, forward Buy Staging, Door Breaching & Windy AI
│   ├── arena/
│   │   ├── ascentMapData.ts      # Blender-exported 185 AABBs, 1,204 waypoints & 12 forward Buy Spans
│   │   ├── map.ts                # GLB loader, solid temporary Buy Barriers, in-place Doors & decals
│   │   └── textures.ts           # Cached seamless CanvasTexture albedo + hex Buy-Barrier masks
│   ├── audio/
│   │   └── sfx.ts                # Procedural Web Audio + Windy gale/blade & Door/Ult/Spike SFX
│   ├── combat/
│   │   ├── arsenal.ts            # WEAPON_SPECS (incl. slot-3 2-hit Knife), BUYABLE_WEAPONS & falloff
│   │   ├── targets.ts            # Practice target module (Ch.1/2 sandbox)
│   │   └── weapons.ts            # 4 firearms + Tactical Knife viewmodel, melee sweep & decoupled tracers
│   ├── core/
│   │   └── types.ts              # 6-Agent, Knife, FT5/FT10, Crouch, CombatSummary & Economy contracts
│   ├── entities/
│   │   ├── characterModel.ts     # BackSide enemy red outline, Windy rig, Knife prop, crouch IK & gait
│   │   ├── glbOverride.ts        # SPA-safe Blender .glb + GLTFLoader runtime loader
│   │   └── spikeModel.ts         # Procedural 3D Radianite Spike canister, dropped beam & blast
│   ├── match/
│   │   ├── economy.ts            # Valorant/CS credits, single-shield exclusion/refund & carryover
│   │   └── roundManager.ts       # Assists, Ranked Summary, Crouch Hitboxes, 25s Buy & FT5/FT10 5/5 Swap
│   ├── net/
│   │   └── multiplayer.ts        # 6-player WebSocket client w/ crouch sync & ?server= override
│   ├── physics/
│   │   └── movement.ts           # Counter-strafe, edge-triggered B-Hop (6.7m/s) & Crouch (1.24m)
│   ├── ui/
│   │   ├── agentSelect.ts        # Clean 6-Agent 3D Select ([F1–F6], [1–6], [Q]/[E]/[X] loadout)
│   │   ├── buyMenu.ts            # Valorant/CS [B] Buyout Shop (1-shield exclusion + Squad Economy)
│   │   ├── crosshair.ts          # CSS-variable reactive Crosshair Customizer (Settings Crosshair tab)
│   │   ├── lobby.ts              # Attack/Defend Team Select Lobby (`0-3/3`, FT10/FT5 & Invite URL)
│   │   ├── mapViewer.ts          # Unified [M] Large 2D Valorant Map + 3D Flyover (clean, no sightlines)
│   │   ├── minimap.ts            # 2x DPR Vector Rotating Radar Minimap (renders smokes, click -> [M])
│   │   ├── settings.ts           # Persistent 5-tab Settings ([O] Mouse3/4/5/Wheel + M3/M4/M5 pills)
│   │   └── smokeTablet.ts        # Larger 620x680 Brimstone-style Smoke Tablet w/ callout badges
│   └── main.ts                   # Engine, B-Hop buffer, Loadout [1-3]/Wheel, Tracers & Net loop
├── index.html                    # Lobby, Agent Select, Smoke Tablet, Match Summary & HUD modals
├── package.json
├── play.bat                      # Windows one-click server + Vite dev launcher
└── tsconfig.json
```
