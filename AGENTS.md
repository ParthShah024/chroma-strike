# AGENTS.md — Chroma Strike

Repository rules and quick-start architecture guide for AI coding agents working in `chroma-strike/`.

## Project Overview
- **Chroma Strike** is a 3v3 Search & Destroy tactical FPS built with Three.js (`^0.170.0`), TypeScript (`^5.6.0`), Vite (`^6.0.0`), and a zero-dependency Node RFC 6455 single-port HTTP + WebSocket server (`server/gameServer.mjs`).
- **Match & Room Rules:** Hard cap `MAX_PLAYERS = 6` (`MAX_PER_TEAM = 3`, auto-filled with bots offline/unfilled). Supports `First to 10` (default) and `First to 5` (quick), with `5`-round side swaps, `800¤` halftime economy/ult resets, and a `25.0 s` opaque forward Buy Phase.
- **Agents (6 Total):** `red` (**Blaze**), `blue` (**Mist**), `green` (**Pulse**), `violet` (**Umbra**), `gold` (**Volt**), `cyan` (**Windy**). Each has `Q`/`E` abilities (`2` charges/round; controllers Mist & Umbra open a `620×680` top-down Smoke Tablet on `Q`) and a `5`-point `X` Ultimate.

## Environment & Commands (Windows / PowerShell)
Run commands from `c:\Users\parth\Documents\games\chroma-strike` using the portable Node binary:

```powershell
$node = "$env:LOCALAPPDATA\nodejs-portable\node-v26.13.1-win-x64\node.exe"

# Typecheck
& $node .\node_modules\typescript\bin\tsc --noEmit

# Production bundle (-> dist/)
& $node .\node_modules\vite\bin\vite.js build

# Vite dev server (:5173)
& $node .\node_modules\vite\bin\vite.js --port 5173 --host 0.0.0.0

# Single-port HTTP + WebSocket server (:5174; serves dist/, public/models/*, GET /health)
& $node .\server\gameServer.mjs
```

- **Rebuild vs. Restart Rule:** Client edits (`src/**`, `index.html`) only need `vite build` for `:5174` to serve the updated bundle. Server edits (`server/gameServer.mjs`) require stopping and restarting the `:5174` process.

## Architecture Map
- `src/core/types.ts` — Shared contracts (`WeaponId`, `WeaponSpec`, `PlayerState`, `InputState`, `Combatant`, `MatchHudState`, `GameSettings`, `AbilitySpec`). Keep DOM/Three-free.
- `src/physics/movement.ts` — Fixed AABB movement, counter-strafing, crouching (`1.24 m`), and edge-triggered b-hop math. Keep DOM/Three-free so Node can test it headlessly.
- `src/combat/arsenal.ts` — `WEAPON_SPECS`, `WEAPON_ORDER`, `BUYABLE_WEAPONS`, `SHIELD_SPECS`, and piecewise distance falloff (`computeWeaponDamage`). Keep DOM/Three-free.
- `src/combat/weapons.ts` — 1P weapon viewmodels (`pistol`, `smg`, `ar`, `sniper`, `knife`), optical ADS blend, hitscan + 5-ray close-range knife melee sweep, melee spark rings, and decoupled tracer pool (`tickTracers`, `clearAllTracers`).
- `src/abilities/` (`definitions.ts`, `system.ts`) — 6-agent `[Q]`/`[E]`/`[X]` specs, projectile bounces, persistent hazard/smoke zones, and per-frame movement modifiers.
- `src/arena/` (`map.ts`, `textures.ts`, `ascentMapData.ts`) — Ascent-inspired `84 m × 92 m` 2-site map (`A`/`B`), `depthWrite: true` opaque Buy-Phase Barriers, toggleable/breakable Blast Doors, and Blender `.glb` + AABB collision runtime integration.
- `scripts/blender/` (`build_ascent_map.py`, `build_kayo_agent.py`) & `public/models/` (`ascent_map.glb`, `agent_kayo.glb`) — Blender asset generation scripts and runtime `.glb` models.
- `src/entities/` (`characterModel.ts`, `glbOverride.ts`, `spikeModel.ts`) — Articulated KAY/O-inspired 3D agent rigs, 3rd-person weapon props, crouch IK, BackSide enemy crimson silhouette outlines, and Spike mesh/VFX.
- `src/match/` (`economy.ts`, `roundManager.ts`) — Valorant/CS credit economy, single-shield tier exclusivity + refund, round state machine, Spike plant/defuse (`halfwayCheckpoint`), assist tracking, post-round combat report, and ranked match summary.
- `src/ai/botBrain.ts` — BFS navigation, smoke occlusion, bomb-site Spike logic, and 3-tier AI difficulty (`casual`, `tactical`, `pro`).
- `src/ui/` (`lobby.ts`, `agentSelect.ts`, `buyMenu.ts`, `settings.ts`, `crosshair.ts`, `mapViewer.ts`, `minimap.ts`, `smokeTablet.ts`) — Lobby (`FT10`/`FT5`, side select, invite URL), 3D Agent Select, Buy Shop, Persistent Settings (`M3`/`M4`/`M5`/Wheel binds), Crosshair customizer, unified `[M]` 2D Tactical Map + 3D Orbit Viewer, radar minimap, and Controller Smoke Tablet.
- `src/net/multiplayer.ts` & `server/gameServer.mjs` — 6-player WebSocket room sync, lobby host config, remote damage, door events, and surrender broadcast.
- `src/audio/sfx.ts` — Procedural Web Audio synthesis (gunshots, knife slash, reload, footsteps, Spike beeps, ability cues).
- `src/main.ts` & `index.html` — Three.js scene loop, pointer-lock input + b-hop buffer, loadout slots, HUD bindings, and modals.

## Critical Invariants & Pitfalls
1. **DOM ID Parity:** Every `document.getElementById`, `requireEl`, and `safeGetEl` ID referenced in `src/**/*.ts` must exist in `index.html` (only legacy optional exceptions: `crosshair-modal`, `xhair-close-btn`).
2. **Weapon Contract Checklist (`WeaponId`):** Adding or modifying any `WeaponId` requires updating all of:
   - `src/core/types.ts` (`WeaponId`, `WeaponSpec`)
   - `src/combat/arsenal.ts` (`WEAPON_SPECS`, `WEAPON_ORDER`, `BUYABLE_WEAPONS`)
   - `src/combat/weapons.ts` (`ammoByWeapon`, `weaponRigs`, `applyActiveWeaponVisuals`)
   - `src/entities/characterModel.ts` (`WEAPON_HOLD`, `buildWeaponProps`, `WEAPON_IDS`)
   - `src/match/economy.ts` (`WEAPON_TIER_RANK`, `buyWeapon`)
   - `src/audio/sfx.ts` (`playWeaponShot`)
   - `src/match/roundManager.ts` (`isPrimaryWeapon`, `transitionToRoundEnd`)
3. **3-Slot Loadout vs. Buy Menu:**
   - In combat, slots are `[1]` Owned Primary, `[2]` Sidearm (`pistol`), and `[3]` Tactical Knife (`knife`, always equipped, `75` dmg / `2.4 m` 2-hit kill across all shield tiers, `1.12×` speed), plus mouse-wheel cycling `[Primary -> Pistol -> Knife]`.
   - In `[B]` Buy Menu, iterate `BUYABLE_WEAPONS` only (`[1]`–`[4]` firearms, `[5]`–`[6]` single-shield buy/refund/upgrade) — never list `'knife'` as purchasable.
4. **Edge-Triggered B-Hopping:**
   - Do not revert jumping to hold-`Space` auto-repeat. Keep `jumpJustPressed` + `BHOP_BUFFER_SEC = 0.075` (`src/main.ts`) paired with `LANDING_BHOP_GRACE_SEC = 0.055`, `willJumpThisStep`, and `skipGroundFriction` (`src/physics/movement.ts`) so timed re-jumps preserve horizontal speed (`>= 4.9 m/s`) while holding `Space` never chains bounces.
5. **Decoupled Tracers (`tickTracers`):**
   - `weapon.tickTracers(dt)` must run unconditionally every frame in `src/main.ts` (outside `if (isAlive)` and inside frozen branches), and `resetForRound()` must call `clearAllTracers()`, so mid-flight tracers never freeze on death or round end.
6. **Match Format Sync (`10 | 5`):**
   - Keep valid win targets (`10` and `5`) aligned across `types.ts`, `index.html`, `lobby.ts`, `settings.ts`, `multiplayer.ts`, `roundManager.ts`, and `server/gameServer.mjs` (`VALID_WIN_TARGETS`).
7. **Team Visibility & HUD:**
   - Never render 3D health bars above enemies; enemy team clarity uses BackSide red silhouette outlines (`characterModel.ts`) while teammate HP and ult readiness live in top-bar HUD cards.
8. **Docs Hygiene:**
   - Update `README.md` and `docs/MASTERCLASS.md` when behavior or controls change; avoid creating extra `.md` files unless explicitly requested.

## Verification Before Pushing
1. Run `tsc --noEmit` (must exit `0`).
2. Run `vite build` (must exit `0`).
3. Verify DOM ID parity (`src/**/*.ts` IDs present in `index.html`) and headless physics/arsenal behavior in Node when touching `movement.ts`, `arsenal.ts`, `roundManager.ts`, or UI DOM hooks.
4. If `:5174` is running or modified, verify `GET http://127.0.0.1:5174/health` and `HEAD http://127.0.0.1:5174/` return HTTP `200` (plus WebSocket `set_config` sanity check if protocol changed).
