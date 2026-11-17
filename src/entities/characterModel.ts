import * as THREE from 'three';
import {
  AGENT_PALETTES,
  AgentColorId,
  TeamId,
  Vec3,
  WeaponId,
} from '../core/types';

/**
 * Public handle for an articulated 3D humanoid combatant rig.
 *
 * Keeping rendering state (`CharacterRig`) separate from simulation state
 * (`Combatant` in `types.ts`) allows physics, raycast hitboxes, and AI FSMs
 * to stay purely numeric while the rig consumes read-only frame snapshots.
 */
export interface CharacterRig {
  root: THREE.Group;
  setWeaponModel(weaponId: WeaponId): void;
  triggerFireKick(): void;
  triggerHitFlash(isHeadshot: boolean): void;
  setVisible(visible: boolean): void;
  update(
    dt: number,
    state: {
      position: Vec3;
      velocity: Vec3;
      yaw: number;
      pitch: number;
      health: number;
      maxHealth: number;
      alive: boolean;
      slowTimer: number;
      blindTimer: number;
      occludedBySmoke: boolean;
    },
    cameraPos: Vec3
  ): void;
  dispose(scene: THREE.Scene): void;
}

// ---------------------------------------------------------------------------
// Anatomical Proportions Matched to Gameplay Hitboxes
//   Body AABB: y = [0.00, 1.38], width = 0.76m
//   Head AABB: y = [1.38, 1.82], width = 0.44m (center y = 1.60)
// ---------------------------------------------------------------------------
const FOOT_PIVOT_Y = 0.05;
const HIP_PIVOT_WORLD_Y = 0.86;
const SHOULDER_PIVOT_WORLD_Y = 1.33;
const HEAD_CENTER_WORLD_Y = 1.60;

const HEALTH_BAR_Y = 2.05;
const HEALTH_BAR_WIDTH = 0.84;
const HEALTH_BAR_HEIGHT = 0.075;
const BLIND_HALO_Y = 2.24;

const HIT_FLASH_DURATION_SEC = 0.10;
const DEATH_TILT_TARGET_RAD = -Math.PI * 0.48;
const MAX_WALK_SPEED_MPS = 8.2;
const MAX_STRIDE_AMP_RAD = 0.62;

const ALLY_ARMOR_HEX = 0xdce4f2;
const ENEMY_ARMOR_HEX = 0x1b202c;
const ENEMY_EDGE_HEX = 0xff3b5c;
const DARK_JOINT_HEX = 0x10141c;
const WEAPON_METAL_HEX = 0x262d3b;
const WEAPON_BARREL_HEX = 0x455066;

/**
 * Attaches crisp `EdgesGeometry` wireframe accents onto an enemy armor mesh so
 * Obsidian Charcoal silhouettes read clearly against dark arena shadows.
 */
function addEnemyOutline(mesh: THREE.Mesh, edgeMat: THREE.LineBasicMaterial): void {
  const edges = new THREE.EdgesGeometry(mesh.geometry, 28);
  mesh.add(new THREE.LineSegments(edges, edgeMat));
}

/**
 * Builds the 4 swappable 3D weapon prop sub-groups pointing along local `-Z`
 * (the character's forward aim axis when `root.rotation.y = yaw`).
 */
function buildWeaponPropModels(
  agentHex: number
): Record<WeaponId, THREE.Group> {
  const bodyMat = new THREE.MeshStandardMaterial({
    color: WEAPON_METAL_HEX,
    metalness: 0.7,
    roughness: 0.32,
  });
  const barrelMat = new THREE.MeshStandardMaterial({
    color: WEAPON_BARREL_HEX,
    metalness: 0.82,
    roughness: 0.24,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: agentHex,
    emissive: agentHex,
    emissiveIntensity: 1.1,
    roughness: 0.2,
  });

  const makeBox = (
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number
  ): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    return m;
  };

  // 1. Pistol — compact slide, grip, and glowing front sight
  const pistol = new THREE.Group();
  pistol.add(makeBox(0.05, 0.055, 0.24, bodyMat, 0, 0.02, -0.10));
  pistol.add(makeBox(0.042, 0.11, 0.06, bodyMat, 0, -0.05, -0.01));
  pistol.add(makeBox(0.054, 0.014, 0.16, accentMat, 0, 0.05, -0.13));

  // 2. SMG — compact receiver, foregrip, and suppressed barrel
  const smg = new THREE.Group();
  smg.add(makeBox(0.06, 0.08, 0.32, bodyMat, 0, 0.01, -0.14));
  smg.add(makeBox(0.04, 0.12, 0.055, bodyMat, 0, -0.07, -0.02));
  smg.add(makeBox(0.036, 0.09, 0.045, bodyMat, 0, -0.055, -0.22));
  const supMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.024, 0.024, 0.18, 10),
    barrelMat
  );
  supMesh.rotation.x = Math.PI * 0.5;
  supMesh.position.set(0, 0.015, -0.39);
  smg.add(supMesh);
  smg.add(makeBox(0.064, 0.016, 0.22, accentMat, 0, 0.045, -0.15));

  // 3. AR — shrouded tactical rifle with optic rail and full stock
  const ar = new THREE.Group();
  ar.add(makeBox(0.062, 0.09, 0.42, bodyMat, 0, 0.01, -0.14));
  ar.add(makeBox(0.05, 0.07, 0.18, bodyMat, 0, 0.0, 0.12));
  ar.add(makeBox(0.038, 0.13, 0.06, bodyMat, 0, -0.08, -0.08));
  const arBarrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.018, 0.28, 10),
    barrelMat
  );
  arBarrel.rotation.x = Math.PI * 0.5;
  arBarrel.position.set(0, 0.02, -0.46);
  ar.add(arBarrel);
  ar.add(makeBox(0.038, 0.045, 0.10, barrelMat, 0, 0.075, -0.10));
  ar.add(makeBox(0.066, 0.018, 0.30, accentMat, 0, 0.025, -0.18));

  // 4. Sniper — long rail barrel, heavy receiver, and large telescopic scope
  const sniper = new THREE.Group();
  sniper.add(makeBox(0.068, 0.095, 0.50, bodyMat, 0, 0.01, -0.16));
  sniper.add(makeBox(0.054, 0.075, 0.22, bodyMat, 0, 0.0, 0.16));
  const railBarrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.022, 0.56, 12),
    barrelMat
  );
  railBarrel.rotation.x = Math.PI * 0.5;
  railBarrel.position.set(0, 0.022, -0.66);
  sniper.add(railBarrel);
  const scopeMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.026, 0.26, 12),
    barrelMat
  );
  scopeMesh.rotation.x = Math.PI * 0.5;
  scopeMesh.position.set(0, 0.09, -0.15);
  sniper.add(scopeMesh);
  sniper.add(makeBox(0.072, 0.016, 0.44, accentMat, 0, 0.024, -0.34));
  sniper.add(makeBox(0.04, 0.09, 0.02, barrelMat, 0.03, -0.05, -0.44));
  sniper.add(makeBox(0.04, 0.09, 0.02, barrelMat, -0.03, -0.05, -0.44));

  return { pistol, smg, ar, sniper };
}

/**
 * Constructs an articulated, sleek 3D humanoid soldier matching Chroma Strike's
 * exact gameplay hitboxes (`body y: 0..1.38`, `head y: 1.38..1.82`).
 *
 * ---------------------------------------------------------------------------
 * Pedagogical Note 1 — Hierarchical Forward Kinematics (4x4 Matrix Transforms)
 * ---------------------------------------------------------------------------
 * Instead of computing world-space vertex positions for every limb manually,
 * Three.js composes a tree of `THREE.Group` transform nodes. Each child's
 * local 4x4 homogeneous matrix `M_local = T * R * S` is multiplied down the
 * parent chain before vertex shading:
 *   `M_world(weapon) = M_root(pos, yaw) * M_bodyTilt(deathX) * M_rightArm(pitch + kick) * M_handOffset`
 *
 * Because `root` sits at the feet `(x, y, z)` facing `-Z` at `yaw`, rotating
 * `bodyTiltGroup` around `y = 0.05` automatically tips the torso, head, legs,
 * arms, and held rifle together as one rigid assembly when an agent falls.
 * Likewise, rotating `rightArmPivot` around the shoulder joint `(0.25, 1.33, 0)`
 * swings the upper arm, forearm, and swapped weapon prop in unison.
 */
export function createCharacterModel(
  scene: THREE.Scene,
  team: TeamId,
  colorId: AgentColorId
): CharacterRig {
  const palette = AGENT_PALETTES[colorId];
  const agentHex = palette.hex;
  const isEnemy = team === 'enemy';
  const armorHex = isEnemy ? ENEMY_ARMOR_HEX : ALLY_ARMOR_HEX;

  // Dedicated per-rig materials so hit-flash and cryo slow tint each character independently.
  const armorMat = new THREE.MeshStandardMaterial({
    color: armorHex,
    emissive: 0x000000,
    emissiveIntensity: 0.0,
    metalness: isEnemy ? 0.48 : 0.34,
    roughness: isEnemy ? 0.42 : 0.32,
  });
  const underSuitMat = new THREE.MeshStandardMaterial({
    color: DARK_JOINT_HEX,
    emissive: 0x000000,
    emissiveIntensity: 0.0,
    metalness: 0.25,
    roughness: 0.65,
  });
  const headMat = new THREE.MeshStandardMaterial({
    color: armorHex,
    emissive: 0x000000,
    emissiveIntensity: 0.0,
    metalness: 0.42,
    roughness: 0.28,
  });
  const glowTrimMat = new THREE.MeshStandardMaterial({
    color: agentHex,
    emissive: agentHex,
    emissiveIntensity: 1.35,
    roughness: 0.18,
    metalness: 0.15,
  });
  const enemyEdgeMat = new THREE.LineBasicMaterial({
    color: ENEMY_EDGE_HEX,
    transparent: true,
    opacity: 0.58,
  });

  const maybeOutline = (mesh: THREE.Mesh): THREE.Mesh => {
    if (isEnemy) {
      addEnemyOutline(mesh, enemyEdgeMat);
    }
    return mesh;
  };

  // Root group anchored at ground-level combatant position `(x, y, z)` and oriented by `yaw`.
  const root = new THREE.Group();

  // Body tilt pivot near the feet (`y = 0.05`) for grounded death collapse rotation.
  const bodyTiltGroup = new THREE.Group();
  bodyTiltGroup.position.set(0, FOOT_PIVOT_Y, 0);
  root.add(bodyTiltGroup);

  const toBodyLocalY = (worldY: number): number => worldY - FOOT_PIVOT_Y;

  // -------------------------------------------------------------------------
  // Legs: Left & Right Hip Pivots at (±0.14, 0.86, 0) reaching y = 0.00
  // -------------------------------------------------------------------------
  function buildLeg(sideSign: -1 | 1): THREE.Group {
    const pivot = new THREE.Group();
    pivot.position.set(sideSign * 0.14, toBodyLocalY(HIP_PIVOT_WORLD_Y), 0);

    // Upper thigh (world y: 0.50 .. 0.86)
    const thigh = maybeOutline(
      new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.36, 0.18), armorMat)
    );
    thigh.position.set(0, -0.18, 0);
    pivot.add(thigh);

    // Knee pad joint accent (world y: 0.44 .. 0.52)
    const knee = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.08, 0.19),
      underSuitMat
    );
    knee.position.set(0, -0.38, -0.015);
    pivot.add(knee);

    // Lower shin (world y: 0.13 .. 0.45)
    const shin = maybeOutline(
      new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.32, 0.16), armorMat)
    );
    shin.position.set(0, -0.57, 0.01);
    pivot.add(shin);

    // Glowing Agent Color outer leg stripe
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.025, 0.28, 0.045),
      glowTrimMat
    );
    stripe.position.set(sideSign * 0.072, -0.56, -0.01);
    pivot.add(stripe);

    // Armored combat boot touching y = 0.00 (local y = -0.81)
    const boot = maybeOutline(
      new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.13, 0.24), underSuitMat)
    );
    boot.position.set(0, -0.745, -0.035);
    pivot.add(boot);

    return pivot;
  }

  const leftLegPivot = buildLeg(-1);
  const rightLegPivot = buildLeg(1);
  bodyTiltGroup.add(leftLegPivot);
  bodyTiltGroup.add(rightLegPivot);

  // -------------------------------------------------------------------------
  // Torso Group: Pelvis belt (y=0.88), Armored chest (y=1.15), Pauldrons (y=1.34)
  // -------------------------------------------------------------------------
  const torsoGroup = new THREE.Group();
  bodyTiltGroup.add(torsoGroup);

  const pelvis = maybeOutline(
    new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.12, 0.24), underSuitMat)
  );
  pelvis.position.set(0, toBodyLocalY(0.88), 0);
  torsoGroup.add(pelvis);

  const beltTrim = new THREE.Mesh(
    new THREE.BoxGeometry(0.40, 0.03, 0.25),
    glowTrimMat
  );
  beltTrim.position.set(0, toBodyLocalY(0.91), 0);
  torsoGroup.add(beltTrim);

  // Mid-abdomen undersuit bridge
  const abdomen = new THREE.Mesh(
    new THREE.BoxGeometry(0.33, 0.14, 0.21),
    underSuitMat
  );
  abdomen.position.set(0, toBodyLocalY(0.99), 0);
  torsoGroup.add(abdomen);

  // Armored chest plate centered at y = 1.15 (spans ~0.95 .. 1.37)
  const chest = maybeOutline(
    new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.36, 0.26), armorMat)
  );
  chest.position.set(0, toBodyLocalY(1.17), 0);
  torsoGroup.add(chest);

  // Glowing Agent Color chest reactor core on -Z front face + spine core on +Z
  const chestCore = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.068, 0),
    glowTrimMat
  );
  chestCore.scale.set(1.15, 1.15, 0.45);
  chestCore.position.set(0, toBodyLocalY(1.19), -0.13);
  torsoGroup.add(chestCore);

  const spineTrim = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.26, 0.03),
    glowTrimMat
  );
  spineTrim.position.set(0, toBodyLocalY(1.18), 0.135);
  torsoGroup.add(spineTrim);

  // Collar guard
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.085, 0.11, 0.08, 10),
    underSuitMat
  );
  collar.position.set(0, toBodyLocalY(1.37), 0);
  torsoGroup.add(collar);

  // Shoulder pauldrons at (±0.26, 1.34, 0) with Agent Color trim
  for (const sideSign of [-1, 1] as const) {
    const pauldron = maybeOutline(
      new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.20), armorMat)
    );
    pauldron.position.set(sideSign * 0.26, toBodyLocalY(1.34), 0);
    pauldron.rotation.z = -sideSign * 0.18;
    torsoGroup.add(pauldron);

    const pauldronTrim = new THREE.Mesh(
      new THREE.BoxGeometry(0.146, 0.028, 0.206),
      glowTrimMat
    );
    pauldronTrim.position.set(sideSign * 0.26, toBodyLocalY(1.37), 0);
    pauldronTrim.rotation.z = -sideSign * 0.18;
    torsoGroup.add(pauldronTrim);
  }

  // -------------------------------------------------------------------------
  // Head Group (world y = 1.60, matching head hitbox y: 1.38 .. 1.82)
  // -------------------------------------------------------------------------
  const headGroup = new THREE.Group();
  headGroup.position.set(0, toBodyLocalY(HEAD_CENTER_WORLD_Y), 0);
  bodyTiltGroup.add(headGroup);

  const helmetSphere = maybeOutline(
    new THREE.Mesh(new THREE.SphereGeometry(0.195, 16, 14), headMat)
  );
  helmetSphere.scale.set(0.94, 1.06, 1.04);
  headGroup.add(helmetSphere);

  // Sleek chin / jaw guard
  const jawGuard = maybeOutline(
    new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.10, 0.22), headMat)
  );
  jawGuard.position.set(0, -0.09, -0.04);
  headGroup.add(jawGuard);

  // Bright horizontal glowing Agent Color visor on -Z front face
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.27, 0.068, 0.08),
    glowTrimMat
  );
  visor.position.set(0, 0.015, -0.17);
  headGroup.add(visor);

  // -------------------------------------------------------------------------
  // Arms & Swappable Weapon Props at (±0.25, 1.33, 0)
  // -------------------------------------------------------------------------
  function buildArm(sideSign: -1 | 1): THREE.Group {
    const armPivot = new THREE.Group();
    armPivot.position.set(sideSign * 0.25, toBodyLocalY(SHOULDER_PIVOT_WORLD_Y), 0);

    // Upper arm angled slightly forward
    const upperArm = maybeOutline(
      new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.25, 0.12), armorMat)
    );
    upperArm.position.set(sideSign * 0.02, -0.12, -0.04);
    upperArm.rotation.x = 0.35;
    armPivot.add(upperArm);

    // Forearm reaching forward along -Z into ready grip
    const forearm = maybeOutline(
      new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.10, 0.26), armorMat)
    );
    forearm.position.set(sideSign * 0.01, -0.22, -0.19);
    armPivot.add(forearm);

    const wristTrim = new THREE.Mesh(
      new THREE.BoxGeometry(0.102, 0.028, 0.06),
      glowTrimMat
    );
    wristTrim.position.set(sideSign * 0.01, -0.22, -0.28);
    armPivot.add(wristTrim);

    const hand = new THREE.Mesh(
      new THREE.BoxGeometry(0.075, 0.075, 0.09),
      underSuitMat
    );
    hand.position.set(0, -0.22, -0.34);
    armPivot.add(hand);

    return armPivot;
  }

  const leftArmPivot = buildArm(-1);
  const rightArmPivot = buildArm(1);
  // Slight inward brace on left arm toward center-chest grip
  leftArmPivot.rotation.y = -0.26;
  bodyTiltGroup.add(leftArmPivot);
  bodyTiltGroup.add(rightArmPivot);

  // Mount swappable weapon models onto the right hand pointing along -Z
  const weaponSocket = new THREE.Group();
  weaponSocket.position.set(-0.02, -0.20, -0.36);
  rightArmPivot.add(weaponSocket);

  const weaponProps = buildWeaponPropModels(agentHex);
  for (const id of ['pistol', 'smg', 'ar', 'sniper'] as const) {
    weaponProps[id].visible = id === 'ar';
    weaponSocket.add(weaponProps[id]);
  }

  // -------------------------------------------------------------------------
  // Overhead Indicators (Children of `root`, never tilted on death)
  // -------------------------------------------------------------------------
  const healthBarGroup = new THREE.Group();
  healthBarGroup.position.set(0, HEALTH_BAR_Y, 0);

  const barBgMat = new THREE.MeshBasicMaterial({
    color: 0x0b0e14,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
  });
  const barBgMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(HEALTH_BAR_WIDTH + 0.12, HEALTH_BAR_HEIGHT + 0.04),
    barBgMat
  );
  healthBarGroup.add(barBgMesh);

  // Crisp team indicator pip on left edge of health bar
  const teamBadgeMat = new THREE.MeshBasicMaterial({
    color: isEnemy ? 0xff3b5c : 0x00d2ff,
    side: THREE.DoubleSide,
  });
  const teamBadge = new THREE.Mesh(
    new THREE.PlaneGeometry(0.07, HEALTH_BAR_HEIGHT + 0.01),
    teamBadgeMat
  );
  teamBadge.position.set(-HEALTH_BAR_WIDTH * 0.5 - 0.015, 0, 0.006);
  healthBarGroup.add(teamBadge);

  // Left-anchored fill bar so `scale.x` drains smoothly left-to-right
  const barFillGeo = new THREE.PlaneGeometry(HEALTH_BAR_WIDTH - 0.06, HEALTH_BAR_HEIGHT);
  barFillGeo.translate((HEALTH_BAR_WIDTH - 0.06) * 0.5, 0, 0);
  const healthFillMat = new THREE.MeshBasicMaterial({
    color: isEnemy ? 0xff3b5c : 0x2ecc71,
    side: THREE.DoubleSide,
  });
  const healthFillMesh = new THREE.Mesh(barFillGeo, healthFillMat);
  healthFillMesh.position.set(-HEALTH_BAR_WIDTH * 0.5 + 0.04, 0, 0.006);
  healthBarGroup.add(healthFillMesh);
  root.add(healthBarGroup);

  // Spinning emerald-white blind halo at y = 2.24
  const blindHaloMat = new THREE.MeshBasicMaterial({
    color: 0xc8ffe0,
    side: THREE.DoubleSide,
  });
  const blindHaloMesh = new THREE.Mesh(
    new THREE.TorusGeometry(0.28, 0.026, 6, 10),
    blindHaloMat
  );
  blindHaloMesh.position.set(0, BLIND_HALO_Y, 0);
  blindHaloMesh.rotation.x = Math.PI * 0.42;
  blindHaloMesh.visible = false;
  root.add(blindHaloMesh);

  scene.add(root);

  // -------------------------------------------------------------------------
  // Animation & Visual State
  // -------------------------------------------------------------------------
  let gaitPhase = 0;
  let recoilKick = 0;
  let hitFlashTimer = 0;
  let lastHitWasHeadshot = false;
  let wasAlive = true;

  function setWeaponModel(weaponId: WeaponId): void {
    for (const id of ['pistol', 'smg', 'ar', 'sniper'] as const) {
      weaponProps[id].visible = id === weaponId;
    }
  }

  function triggerFireKick(): void {
    recoilKick = 0.28;
  }

  function triggerHitFlash(isHeadshot: boolean): void {
    hitFlashTimer = HIT_FLASH_DURATION_SEC;
    lastHitWasHeadshot = isHeadshot;
  }

  function setVisible(visible: boolean): void {
    root.visible = visible;
  }

  function update(
    dt: number,
    state: {
      position: Vec3;
      velocity: Vec3;
      yaw: number;
      pitch: number;
      health: number;
      maxHealth: number;
      alive: boolean;
      slowTimer: number;
      blindTimer: number;
      occludedBySmoke: boolean;
    },
    cameraPos: Vec3
  ): void {
    const stepDt = Math.max(0, dt);

    root.position.set(state.position.x, state.position.y, state.position.z);
    root.rotation.y = state.yaw;

    // -----------------------------------------------------------------------
    // Pedagogical Note 2 — Death Tilt Interpolation
    // -----------------------------------------------------------------------
    // Because `bodyTiltGroup` is pivoted near the soles (`y = 0.05`), lerping
    // `rotation.x` toward `-Math.PI * 0.48` via exponential smoothing:
    //   `theta += (target - theta) * (1 - e^(-k * dt))`
    // topples the entire rig forward onto the arena floor in a frame-rate-
    // independent arc without sinking the torso beneath `y = 0`.
    // When respawning (`!wasAlive && state.alive`), we snap immediately to `0`.
    if (!state.alive) {
      wasAlive = false;
      const collapseAlpha = 1 - Math.exp(-10 * stepDt);
      bodyTiltGroup.rotation.x +=
        (DEATH_TILT_TARGET_RAD - bodyTiltGroup.rotation.x) * collapseAlpha;

      healthBarGroup.visible = false;
      blindHaloMesh.visible = false;
      return;
    }

    if (!wasAlive) {
      wasAlive = true;
      bodyTiltGroup.rotation.x = 0;
      gaitPhase = 0;
      recoilKick = 0;
      hitFlashTimer = 0;
    } else {
      bodyTiltGroup.rotation.x *= Math.exp(-14 * stepDt);
    }

    // -----------------------------------------------------------------------
    // Pedagogical Note 3 — Anti-Phase Sinusoidal Walk Gait
    // -----------------------------------------------------------------------
    // Human bipedal locomotion swings opposite legs `pi` radians out of phase:
    //   `theta_left  = +sin(phi) * A`
    //   `theta_right = -sin(phi) * A = sin(phi + pi) * A`
    // Amplitude `A = min(1, horizSpeed / 8.2) * 0.62` scales stride angle
    // smoothly with ground speed and drops to `0` when stationary or airborne
    // (`|vy| > 0.35`), damping both hips cleanly back to vertical neutral.
    const horizSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    const isAirborne = Math.abs(state.velocity.y) > 0.35;
    const strideAmp =
      horizSpeed >= 0.25 && !isAirborne
        ? Math.min(1, horizSpeed / MAX_WALK_SPEED_MPS) * MAX_STRIDE_AMP_RAD
        : 0;

    if (strideAmp > 0) {
      gaitPhase += stepDt * (4.2 + horizSpeed * 1.15);
      const legAngle = Math.sin(gaitPhase) * strideAmp;
      leftLegPivot.rotation.x = legAngle;
      rightLegPivot.rotation.x = -legAngle;
    } else {
      const relax = Math.exp(-14 * stepDt);
      leftLegPivot.rotation.x *= relax;
      rightLegPivot.rotation.x *= relax;
    }

    // Arm aim pitch + decaying weapon recoil kick
    recoilKick *= Math.exp(-16 * stepDt);
    const armPitch = state.pitch * 0.55 + recoilKick;
    rightArmPivot.rotation.x = armPitch;
    leftArmPivot.rotation.x = armPitch;
    headGroup.rotation.x = state.pitch * 0.38;

    // Hit flash (0.10s white) -> Cryo slow (icy cyan) -> default armor emissive
    if (hitFlashTimer > 0) {
      hitFlashTimer = Math.max(0, hitFlashTimer - stepDt);
      armorMat.emissive.setHex(0xffffff);
      headMat.emissive.setHex(0xffffff);
      armorMat.emissiveIntensity = lastHitWasHeadshot ? 0.6 : 0.95;
      headMat.emissiveIntensity = lastHitWasHeadshot ? 1.45 : 0.75;
    } else if (state.slowTimer > 0) {
      armorMat.emissive.setHex(0x00d2ff);
      headMat.emissive.setHex(0x00d2ff);
      armorMat.emissiveIntensity = 0.52;
      headMat.emissiveIntensity = 0.48;
    } else {
      armorMat.emissive.setHex(0x000000);
      headMat.emissive.setHex(0x000000);
      armorMat.emissiveIntensity = 0.0;
      headMat.emissiveIntensity = 0.0;
    }

    // Overhead health bar & blind halo (hidden when dead or occluded by smoke)
    const showOverhead = !state.occludedBySmoke;
    healthBarGroup.visible = showOverhead;

    if (showOverhead) {
      const hpRatio = Math.max(
        0,
        Math.min(1, state.maxHealth > 0 ? state.health / state.maxHealth : 0)
      );
      healthFillMesh.scale.x = hpRatio;

      if (isEnemy) {
        healthFillMat.color.setHex(0xff3b5c);
      } else if (hpRatio > 0.5) {
        healthFillMat.color.setHex(0x2ecc71);
      } else if (hpRatio > 0.25) {
        healthFillMat.color.setHex(0x00d2ff);
      } else {
        healthFillMat.color.setHex(0xff4d4d);
      }

      healthBarGroup.lookAt(cameraPos.x, cameraPos.y, cameraPos.z);

      if (state.blindTimer > 0) {
        blindHaloMesh.visible = true;
        blindHaloMesh.rotation.z += stepDt * 6.0;
        blindHaloMesh.rotation.y += stepDt * 3.5;
      } else {
        blindHaloMesh.visible = false;
      }
    } else {
      blindHaloMesh.visible = false;
    }
  }

  function dispose(targetScene: THREE.Scene): void {
    targetScene.remove(root);
    root.traverse((node) => {
      if (
        node instanceof THREE.Mesh ||
        node instanceof THREE.LineSegments ||
        node instanceof THREE.Line ||
        node instanceof THREE.Points
      ) {
        node.geometry.dispose();
        if (Array.isArray(node.material)) {
          for (const mat of node.material) {
            mat.dispose();
          }
        } else if (node.material) {
          node.material.dispose();
        }
      }
    });
  }

  return {
    root,
    setWeaponModel,
    triggerFireKick,
    triggerHitFlash,
    setVisible,
    update,
    dispose,
  };
}
