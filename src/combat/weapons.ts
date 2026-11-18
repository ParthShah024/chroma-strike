import * as THREE from 'three';
import {
  AABB,
  AGENT_PALETTES,
  AgentColorId,
  InputState,
  PlayerState,
  RaycastHit,
  ShotResult,
  Vec3,
  WeaponId,
  WeaponState,
} from '../core/types';
import {
  EYE_HEIGHT,
  RUN_SPEED,
  getHorizontalSpeed,
  getLookDirection,
  raycastAABB,
} from '../physics/movement';
import { WEAPON_ORDER, WEAPON_SPECS, computeWeaponDamage } from './arsenal';
import { TargetsManager } from './targets';

/**
 * Public interface for the player's multi-weapon hitscan arsenal controller.
 */
export interface WeaponSystem {
  state: WeaponState;
  currentWeaponId: WeaponId;
  isScoped: boolean;
  equipWeapon(weaponId: WeaponId): void;
  cycleWeapon(delta: number): void;
  toggleScope(forceState?: boolean): void;
  resetForRound(weaponId?: WeaponId): void;
  setViewmodelVisible(visible: boolean): void;
  setAgentColor(colorId: AgentColorId): void;
  spawnWorldTracer(
    origin: Vec3,
    endPoint: Vec3,
    hitNormal: Vec3 | null,
    colorHex: number,
    isHeadshot: boolean,
  ): void;
  update(
    dt: number,
    player: PlayerState,
    input: InputState,
    colliders: AABB[],
    targetsMgr: TargetsManager,
    fireRateMultiplier?: number,
    recoilMultiplier?: number,
    moveSpreadMultiplier?: number,
    eyeHeightOffset?: number,
  ): ShotResult;
}

const MAX_RAY_DISTANCE = 200;
const TRACER_LIFETIME_SEC = 0.12;
const MAX_RECOIL_ACCUMULATOR = 1.2;
const RECOIL_DECAY_RATE = 2.8;
const WALL_TUCK_CHECK_DIST = 0.95;
const WALL_TUCK_MIN_DIST = 0.4;
const WALL_TUCK_MAX_Z = 0.34;

/** Base resting position of the FPS weapon viewmodel in camera-local space. */
const VIEWMODEL_BASE_POS = new THREE.Vector3(0.28, -0.24, -0.48);

interface ActiveTracer {
  line: THREE.Line;
  lineGeo: THREE.BufferGeometry;
  lineMat: THREE.LineBasicMaterial;
  beam: THREE.Mesh | null;
  beamGeo: THREE.CylinderGeometry | null;
  beamMat: THREE.MeshBasicMaterial | null;
  ring: THREE.Mesh | null;
  ringGeo: THREE.RingGeometry | null;
  ringMat: THREE.MeshBasicMaterial | null;
  age: number;
  lifetime: number;
}

interface WeaponModelRig {
  group: THREE.Group;
  muzzleLocalPos: THREE.Vector3;
  basePos: THREE.Vector3;
  adsPos: THREE.Vector3;
}

/**
 * First-person glove/gauntlet colours. Matches `AGENT_STYLE` in
 * `entities/characterModel.ts` so the forearms you see in 1st person are the
 * same vivid armour hue + neon trim your 3rd-person agent wears.
 */
const VIEWMODEL_GLOVE_STYLE: Record<AgentColorId, { primary: number; trim: number }> = {
  red: { primary: 0xff2244, trim: 0xff6b85 }, // Blaze
  blue: { primary: 0x00a8ff, trim: 0x6ce8ff }, // Mist
  green: { primary: 0x10d464, trim: 0x7dffb3 }, // Pulse
  violet: { primary: 0xa23cff, trim: 0xdcb0ff }, // Umbra
  gold: { primary: 0xffbf00, trim: 0xfff27a }, // Volt
};

interface HandMaterials {
  /** Dark carbon-fibre glove shell. */
  glove: THREE.Material;
  /** Slightly lighter armoured knuckle caps / finger segments. */
  knuckle: THREE.Material;
  /** Agent-coloured gauntlet armour (`handArmorMat`). */
  armor: THREE.Material;
  /** Neon cuff / strip trim (`handTrimMat`). */
  trim: THREE.Material;
}

function addPart(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

/**
 * Hand wrapped around a vertical grip (pistol grip or vertical foregrip).
 * Frame: grip axis = local +Y, barrel = -Z, grip centred at the origin.
 * `side = +1` builds a RIGHT hand (back of hand on +X, thumb wrapping the -X
 * face); `side = -1` mirrors it into a LEFT hand.
 */
function buildGripHand(
  mats: HandMaterials,
  side: 1 | -1,
  halfWidth: number,
  halfDepth: number,
): THREE.Group {
  const hand = new THREE.Group();
  const w = halfWidth;
  const d = halfDepth;

  // Back of the hand on the outer face + armoured knuckle guard.
  addPart(hand, new THREE.BoxGeometry(0.02, 0.074, 0.06), mats.glove, side * (w + 0.01), -0.006, 0.004);
  addPart(hand, new THREE.BoxGeometry(0.007, 0.062, 0.024), mats.armor, side * (w + 0.022), -0.004, -0.014);
  // Palm heel wrapping the backstrap + thumb web on the top-rear.
  addPart(hand, new THREE.BoxGeometry(2 * w + 0.016, 0.064, 0.018), mats.glove, side * 0.004, -0.01, d + 0.008);
  const web = addPart(hand, new THREE.SphereGeometry(0.015, 10, 8), mats.glove, -side * w * 0.3, 0.03, d + 0.004);
  web.scale.set(1.25, 0.8, 1.0);

  // Four curled fingers wrapping across the front strap, index on top.
  const fingerSpan = [0.96, 1.0, 0.95, 0.8];
  for (let i = 0; i < 4; i++) {
    const y = 0.02 - i * 0.0185;
    const span = (2 * w + 0.012) * fingerSpan[i];
    const finger = addPart(
      hand,
      new THREE.CapsuleGeometry(0.0085, span, 3, 8),
      mats.glove,
      side * (w + 0.008 - span / 2),
      y,
      -(d + 0.008),
    );
    finger.rotation.z = Math.PI / 2;
    // Fingertip segment curling back along the far face.
    const tip = addPart(
      hand,
      new THREE.CapsuleGeometry(0.0078, 0.012, 3, 8),
      mats.glove,
      side * (w + 0.006 - span),
      y,
      -d + 0.004,
    );
    tip.rotation.x = Math.PI / 2;
    // Armoured knuckle cap where the finger leaves the back of the hand.
    addPart(hand, new THREE.BoxGeometry(0.012, 0.014, 0.013), mats.knuckle, side * (w + 0.013), y, -(d + 0.003));
  }

  // Thumb wrapping the inner face, angled forward-down.
  const thumb = addPart(hand, new THREE.CapsuleGeometry(0.0095, 0.034, 3, 8), mats.glove, -side * (w + 0.008), 0.024, 0.002);
  thumb.rotation.x = Math.PI / 2 + 0.35;
  addPart(hand, new THREE.BoxGeometry(0.004, 0.01, 0.022), mats.trim, -side * (w + 0.018), 0.022, 0.0);

  return hand;
}

/**
 * Support hand cradling a horizontal handguard from below.
 * Frame: handguard axis = local Z, handguard centred at the origin.
 * `side = -1` = LEFT hand (thumb along the -X face, fingers curling up +X).
 */
function buildCradleHand(
  mats: HandMaterials,
  side: 1 | -1,
  halfWidth: number,
  halfHeight: number,
): THREE.Group {
  const hand = new THREE.Group();
  const w = halfWidth;
  const h = halfHeight;

  // Palm under the handguard + armoured back-of-hand plate below it.
  addPart(hand, new THREE.BoxGeometry(2 * w + 0.014, 0.018, 0.074), mats.glove, 0, -h - 0.009, 0.004);
  addPart(hand, new THREE.BoxGeometry(2 * w * 0.8, 0.006, 0.05), mats.armor, 0, -h - 0.021, 0.008);
  const thumbBase = addPart(hand, new THREE.SphereGeometry(0.016, 10, 8), mats.glove, side * (w + 0.002), -h - 0.004, 0.026);
  thumbBase.scale.set(0.9, 0.8, 1.3);

  // Fingers curl up the far face.
  for (let i = 0; i < 4; i++) {
    const z = -0.03 + i * 0.019;
    const len = i === 3 ? 0.02 : 0.026;
    const finger = addPart(
      hand,
      new THREE.CapsuleGeometry(0.0082, len, 3, 8),
      mats.glove,
      -side * (w + 0.008),
      -h + 0.008,
      z,
    );
    finger.rotation.z = side * 0.18; // tips curl in toward the handguard
    addPart(hand, new THREE.BoxGeometry(0.013, 0.012, 0.012), mats.knuckle, -side * (w + 0.006), -h - 0.008, z);
  }

  // Thumb laid forward along the near face.
  const thumb = addPart(hand, new THREE.CapsuleGeometry(0.0092, 0.04, 3, 8), mats.glove, side * (w + 0.008), -h * 0.3, -0.008);
  thumb.rotation.x = Math.PI / 2 - 0.2;
  addPart(hand, new THREE.BoxGeometry(0.004, 0.009, 0.026), mats.trim, side * (w + 0.018), -h * 0.3, -0.006);

  return hand;
}

/**
 * Armoured forearm gauntlet running from `wrist` to `elbow` (weapon-local
 * space): carbon undersleeve, Agent-coloured shell + dorsal ridge, and neon
 * cuff rings / side strip.
 */
function buildForearm(
  mats: HandMaterials,
  side: 1 | -1,
  wrist: THREE.Vector3,
  elbow: THREE.Vector3,
): THREE.Group {
  const arm = new THREE.Group();
  arm.position.copy(wrist);
  const dir = new THREE.Vector3().subVectors(elbow, wrist);
  const len = Math.max(0.12, dir.length());
  dir.normalize();
  arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir); // local +Z = toward elbow

  // CylinderGeometry axis is +Y; rotateX(+PI/2) maps +Y -> +Z, so radiusTop sits at the elbow end.
  const cuffGeo = new THREE.CylinderGeometry(0.031, 0.03, 0.04, 14);
  cuffGeo.rotateX(Math.PI / 2);
  addPart(arm, cuffGeo, mats.glove, 0, 0, 0.012);

  const sleeveGeo = new THREE.CylinderGeometry(0.041, 0.032, len, 14);
  sleeveGeo.rotateX(Math.PI / 2);
  addPart(arm, sleeveGeo, mats.glove, 0, 0, len / 2);

  // Partial shell covering top + outer flanks (theta centred on PI = local +Y after rotation).
  const shellLen = len * 0.72;
  const shellGeo = new THREE.CylinderGeometry(0.047, 0.038, shellLen, 16, 1, false, Math.PI - 1.45, 2.9);
  shellGeo.rotateX(Math.PI / 2);
  addPart(arm, shellGeo, mats.armor, 0, 0, 0.05 + shellLen / 2);
  addPart(arm, new THREE.BoxGeometry(0.016, 0.01, len * 0.55), mats.armor, 0, 0.046, 0.06 + len * 0.3);

  // Neon cuff rings (TorusGeometry lies in XY = wraps the local Z axis) + side strip.
  addPart(arm, new THREE.TorusGeometry(0.04, 0.005, 6, 20), mats.trim, 0, 0, 0.05);
  addPart(arm, new THREE.TorusGeometry(0.047, 0.004, 6, 20), mats.trim, 0, 0, 0.05 + shellLen);
  addPart(arm, new THREE.BoxGeometry(0.004, 0.006, len * 0.5), mats.trim, side * 0.043, 0.002, 0.08 + len * 0.25);

  return arm;
}

/**
 * Attaches a hand (already positioned/rotated in weapon-local space) plus its
 * forearm gauntlet. `wristLocal` is the wrist point in the hand's own frame;
 * it is transformed into weapon space so the gauntlet meets the glove exactly.
 */
function attachArm(
  weapon: THREE.Group,
  hand: THREE.Group,
  mats: HandMaterials,
  side: 1 | -1,
  wristLocal: THREE.Vector3,
  elbow: THREE.Vector3,
): void {
  weapon.add(hand);
  hand.updateMatrix();
  const wrist = wristLocal.clone().applyMatrix4(hand.matrix);
  weapon.add(buildForearm(mats, side, wrist, elbow));
}

/**
 * Builds the 4-weapon hitscan controller (`pistol`, `smg`, `ar`, `sniper`),
 * distinct first-person procedural 3D viewmodels, optical ADS/scope logic, and
 * shared 3D tracer/impact pool (used by both the player and AI combatants).
 *
 * Key Tactical FPS Mechanics Implemented Here:
 *
 * 1. **Semi-Auto vs. Full-Auto Trigger Gating**:
 *    - Full-auto weapons (`smg`, `ar`, `spec.automatic === true`) fire continuously
 *      whenever `input.fire` is held down and `state.fireTimer <= 0`.
 *    - Semi-auto weapons (`pistol`, `sniper`, `spec.automatic === false`) use
 *      edge-triggered gating (`input.fireJustPressed === true`). Holding down
 *      left-click will NEVER auto-repeat shots; the player must release and click
 *      again for each shot, enforcing deliberate trigger discipline.
 *
 * 2. **Optical Zoom Spread & Mobility Tradeoffs**:
 *    - Each weapon defines both `baseSpreadRad` (hipfire) and `scopedSpreadRad`
 *      (when `isScoped` is true). For example, the Rail Sniper has wide hipfire
 *      bloom (`0.085 rad`) when un-scoped, rewarding quick-scoping or holding
 *      angles where `scopedSpreadRad` drops to `0.000 rad` (pinpoint accurate).
 *    - Stationary accuracy (`horizontalSpeed < 0.45 && grounded`) zeroes out the
 *      movement penalty `(horizontalSpeed / RUN_SPEED) * spec.moveSpreadRad`,
 *      rewarding sharp counter-strafes across all 4 weapons.
 *
 * 3. **Per-Weapon Persistent Magazines**:
 *    - Swapping between slots `1..4` preserves each weapon's remaining ammo in
 *      `ammoByWeapon` and cancels any in-progress reload or scope state; calling
 *      `resetForRound()` refills all 4 magazines for the new round.
 */
export function createWeaponSystem(
  camera: THREE.PerspectiveCamera,
  scene: THREE.Scene,
  initialColor: AgentColorId,
): WeaponSystem {
  let activeColorId: AgentColorId = initialColor;
  let currentWeaponId: WeaponId = 'ar';
  let isScoped = false;
  let viewmodelVisible = true;

  const ammoByWeapon: Record<WeaponId, number> = {
    pistol: WEAPON_SPECS.pistol.maxAmmo,
    smg: WEAPON_SPECS.smg.maxAmmo,
    ar: WEAPON_SPECS.ar.maxAmmo,
    sniper: WEAPON_SPECS.sniper.maxAmmo,
  };

  const state: WeaponState = {
    ammo: ammoByWeapon[currentWeaponId],
    maxAmmo: WEAPON_SPECS[currentWeaponId].maxAmmo,
    fireTimer: 0,
    reloading: false,
    reloadTimer: 0,
    recoilAccumulator: 0,
    currentSpread: 0,
  };

  // --- First-person geometric weapon viewmodels attached to the camera ---
  const weaponGroup = new THREE.Group();
  weaponGroup.position.copy(VIEWMODEL_BASE_POS);

  const gunMetalMat = new THREE.MeshStandardMaterial({
    color: 0x1b212e,
    roughness: 0.35,
    metalness: 0.75,
  });
  const gunDarkMat = new THREE.MeshStandardMaterial({
    color: 0x10141c,
    roughness: 0.55,
    metalness: 0.5,
  });
  const gunSteelMat = new THREE.MeshStandardMaterial({
    color: 0x2b3447,
    roughness: 0.28,
    metalness: 0.85,
  });
  const scopeGlassMat = new THREE.MeshStandardMaterial({
    color: 0x0d1b2a,
    emissive: 0x0b3a55,
    emissiveIntensity: 0.45,
    roughness: 0.1,
    metalness: 0.9,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: AGENT_PALETTES[activeColorId].hex,
    emissive: AGENT_PALETTES[activeColorId].hex,
    emissiveIntensity: 0.9,
    roughness: 0.25,
    metalness: 0.2,
  });

  // Tactician glove + gauntlet materials (recoloured live in setAgentColor).
  const initialGlove = VIEWMODEL_GLOVE_STYLE[activeColorId];
  const gloveMat = new THREE.MeshStandardMaterial({
    color: 0x151922,
    roughness: 0.62,
    metalness: 0.38,
  });
  const gloveKnuckleMat = new THREE.MeshStandardMaterial({
    color: 0x262d3b,
    roughness: 0.45,
    metalness: 0.55,
  });
  const handArmorMat = new THREE.MeshStandardMaterial({
    color: initialGlove.primary,
    emissive: initialGlove.primary,
    emissiveIntensity: 0.25,
    roughness: 0.34,
    metalness: 0.3,
    side: THREE.DoubleSide, // partial gauntlet shell reads solid from inside
  });
  const handTrimMat = new THREE.MeshStandardMaterial({
    color: initialGlove.trim,
    emissive: initialGlove.trim,
    emissiveIntensity: 1.25,
    roughness: 0.2,
    metalness: 0.1,
  });
  const handMats: HandMaterials = {
    glove: gloveMat,
    knuckle: gloveKnuckleMat,
    armor: handArmorMat,
    trim: handTrimMat,
  };
  // Illuminated holo/reflex sight ring + faint tinted lens (SMG & AR).
  const holoRingMat = new THREE.MeshBasicMaterial({ color: AGENT_PALETTES[activeColorId].hex });
  const holoLensMat = new THREE.MeshBasicMaterial({
    color: AGENT_PALETTES[activeColorId].hex,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  // 1) Pistol sub-group: compact slide + angled grip + trigger guard
  const pistolGroup = new THREE.Group();
  const pistolSlide = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.044, 0.22), gunMetalMat);
  pistolSlide.position.set(0, 0.018, -0.04);
  pistolGroup.add(pistolSlide);

  const pistolFrame = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.024, 0.19), gunDarkMat);
  pistolFrame.position.set(0, -0.014, -0.03);
  pistolGroup.add(pistolFrame);

  const pistolGrip = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.11, 0.052), gunDarkMat);
  pistolGrip.position.set(0, -0.068, 0.035);
  pistolGrip.rotation.x = -0.24;
  pistolGroup.add(pistolGrip);

  const pistolAccent = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.01, 0.16), accentMat);
  pistolAccent.position.set(0, 0.035, -0.045);
  pistolGroup.add(pistolAccent);

  // 2) SMG sub-group: compact receiver + vertical foregrip + cylindrical suppressor
  const smgGroup = new THREE.Group();
  const smgReceiver = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.072, 0.26), gunMetalMat);
  smgGroup.add(smgReceiver);

  const smgSuppressor = new THREE.Mesh(
    new THREE.CylinderGeometry(0.021, 0.021, 0.2, 12),
    gunDarkMat,
  );
  smgSuppressor.rotation.x = Math.PI * 0.5;
  smgSuppressor.position.set(0, 0.01, -0.22);
  smgGroup.add(smgSuppressor);

  const smgForegrip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.085, 0.034), gunDarkMat);
  smgForegrip.position.set(0, -0.068, -0.09);
  smgForegrip.rotation.x = -0.1;
  smgGroup.add(smgForegrip);

  const smgMag = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.115, 0.045), gunSteelMat);
  smgMag.position.set(0, -0.082, 0.01);
  smgMag.rotation.x = 0.15;
  smgGroup.add(smgMag);

  const smgOptic = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.026, 0.065), gunDarkMat);
  smgOptic.position.set(0, 0.048, 0.01);
  smgGroup.add(smgOptic);

  const smgAccent = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.012, 0.21), accentMat);
  smgAccent.position.set(0, 0.02, -0.02);
  smgGroup.add(smgAccent);

  // 3) AR sub-group: shrouded Pulse Rifle + angled magazine + holo optic
  const arGroup = new THREE.Group();
  const arReceiver = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.085, 0.36), gunMetalMat);
  arGroup.add(arReceiver);

  const arBarrel = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.032, 0.34), gunDarkMat);
  arBarrel.position.set(0, 0.015, -0.31);
  arGroup.add(arBarrel);

  const arMagazine = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.13, 0.065), gunDarkMat);
  arMagazine.position.set(0, -0.095, -0.05);
  arMagazine.rotation.x = 0.22;
  arGroup.add(arMagazine);

  const arOptic = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.032, 0.08), gunDarkMat);
  arOptic.position.set(0, 0.056, 0.02);
  arGroup.add(arOptic);

  const arAccent = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.014, 0.28), accentMat);
  arAccent.position.set(0, 0.028, -0.06);
  arGroup.add(arAccent);

  // 4) Sniper sub-group: long rail barrel + large telescopic scope + folded bipod
  const sniperGroup = new THREE.Group();
  const sniperChassis = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.088, 0.44), gunMetalMat);
  sniperChassis.position.set(0, 0, 0.02);
  sniperGroup.add(sniperChassis);

  const sniperBarrel = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.03, 0.56), gunSteelMat);
  sniperBarrel.position.set(0, 0.016, -0.46);
  sniperGroup.add(sniperBarrel);

  const sniperScopeTube = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.28, 14),
    gunDarkMat,
  );
  sniperScopeTube.rotation.x = Math.PI * 0.5;
  sniperScopeTube.position.set(0, 0.072, -0.04);
  sniperGroup.add(sniperScopeTube);

  const sniperScopeBell = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.024, 0.07, 14),
    gunDarkMat,
  );
  sniperScopeBell.rotation.x = Math.PI * 0.5;
  sniperScopeBell.position.set(0, 0.072, -0.19);
  sniperGroup.add(sniperScopeBell);

  const sniperLens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.027, 0.027, 0.012, 14),
    scopeGlassMat,
  );
  sniperLens.rotation.x = Math.PI * 0.5;
  sniperLens.position.set(0, 0.072, -0.222);
  sniperGroup.add(sniperLens);

  const sniperBipodL = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.016, 0.18), gunDarkMat);
  sniperBipodL.position.set(-0.034, -0.022, -0.34);
  sniperGroup.add(sniperBipodL);

  const sniperBipodR = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.016, 0.18), gunDarkMat);
  sniperBipodR.position.set(0.034, -0.022, -0.34);
  sniperGroup.add(sniperBipodR);

  const sniperAccent = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.012, 0.42), accentMat);
  sniperAccent.position.set(0, 0.024, -0.16);
  sniperGroup.add(sniperAccent);

  // --- V3 viewmodel finish: pistol grips, trigger guards, holo rings, fluted rail barrel ---
  const addTriggerGuard = (group: THREE.Group, y: number, z: number, length: number): void => {
    addPart(group, new THREE.BoxGeometry(0.008, 0.006, length), gunSteelMat, 0, y, z);
    addPart(group, new THREE.BoxGeometry(0.008, 0.024, 0.006), gunSteelMat, 0, y + 0.012, z - length / 2);
  };
  addTriggerGuard(pistolGroup, -0.042, -0.006, 0.042);

  const smgGrip = addPart(smgGroup, new THREE.BoxGeometry(0.03, 0.09, 0.04), gunDarkMat, 0, -0.075, 0.085);
  smgGrip.rotation.x = -0.22;
  addTriggerGuard(smgGroup, -0.052, 0.052, 0.036);

  const arGrip = addPart(arGroup, new THREE.BoxGeometry(0.032, 0.095, 0.045), gunDarkMat, 0, -0.085, 0.11);
  arGrip.rotation.x = -0.24;
  addTriggerGuard(arGroup, -0.058, 0.058, 0.05);
  addPart(arGroup, new THREE.BoxGeometry(0.052, 0.05, 0.2), gunDarkMat, 0, 0.008, -0.27); // handguard
  for (let i = 0; i < 4; i++) {
    for (const s of [-1, 1]) {
      // glowing handguard cooling vents
      addPart(arGroup, new THREE.BoxGeometry(0.002, 0.008, 0.026), accentMat, s * 0.0265, 0.012, -0.33 + i * 0.04);
    }
  }

  const sniperGrip = addPart(sniperGroup, new THREE.BoxGeometry(0.032, 0.095, 0.045), gunDarkMat, 0, -0.088, 0.13);
  sniperGrip.rotation.x = -0.24;
  addTriggerGuard(sniperGroup, -0.06, 0.076, 0.05);

  // Holo/reflex sights: illuminated ring + tinted lens + reticle dot on top of each optic.
  const addHoloSight = (group: THREE.Group, y: number, z: number, radius: number): void => {
    addPart(group, new THREE.BoxGeometry(radius * 2.4, 0.008, 0.012), gunDarkMat, 0, y - radius - 0.002, z);
    addPart(group, new THREE.TorusGeometry(radius, 0.0028, 8, 24), holoRingMat, 0, y, z);
    addPart(group, new THREE.CircleGeometry(radius * 0.95, 20), holoLensMat, 0, y, z);
    addPart(group, new THREE.SphereGeometry(0.0022, 6, 6), holoRingMat, 0, y, z - 0.001);
  };
  addHoloSight(smgGroup, 0.077, -0.005, 0.014);
  addHoloSight(arGroup, 0.091, 0.0, 0.017);

  // Sniper: fluted barrel grooves, slotted muzzle brake, top rail + glowing chassis vents.
  for (const s of [-1, 1]) {
    for (const dy of [-0.006, 0.006]) {
      addPart(sniperGroup, new THREE.BoxGeometry(0.003, 0.004, 0.42), gunDarkMat, s * 0.0145, 0.016 + dy, -0.47);
    }
  }
  addPart(sniperGroup, new THREE.BoxGeometry(0.04, 0.036, 0.05), gunDarkMat, 0, 0.016, -0.745);
  for (let i = 0; i < 3; i++) {
    for (const s of [-1, 1]) {
      addPart(sniperGroup, new THREE.BoxGeometry(0.002, 0.026, 0.006), accentMat, s * 0.0205, 0.016, -0.76 + i * 0.014);
    }
  }
  for (let i = 0; i < 7; i++) {
    addPart(sniperGroup, new THREE.BoxGeometry(0.046, 0.005, 0.012), gunSteelMat, 0, 0.0465, -0.18 + i * 0.05);
  }
  for (const z of [-0.12, 0.04]) {
    addPart(sniperGroup, new THREE.BoxGeometry(0.03, 0.02, 0.02), gunSteelMat, 0, 0.056, z); // scope rings
  }
  for (let i = 0; i < 4; i++) {
    for (const s of [-1, 1]) {
      addPart(sniperGroup, new THREE.BoxGeometry(0.002, 0.006, 0.028), accentMat, s * 0.0315, -0.012, -0.18 + i * 0.04);
    }
  }

  // --- 5) 1st-person Tactician hands + Agent-coloured forearm gauntlets ---
  // Right hand: wraps the pistol grip; forearm exits toward the lower-right.
  // Left hand: foregrip / handguard (or cups the right hand on the pistol);
  // forearm exits toward the lower-left (-X, -Y, +Z) like Valorant / CS2.
  const placeGripHand = (
    group: THREE.Group,
    side: 1 | -1,
    halfWidth: number,
    halfDepth: number,
    pos: THREE.Vector3,
    tiltX: number,
    elbow: THREE.Vector3,
  ): void => {
    const hand = buildGripHand(handMats, side, halfWidth, halfDepth);
    hand.position.copy(pos);
    hand.rotation.x = tiltX;
    attachArm(group, hand, handMats, side, new THREE.Vector3(side * 0.01, -0.04, halfDepth + 0.006), elbow);
  };
  const placeCradleHand = (
    group: THREE.Group,
    halfWidth: number,
    halfHeight: number,
    pos: THREE.Vector3,
    elbow: THREE.Vector3,
  ): void => {
    const hand = buildCradleHand(handMats, -1, halfWidth, halfHeight);
    hand.position.copy(pos);
    attachArm(group, hand, handMats, -1, new THREE.Vector3(-halfWidth * 0.5, -halfHeight - 0.012, 0.045), elbow);
  };

  // Pistol: right hand on the raked grip, left hand cupped around it (thumbs-forward grip).
  placeGripHand(pistolGroup, 1, 0.017, 0.026, new THREE.Vector3(0, -0.056, 0.032), -0.24, new THREE.Vector3(0.1, -0.36, 0.4));
  placeGripHand(pistolGroup, -1, 0.029, 0.042, new THREE.Vector3(-0.004, -0.072, 0.036), -0.24, new THREE.Vector3(-0.3, -0.36, 0.34));

  // SMG: right hand on the new pistol grip, left hand on the vertical foregrip.
  placeGripHand(smgGroup, 1, 0.015, 0.02, new THREE.Vector3(0, -0.064, 0.083), -0.22, new THREE.Vector3(0.11, -0.37, 0.46));
  placeGripHand(smgGroup, -1, 0.015, 0.017, new THREE.Vector3(0, -0.062, -0.09), -0.1, new THREE.Vector3(-0.42, -0.34, 0.16));

  // AR: right hand on the grip, left hand cradling the vented handguard.
  placeGripHand(arGroup, 1, 0.016, 0.0225, new THREE.Vector3(0, -0.074, 0.107), -0.24, new THREE.Vector3(0.11, -0.38, 0.5));
  placeCradleHand(arGroup, 0.026, 0.025, new THREE.Vector3(0, 0.008, -0.27), new THREE.Vector3(-0.44, -0.34, 0.14));

  // Sniper: right hand on the grip, left hand cradling the chassis forend.
  placeGripHand(sniperGroup, 1, 0.016, 0.0225, new THREE.Vector3(0, -0.077, 0.127), -0.24, new THREE.Vector3(0.11, -0.38, 0.52));
  placeCradleHand(sniperGroup, 0.031, 0.044, new THREE.Vector3(0, 0.0, -0.15), new THREE.Vector3(-0.44, -0.34, 0.2));

  const weaponRigs: Record<WeaponId, WeaponModelRig> = {
    pistol: {
      group: pistolGroup,
      muzzleLocalPos: new THREE.Vector3(0, 0.018, -0.16),
      basePos: new THREE.Vector3(0.24, -0.22, -0.42),
      adsPos: new THREE.Vector3(0.24, -0.22, -0.42),
    },
    smg: {
      group: smgGroup,
      muzzleLocalPos: new THREE.Vector3(0, 0.01, -0.33),
      basePos: new THREE.Vector3(0.26, -0.23, -0.45),
      adsPos: new THREE.Vector3(0.11, -0.18, -0.41),
    },
    ar: {
      group: arGroup,
      muzzleLocalPos: new THREE.Vector3(0, 0.015, -0.49),
      basePos: VIEWMODEL_BASE_POS.clone(),
      adsPos: new THREE.Vector3(0.12, -0.19, -0.43),
    },
    sniper: {
      group: sniperGroup,
      muzzleLocalPos: new THREE.Vector3(0, 0.016, -0.75),
      basePos: new THREE.Vector3(0.29, -0.25, -0.48),
      adsPos: new THREE.Vector3(0.0, -0.18, -0.42),
    },
  };

  for (const id of WEAPON_ORDER) {
    weaponRigs[id].group.visible = id === currentWeaponId;
    weaponGroup.add(weaponRigs[id].group);
  }

  // Muzzle anchor & flash mesh positioned dynamically at the equipped weapon's barrel tip
  const muzzleNode = new THREE.Object3D();
  muzzleNode.position.copy(weaponRigs[currentWeaponId].muzzleLocalPos);
  weaponGroup.add(muzzleNode);

  const muzzleFlashMat = new THREE.MeshBasicMaterial({
    color: AGENT_PALETTES[activeColorId].hex,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const muzzleFlashMesh = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), muzzleFlashMat);
  muzzleFlashMesh.position.copy(muzzleNode.position);
  weaponGroup.add(muzzleFlashMesh);

  camera.add(weaponGroup);

  // Viewmodel animation state
  let kickOffsetZ = 0;
  let kickPitch = 0;
  let muzzleFlashTimer = 0;
  let bobPhase = 0;
  let adsBlend = 0;
  let wallTuckZ = 0;

  // Pool of active short-lived tracers & impact rings
  const activeTracers: ActiveTracer[] = [];
  const tempMuzzleWorld = new THREE.Vector3();

  function updateWeaponGroupVisibility(): void {
    // Hide the 3D sniper viewmodel during full-screen sniper scope overlay or 3rd-person mode.
    weaponGroup.visible = viewmodelVisible && !(isScoped && currentWeaponId === 'sniper');
  }

  function applyActiveWeaponVisuals(): void {
    for (const id of WEAPON_ORDER) {
      weaponRigs[id].group.visible = id === currentWeaponId;
    }
    const rig = weaponRigs[currentWeaponId];
    muzzleNode.position.copy(rig.muzzleLocalPos);
    muzzleFlashMesh.position.copy(rig.muzzleLocalPos);
    updateWeaponGroupVisibility();
  }

  /**
   * Switches to one of the 4 weapons (`pistol`, `smg`, `ar`, `sniper`),
   * preserving the previous gun's remaining ammo and cancelling reload/scope.
   */
  function equipWeapon(weaponId: WeaponId): void {
    if (weaponId === currentWeaponId) {
      return;
    }

    ammoByWeapon[currentWeaponId] = state.ammo;
    currentWeaponId = weaponId;

    const spec = WEAPON_SPECS[weaponId];
    state.maxAmmo = spec.maxAmmo;
    state.ammo = ammoByWeapon[weaponId];
    state.reloading = false;
    state.reloadTimer = 0;
    state.fireTimer = 0;
    state.recoilAccumulator = 0;
    isScoped = false;
    adsBlend = 0;

    applyActiveWeaponVisuals();
  }

  /**
   * Cycles forward (`delta > 0`) or backward (`delta < 0`) through `WEAPON_ORDER`.
   */
  function cycleWeapon(delta: number): void {
    if (delta === 0) return;
    const idx = WEAPON_ORDER.indexOf(currentWeaponId);
    const step = delta > 0 ? 1 : -1;
    const nextIdx = (idx + step + WEAPON_ORDER.length) % WEAPON_ORDER.length;
    equipWeapon(WEAPON_ORDER[nextIdx]);
  }

  /**
   * Toggles optical zoom / ADS if the currently equipped weapon supports `adsFovDeg`.
   * Cannot remain scoped while reloading or holding the un-scoped Sidearm.
   */
  function toggleScope(forceState?: boolean): void {
    const spec = WEAPON_SPECS[currentWeaponId];
    if (spec.adsFovDeg === null || state.reloading) {
      isScoped = false;
      updateWeaponGroupVisibility();
      return;
    }

    isScoped = typeof forceState === 'boolean' ? forceState : !isScoped;
    updateWeaponGroupVisibility();
  }

  /**
   * Refills all 4 weapon magazines for a fresh round and resets timers/scope.
   */
  function resetForRound(weaponId?: WeaponId): void {
    for (const id of WEAPON_ORDER) {
      ammoByWeapon[id] = WEAPON_SPECS[id].maxAmmo;
    }
    if (weaponId) {
      currentWeaponId = weaponId;
    }

    const spec = WEAPON_SPECS[currentWeaponId];
    state.maxAmmo = spec.maxAmmo;
    state.ammo = ammoByWeapon[currentWeaponId];
    state.fireTimer = 0;
    state.reloading = false;
    state.reloadTimer = 0;
    state.recoilAccumulator = 0;
    state.currentSpread = spec.baseSpreadRad;
    isScoped = false;
    adsBlend = 0;
    kickOffsetZ = 0;
    kickPitch = 0;
    wallTuckZ = 0;
    muzzleFlashTimer = 0;
    muzzleFlashMat.opacity = 0;

    applyActiveWeaponVisuals();
  }

  function setViewmodelVisible(visible: boolean): void {
    viewmodelVisible = visible;
    updateWeaponGroupVisibility();
  }

  /**
   * Switches the active agent color on the weapon's glowing accent rail, holo
   * sights, 1st-person gauntlet armour + glove trim, and subsequent tracers.
   */
  function setAgentColor(colorId: AgentColorId): void {
    activeColorId = colorId;
    const hex = AGENT_PALETTES[colorId].hex;
    accentMat.color.setHex(hex);
    accentMat.emissive.setHex(hex);
    muzzleFlashMat.color.setHex(hex);
    holoRingMat.color.setHex(hex);
    holoLensMat.color.setHex(hex);
    const glove = VIEWMODEL_GLOVE_STYLE[colorId];
    handArmorMat.color.setHex(glove.primary);
    handArmorMat.emissive.setHex(glove.primary);
    handTrimMat.color.setHex(glove.trim);
    handTrimMat.emissive.setHex(glove.trim);
  }

  /**
   * Perturbs a normalized unit look direction by a random angle inside a cone
   * of half-angle `spreadRadians`, then normalizes the resulting ray direction.
   */
  function applySpread(dir: Vec3, spreadRadians: number): Vec3 {
    if (spreadRadians <= 0) {
      return normalizeVec3(dir);
    }

    const upRef: Vec3 = Math.abs(dir.y) < 0.99 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const right = normalizeVec3(crossVec3(dir, upRef));
    const up = crossVec3(right, dir);

    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * Math.tan(spreadRadians);
    const offsetX = Math.cos(angle) * radius;
    const offsetY = Math.sin(angle) * radius;

    return normalizeVec3({
      x: dir.x + right.x * offsetX + up.x * offsetY,
      y: dir.y + right.y * offsetX + up.y * offsetY,
      z: dir.z + right.z * offsetX + up.z * offsetY,
    });
  }

  function spawnTracerSegment(
    startPoint: Vec3,
    endPoint: Vec3,
    hitNormal: Vec3 | null,
    colorHex: number,
    isHeadshot: boolean,
    widthScale: number,
  ): void {
    const tracerColor = isHeadshot ? 0xffd700 : colorHex;
    const startVec = new THREE.Vector3(startPoint.x, startPoint.y, startPoint.z);
    const endVec = new THREE.Vector3(endPoint.x, endPoint.y, endPoint.z);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([startVec, endVec]);
    const lineMat = new THREE.LineBasicMaterial({
      color: tracerColor,
      transparent: true,
      opacity: 0.95,
    });
    const line = new THREE.Line(lineGeo, lineMat);
    scene.add(line);

    // Heavy shots (e.g., Rail Sniper widthScale = 1.8) render an additional glowing beam cylinder
    // because WebGL `LineBasicMaterial` clamps line thickness to 1px on most GPUs.
    let beam: THREE.Mesh | null = null;
    let beamGeo: THREE.CylinderGeometry | null = null;
    let beamMat: THREE.MeshBasicMaterial | null = null;
    const dist = startVec.distanceTo(endVec);
    if (widthScale > 1.25 && dist > 0.05) {
      const radius = 0.011 * widthScale;
      beamGeo = new THREE.CylinderGeometry(radius, radius, dist, 6, 1, true);
      beamMat = new THREE.MeshBasicMaterial({
        color: tracerColor,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });
      beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.copy(startVec).lerp(endVec, 0.5);
      beam.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        endVec.clone().sub(startVec).normalize(),
      );
      scene.add(beam);
    }

    let ring: THREE.Mesh | null = null;
    let ringGeo: THREE.RingGeometry | null = null;
    let ringMat: THREE.MeshBasicMaterial | null = null;

    if (hitNormal) {
      const innerR = (isHeadshot ? 0.04 : 0.025) * Math.max(0.8, widthScale * 0.85);
      const outerR = (isHeadshot ? 0.14 : 0.09) * Math.max(0.8, widthScale * 0.95);
      ringGeo = new THREE.RingGeometry(innerR, outerR, 20);
      ringMat = new THREE.MeshBasicMaterial({
        color: isHeadshot ? 0xffef99 : colorHex,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      ring = new THREE.Mesh(ringGeo, ringMat);

      ring.position.set(
        endPoint.x + hitNormal.x * 0.024,
        endPoint.y + hitNormal.y * 0.024,
        endPoint.z + hitNormal.z * 0.024,
      );
      ring.lookAt(
        endPoint.x + hitNormal.x,
        endPoint.y + hitNormal.y,
        endPoint.z + hitNormal.z,
      );
      scene.add(ring);
    }

    activeTracers.push({
      line,
      lineGeo,
      lineMat,
      beam,
      beamGeo,
      beamMat,
      ring,
      ringGeo,
      ringMat,
      age: 0,
      lifetime: widthScale > 1.25 ? TRACER_LIFETIME_SEC * 1.45 : TRACER_LIFETIME_SEC,
    });
  }

  /**
   * Public helper used by AI combatants to render 3D tracers & surface impact rings
   * in world space without touching the player's first-person camera viewmodel.
   */
  function spawnWorldTracer(
    origin: Vec3,
    endPoint: Vec3,
    hitNormal: Vec3 | null,
    colorHex: number,
    isHeadshot: boolean,
  ): void {
    spawnTracerSegment(origin, endPoint, hitNormal, colorHex, isHeadshot, 1.0);
  }

  function updateTracers(dt: number): void {
    for (let i = activeTracers.length - 1; i >= 0; i--) {
      const tracer = activeTracers[i];
      tracer.age += dt;
      const t = tracer.age / tracer.lifetime;

      if (t >= 1) {
        scene.remove(tracer.line);
        tracer.lineGeo.dispose();
        tracer.lineMat.dispose();

        if (tracer.beam && tracer.beamGeo && tracer.beamMat) {
          scene.remove(tracer.beam);
          tracer.beamGeo.dispose();
          tracer.beamMat.dispose();
        }

        if (tracer.ring && tracer.ringGeo && tracer.ringMat) {
          scene.remove(tracer.ring);
          tracer.ringGeo.dispose();
          tracer.ringMat.dispose();
        }

        activeTracers.splice(i, 1);
      } else {
        const remainingOpacity = 1 - t;
        tracer.lineMat.opacity = remainingOpacity * 0.95;
        if (tracer.beamMat) {
          tracer.beamMat.opacity = remainingOpacity * 0.55;
        }
        if (tracer.ring && tracer.ringMat) {
          tracer.ringMat.opacity = remainingOpacity;
          const expand = 1 + t * 0.7;
          tracer.ring.scale.set(expand, expand, 1);
        }
      }
    }
  }

  /**
   * Advances timers, optical zoom spread, reload state, viewmodel animations,
   * and performs hitscan raycasting when the equipped weapon fires this frame.
   */
  function update(
    dt: number,
    player: PlayerState,
    input: InputState,
    colliders: AABB[],
    targetsMgr: TargetsManager,
    fireRateMultiplier = 1,
    recoilMultiplier = 1,
    moveSpreadMultiplier = 1,
    eyeHeightOffset = 0,
  ): ShotResult {
    updateTracers(dt);

    const spec = WEAPON_SPECS[currentWeaponId];
    const rateScale = Math.max(0.1, fireRateMultiplier);
    const recoilScale = Math.max(0, recoilMultiplier);
    const moveSpreadScale = Math.max(0, moveSpreadMultiplier);

    const eyeOrigin: Vec3 = {
      x: player.position.x,
      y: player.position.y + EYE_HEIGHT + eyeHeightOffset,
      z: player.position.z,
    };

    // Wall-Proximity Viewmodel Tuck: cast a 0.95m forward ray along look direction
    // and smoothly pull weaponGroup backward (+Z up to +0.34m) near walls/cover.
    const viewDir = getLookDirection(input.yaw, input.pitch);
    let closestTuckDist = WALL_TUCK_CHECK_DIST;
    for (const box of colliders) {
      const hit = raycastAABB(eyeOrigin, viewDir, box, closestTuckDist);
      if (hit && hit.distance < closestTuckDist) {
        closestTuckDist = hit.distance;
      }
    }
    const targetTuckZ =
      closestTuckDist < WALL_TUCK_CHECK_DIST
        ? Math.min(
            1,
            Math.max(
              0,
              (WALL_TUCK_CHECK_DIST - closestTuckDist) /
                (WALL_TUCK_CHECK_DIST - WALL_TUCK_MIN_DIST),
            ),
          ) * WALL_TUCK_MAX_Z
        : 0;
    wallTuckZ += (targetTuckZ - wallTuckZ) * Math.min(1, 18 * dt);

    // Ensure scope cannot linger on weapons without optics (e.g. Sidearm)
    if (spec.adsFovDeg === null && isScoped) {
      isScoped = false;
    }

    // Highlight weapon accent rail when Bio-Stim overdrive is active.
    accentMat.emissiveIntensity = fireRateMultiplier > 1.05 ? 2.1 : 0.9;
    handTrimMat.emissiveIntensity = fireRateMultiplier > 1.05 ? 2.0 : 1.25;

    // 1. Advance fire cooldown and reload progress (scaled by active stim multiplier)
    state.fireTimer = Math.max(0, state.fireTimer - dt);

    if (state.reloading) {
      isScoped = false;
      state.reloadTimer -= dt * rateScale;
      if (state.reloadTimer <= 0) {
        state.reloading = false;
        state.reloadTimer = 0;
        state.ammo = spec.maxAmmo;
        ammoByWeapon[currentWeaponId] = state.ammo;
        state.recoilAccumulator = 0;
      }
    } else if (state.ammo <= 0 || (input.reload && state.ammo < spec.maxAmmo)) {
      state.reloading = true;
      state.reloadTimer = spec.reloadDurationSec;
      isScoped = false;
    }

    // 2. Semi-auto vs. Full-auto trigger gating
    const triggerActivated = spec.automatic ? input.fire : Boolean(input.fireJustPressed);

    // Decay recoil when not actively spraying or while reloading
    if (!triggerActivated || state.reloading) {
      state.recoilAccumulator = Math.max(0, state.recoilAccumulator - dt * RECOIL_DECAY_RATE);
    }

    // 3. Compute Valorant-style weapon spread for this frame (including optical zoom spread)
    const horizontalSpeed = getHorizontalSpeed(player.velocity);
    const isStationary = horizontalSpeed < 0.45 && player.grounded;
    const stationaryBase = isScoped ? spec.scopedSpreadRad : spec.baseSpreadRad;
    const movePart =
      (isStationary ? 0 : (horizontalSpeed / RUN_SPEED) * spec.moveSpreadRad) *
      moveSpreadScale;
    const airPart = player.grounded ? 0 : spec.airSpreadRad;
    const sprayPart = state.recoilAccumulator * 0.035;
    state.currentSpread = stationaryBase + movePart + airPart + sprayPart;

    let result: ShotResult = {
      fired: false,
      hitPoint: null,
      hitType: 'none',
      damageDealt: 0,
      killedTarget: false,
    };

    // 4. Fire hitscan shot if trigger gate passes and weapon is ready
    if (!state.reloading && triggerActivated && state.fireTimer <= 0 && state.ammo > 0) {
      state.ammo -= 1;
      ammoByWeapon[currentWeaponId] = state.ammo;
      state.fireTimer = spec.fireIntervalSec / rateScale;

      const origin: Vec3 = eyeOrigin;

      const baseLookDir = getLookDirection(
        input.yaw,
        input.pitch + state.recoilAccumulator * 0.06,
      );
      const shotDir = applySpread(baseLookDir, state.currentSpread);

      // Accumulate recoil after computing this shot so shot #1 uses initial accuracy
      state.recoilAccumulator = Math.min(
        MAX_RECOIL_ACCUMULATOR,
        state.recoilAccumulator + spec.recoilPerShot * recoilScale,
      );

      // Viewmodel kickback & muzzle flash
      kickOffsetZ = Math.min(0.11, kickOffsetZ + (currentWeaponId === 'sniper' ? 0.095 : 0.055));
      kickPitch = Math.min(0.22, kickPitch + (currentWeaponId === 'sniper' ? 0.16 : 0.075));
      muzzleFlashTimer = 0.045;

      // Stage A: Raycast against solid arena geometry (walls, floor, cover) first
      let closestWallDist = MAX_RAY_DISTANCE;
      let closestWallHit: RaycastHit | null = null;

      for (const box of colliders) {
        const hit = raycastAABB(origin, shotDir, box, closestWallDist);
        if (hit && hit.distance < closestWallDist) {
          closestWallDist = hit.distance;
          closestWallHit = hit;
        }
      }

      // Stage B: Raycast against alive targets strictly closer than the nearest wall
      let closestTargetDist = closestWallDist;
      let hitTargetId: string | null = null;
      let hitTargetHit: RaycastHit | null = null;
      let hitWasHeadshot = false;

      for (const target of targetsMgr.targets) {
        if (!target.alive) continue;

        const { head, body } = targetsMgr.getHitboxes(target);
        const headHit = raycastAABB(origin, shotDir, head, closestTargetDist);
        const bodyHit = raycastAABB(origin, shotDir, body, closestTargetDist);

        if (headHit && (!bodyHit || headHit.distance <= bodyHit.distance + 1e-4)) {
          if (headHit.distance < closestTargetDist) {
            closestTargetDist = headHit.distance;
            hitTargetId = target.id;
            hitTargetHit = headHit;
            hitWasHeadshot = true;
          }
        } else if (bodyHit && bodyHit.distance < closestTargetDist) {
          closestTargetDist = bodyHit.distance;
          hitTargetId = target.id;
          hitTargetHit = bodyHit;
          hitWasHeadshot = false;
        }
      }

      // Determine world-space tracer start point (first-person muzzle vs. 3rd-person barrel offset)
      let tracerOrigin: Vec3;
      if (viewmodelVisible && !(isScoped && currentWeaponId === 'sniper')) {
        camera.updateMatrixWorld(true);
        muzzleNode.getWorldPosition(tempMuzzleWorld);
        tracerOrigin = {
          x: tempMuzzleWorld.x,
          y: tempMuzzleWorld.y,
          z: tempMuzzleWorld.z,
        };
      } else {
        tracerOrigin = {
          x: origin.x + shotDir.x * 0.45,
          y: origin.y - 0.14 + shotDir.y * 0.45,
          z: origin.z + shotDir.z * 0.45,
        };
      }

      const paletteHex = AGENT_PALETTES[activeColorId].hex;

      // Stage C: Resolve piecewise falloff damage, ShotResult, and 3D bullet tracer
      if (hitTargetId && hitTargetHit) {
        const damage = computeWeaponDamage(spec, closestTargetDist, hitWasHeadshot);
        const killed = targetsMgr.applyDamage(hitTargetId, damage, hitWasHeadshot);

        result = {
          fired: true,
          hitPoint: hitTargetHit.point,
          hitType: hitWasHeadshot ? 'head' : 'body',
          damageDealt: damage,
          killedTarget: killed,
        };
        spawnTracerSegment(
          tracerOrigin,
          hitTargetHit.point,
          hitTargetHit.normal,
          paletteHex,
          hitWasHeadshot,
          spec.tracerWidthScale,
        );
      } else if (closestWallHit) {
        result = {
          fired: true,
          hitPoint: closestWallHit.point,
          hitType: 'wall',
          damageDealt: 0,
          killedTarget: false,
        };
        spawnTracerSegment(
          tracerOrigin,
          closestWallHit.point,
          closestWallHit.normal,
          paletteHex,
          false,
          spec.tracerWidthScale,
        );
      } else {
        const missPoint: Vec3 = {
          x: origin.x + shotDir.x * 80,
          y: origin.y + shotDir.y * 80,
          z: origin.z + shotDir.z * 80,
        };
        result = {
          fired: true,
          hitPoint: missPoint,
          hitType: 'none',
          damageDealt: 0,
          killedTarget: false,
        };
        spawnTracerSegment(
          tracerOrigin,
          missPoint,
          null,
          paletteHex,
          false,
          spec.tracerWidthScale,
        );
      }

      // Immediately begin reload if the final round in the magazine was just fired
      if (state.ammo <= 0 && !state.reloading) {
        state.reloading = true;
        state.reloadTimer = spec.reloadDurationSec;
        isScoped = false;
      }
    }

    // 5. Animate viewmodel kickback recovery, ADS blend, walk bob, and reload tilt
    updateWeaponGroupVisibility();

    const damping = Math.exp(-16 * dt);
    kickOffsetZ *= damping;
    kickPitch *= damping;

    const targetAds = isScoped ? 1 : 0;
    adsBlend += (targetAds - adsBlend) * Math.min(1, 14 * dt);

    if (muzzleFlashTimer > 0) {
      muzzleFlashTimer = Math.max(0, muzzleFlashTimer - dt);
      muzzleFlashMat.opacity = (muzzleFlashTimer / 0.045) * 0.85;
    } else {
      muzzleFlashMat.opacity = 0;
    }

    let bobX = 0;
    let bobY = 0;
    if (player.grounded && horizontalSpeed > 0.5) {
      bobPhase += dt * (6 + horizontalSpeed * 0.65);
      const bobScale = isScoped ? 0.3 : 1.0;
      const bobAmp = Math.min(1, horizontalSpeed / RUN_SPEED) * 0.008 * bobScale;
      bobX = Math.cos(bobPhase * 0.5) * bobAmp;
      bobY = Math.sin(bobPhase) * bobAmp;
    }

    let reloadDropY = 0;
    let reloadRollZ = 0;
    let reloadPitchX = 0;
    if (state.reloading) {
      const progress = 1 - state.reloadTimer / Math.max(0.01, spec.reloadDurationSec);
      const reloadCurve = Math.sin(Math.min(1, Math.max(0, progress)) * Math.PI);
      reloadDropY = -0.1 * reloadCurve;
      reloadRollZ = 0.55 * reloadCurve;
      reloadPitchX = -0.35 * reloadCurve;
    }

    const rig = weaponRigs[currentWeaponId];
    const restX = rig.basePos.x + (rig.adsPos.x - rig.basePos.x) * adsBlend;
    const restY = rig.basePos.y + (rig.adsPos.y - rig.basePos.y) * adsBlend;
    const restZ = rig.basePos.z + (rig.adsPos.z - rig.basePos.z) * adsBlend;

    weaponGroup.position.set(
      restX + bobX,
      restY + bobY + reloadDropY,
      restZ + kickOffsetZ + wallTuckZ,
    );
    weaponGroup.rotation.set(kickPitch + reloadPitchX, 0, reloadRollZ);

    return result;
  }

  return {
    state,
    get currentWeaponId() {
      return currentWeaponId;
    },
    get isScoped() {
      return isScoped;
    },
    equipWeapon,
    cycleWeapon,
    toggleScope,
    resetForRound,
    setViewmodelVisible,
    setAgentColor,
    spawnWorldTracer,
    update,
  };
}

function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalizeVec3(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len <= 1e-8) {
    return { x: 0, y: 0, z: -1 };
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
