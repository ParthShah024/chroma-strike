import * as THREE from 'three';
import { AgentColorId, TeamId, Vec3, WeaponId } from '../core/types';

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
      /** Seconds of Power-Slide remaining (> 0 = sliding). Optional for older callers. */
      slideTimer?: number;
      /** Seconds of concussion remaining (> 0 = gold-white electric shimmer). */
      concussTimer?: number;
    },
    cameraPos: Vec3
  ): void;
  dispose(scene: THREE.Scene): void;
}

// ===========================================================================
// Design Note A — Colour Readability ("Who is that, and whose side are they on?")
// ===========================================================================
// A tactical shooter asks the player two questions about every silhouette in a
// fraction of a second:
//   1. WHICH AGENT is it?   -> answered by HUE (red / blue / green / violet / gold)
//   2. WHICH TEAM is it on? -> answered by VALUE (bright pearl vs dark obsidian)
//
// Hue and value are processed by different channels of human vision, so we
// assign each question its own channel and never let them fight:
//   * ~70% of the visible surface (helmet, chest shell, pauldrons, thighs,
//     greaves, gauntlets, boots) is painted in the vivid Agent Colour. The
//     armour material also *self-illuminates* (`emissive = primary`,
//     intensity 0.28) so the hue survives dark corners, fog and 30 m of
//     distance where a purely lit surface would collapse toward grey.
//   * ~30% (undersuit, joints, collar, inner thighs/biceps, gloves, belt,
//     soles) carries the TEAM value: Pearl-Titanium white for allies, matte
//     Obsidian for enemies. Because these panels sit *between* armour plates,
//     they frame the agent colour instead of tinting it.
//   * A flat ring on the floor and the overhead bar badge repeat the team cue
//     without adding noisy wireframes to the body itself.
// ===========================================================================

const AGENT_STYLE: Record<AgentColorId, { primary: number; trim: number }> = {
  red: { primary: 0xff2244, trim: 0xff6b85 }, // Blaze — vivid crimson + neon rose
  blue: { primary: 0x00a8ff, trim: 0x6ce8ff }, // Mist  — electric cobalt-cyan + ice neon
  green: { primary: 0x10d464, trim: 0x7dffb3 }, // Pulse — emerald-jade + mint neon
  violet: { primary: 0xa23cff, trim: 0xdcb0ff }, // Umbra — vivid amethyst + lilac neon
  gold: { primary: 0xffbf00, trim: 0xfff27a }, // Volt  — electric amber-gold + lemon neon
};

/**
 * Per-agent armour surface tuning. Most agents share the default finish, but
 * two hues need help to keep the "hue = agent" channel readable:
 *   * Violet is a LOW-luminance hue: against an Obsidian enemy undersuit it
 *     would sink toward black, so Umbra self-illuminates harder (0.34).
 *   * Gold is a HIGH-luminance hue: against Pearl-White ally panels it can
 *     wash out toward cream, so Volt gets a slightly glossier, more metallic
 *     finish (roughness 0.30 / metalness 0.34) whose specular contrast keeps
 *     the gold reading as gold.
 */
const ARMOR_FINISH: Record<AgentColorId, { roughness: number; metalness: number; emissiveIntensity: number }> = {
  red: { roughness: 0.34, metalness: 0.22, emissiveIntensity: 0.28 },
  blue: { roughness: 0.34, metalness: 0.22, emissiveIntensity: 0.28 },
  green: { roughness: 0.34, metalness: 0.22, emissiveIntensity: 0.28 },
  violet: { roughness: 0.34, metalness: 0.22, emissiveIntensity: 0.34 },
  gold: { roughness: 0.3, metalness: 0.34, emissiveIntensity: 0.28 },
};

/** Gold-white tint pulsed onto armour while concussed (Volt's relay). */
const CONCUSS_SHIMMER_HEX = 0xfff4c8;

// Power-Slide target pose (radians / metres). Lead leg = LEFT.
const SLIDE_LEAD_HIP_RAD = 1.25;
const SLIDE_LEAD_KNEE_RAD = -1.6;
const SLIDE_TRAIL_HIP_RAD = -0.8;
const SLIDE_TRAIL_KNEE_RAD = -0.2;
const SLIDE_TORSO_LEAN_RAD = 0.25; // +X tips the torso toward +Z = leaning BACK
const SLIDE_DROP_M = -0.35;

// Volt's pooled electric arc: heelL -> coilL -> coilR -> heelR, 3 legs.
const ARC_SEGMENTS_PER_LEG = 8;
const ARC_POINT_COUNT = ARC_SEGMENTS_PER_LEG * 3 + 1;
const ARC_RESEED_SEC = 0.05;

interface TeamStyle {
  suit: number;
  suitEmissive: number;
  suitEmissiveIntensity: number;
  suitRoughness: number;
  suitMetalness: number;
  ring: number;
  ringOpacity: number;
  barFrame: number;
  badge: number;
}

const TEAM_STYLE: Record<TeamId, TeamStyle> = {
  ally: {
    suit: 0xf2f6ff, // Pearl-Titanium white
    suitEmissive: 0xdfe8ff,
    suitEmissiveIntensity: 0.07,
    suitRoughness: 0.46,
    suitMetalness: 0.12,
    ring: 0x9ff0ff, // cyan-white
    ringOpacity: 0.55,
    barFrame: 0xd8fbff,
    badge: 0x6ce8ff,
  },
  enemy: {
    suit: 0x141722, // deep matte obsidian
    suitEmissive: 0x000000,
    suitEmissiveIntensity: 0.0,
    suitRoughness: 0.66,
    suitMetalness: 0.28,
    ring: 0xff4422, // amber-red
    ringOpacity: 0.65,
    barFrame: 0x05060a,
    badge: 0xff4422,
  },
};

// ---------------------------------------------------------------------------
// Anatomical Proportions Matched to Gameplay Hitboxes (root = feet, faces -Z)
//   Body AABB: y = [0.00, 1.38]      Head AABB: y = [1.38, 1.82], centre 1.60
// ---------------------------------------------------------------------------
const WAIST_Y = 0.88; // upper-body pivot (twist / lean / breathing)
const HIP_X = 0.13;
const HIP_Y = 0.88;
const THIGH_LEN = 0.4; // hip -> knee
const KNEE_TO_SOLE = 0.48; // knee (world y 0.48) -> sole (world y 0.00)
const SHOULDER_X = 0.24;
const SHOULDER_Y = 1.32;
const UPPER_ARM_LEN = 0.3; // shoulder -> elbow
const FOREARM_LEN = 0.29; // elbow -> hand centre
const HEAD_CENTER_Y = 1.6;

const HEALTH_BAR_Y = 2.06;
const HEALTH_BAR_WIDTH = 0.84;
const HEALTH_BAR_HEIGHT = 0.075;
const BLIND_HALO_Y = 2.26;

const HIT_FLASH_DURATION_SEC = 0.1;
const DEATH_TILT_TARGET_RAD = -Math.PI * 0.48;
const MAX_WALK_SPEED_MPS = 8.2;
const MAX_STRIDE_AMP_RAD = 0.62;

const WEAPON_METAL_HEX = 0x2b3242;
const WEAPON_POLYMER_HEX = 0x1b1f29;
const WEAPON_BARREL_HEX = 0x3d4659;

const UP = new THREE.Vector3(0, 1, 0);

/**
 * How each weapon is carried: where the right-hand grip sits relative to the
 * aim pivot (upper chest), and how far the torso blades (twists) toward the
 * support side so the left hand can reach the foregrip.
 */
const WEAPON_HOLD: Record<WeaponId, { socket: [number, number, number]; twist: number }> = {
  pistol: { socket: [0.0, -0.1, -0.4], twist: -0.16 },
  smg: { socket: [0.05, -0.15, -0.27], twist: -0.24 },
  ar: { socket: [0.06, -0.16, -0.25], twist: -0.28 },
  sniper: { socket: [0.06, -0.15, -0.24], twist: -0.3 },
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ===========================================================================
// Design Note B — LatheGeometry: sculpting with revolution surfaces
// ===========================================================================
// `THREE.LatheGeometry(points, segments, phiStart, phiLength)` takes a 2D
// profile curve — a list of `(radius, height)` pairs, ordered bottom -> top —
// and sweeps it around the Y axis like clay on a potter's wheel. Each profile
// point `(r, y)` becomes a ring of vertices:
//     x = r * sin(phi),   y = y,   z = r * cos(phi),   phi ∈ [phiStart, phiStart + phiLength]
// (phi = 0 points to +Z = the character's back, phi = PI points to -Z = the face).
//
// Why it beats boxes for characters:
//   * One smooth radius curve gives a whole anatomical form: an athletic
//     V-taper torso (waist 0.14 -> chest 0.20 -> neck 0.07), a tapered limb, a
//     dome-shaped hood.
//   * Non-uniform mesh scale afterwards (e.g. `[1.08, 1.0, 0.72]`) turns the
//     round "barrel" into a realistic elliptical cross-section — wider across
//     the shoulders than it is deep front-to-back.
//   * A partial sweep (`phiLength < 2*PI`) leaves an opening — that is exactly
//     how Mist's hood leaves its face open over a recessed shadow mask.
// ===========================================================================

/**
 * A capsule whose two hemispherical caps have *different* radii, built as a
 * lathe profile. The origin is the TOP of the limb (the joint), and the shape
 * extends down to `-length`, which is exactly what a hierarchical limb wants:
 * rotating the parent joint rotates the limb about its anatomical pivot.
 */
function taperedCapsuleGeometry(
  rTop: number,
  rBottom: number,
  length: number,
  radialSegments = 14,
  capSegments = 5
): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [];
  // Bottom cap: quarter circle from the very tip (-length) out to the equator.
  for (let i = 0; i <= capSegments; i++) {
    const a = -Math.PI / 2 + (i / capSegments) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-4, Math.cos(a) * rBottom), -length + rBottom + Math.sin(a) * rBottom));
  }
  // Top cap: equator up to the crown (0). The straight segment between the
  // two equators is the taper.
  for (let i = 0; i <= capSegments; i++) {
    const a = (i / capSegments) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-4, Math.cos(a) * rTop), -rTop + Math.sin(a) * rTop));
  }
  return new THREE.LatheGeometry(pts, radialSegments);
}

/**
 * Athletic torso radius profile (world-space y). Catmull-Rom spline through
 * hand-placed key radii: waist 0.14 at y 0.88, chest peak 0.20 near the
 * pectoral line, rolling over the trapezius into a 0.07 neck at y 1.38.
 */
function buildTorsoProfile(): THREE.Vector2[] {
  const keys = [
    new THREE.Vector2(0.135, 0.86),
    new THREE.Vector2(0.14, 0.88),
    new THREE.Vector2(0.15, 0.97),
    new THREE.Vector2(0.178, 1.07),
    new THREE.Vector2(0.198, 1.16),
    new THREE.Vector2(0.2, 1.22),
    new THREE.Vector2(0.188, 1.28),
    new THREE.Vector2(0.158, 1.325),
    new THREE.Vector2(0.11, 1.358),
    new THREE.Vector2(0.07, 1.38),
  ];
  const raw = new THREE.SplineCurve(keys).getPoints(72);
  // Enforce strictly increasing y so we can slice/interpolate by height.
  const out: THREE.Vector2[] = [];
  for (const p of raw) {
    if (out.length === 0 || p.y > out[out.length - 1].y + 1e-5) {
      out.push(p.clone());
    }
  }
  return out;
}

function torsoRadiusAt(profile: THREE.Vector2[], y: number): number {
  if (y <= profile[0].y) return profile[0].x;
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1];
    const b = profile[i];
    if (y <= b.y) {
      const t = (y - a.y) / (b.y - a.y);
      return a.x + (b.x - a.x) * t;
    }
  }
  return profile[profile.length - 1].x;
}

/**
 * Cuts a horizontal slice `[yMin, yMax]` out of the torso profile and revolves
 * it. Two slices of the SAME curve give us a two-tone torso: an undersuit
 * abdomen (team value) and a slightly inflated armour chest shell (agent hue)
 * that overlaps it seamlessly.
 */
function sliceTorsoLathe(
  profile: THREE.Vector2[],
  yMin: number,
  yMax: number,
  radiusScale: number,
  yOffset: number,
  closeBottom: boolean
): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [];
  const rMin = torsoRadiusAt(profile, yMin) * radiusScale;
  // Bottom: either a closed cap, or an inward lip so a shell edge looks thick.
  pts.push(new THREE.Vector2(closeBottom ? 1e-4 : rMin * 0.86, yMin - yOffset));
  pts.push(new THREE.Vector2(rMin, yMin - yOffset));
  for (const p of profile) {
    if (p.y > yMin + 1e-4 && p.y < yMax - 1e-4) {
      pts.push(new THREE.Vector2(p.x * radiusScale, p.y - yOffset));
    }
  }
  pts.push(new THREE.Vector2(torsoRadiusAt(profile, yMax) * radiusScale, yMax - yOffset));
  pts.push(new THREE.Vector2(1e-4, yMax - yOffset + 0.004));
  return new THREE.LatheGeometry(pts, 28);
}

/**
 * Extrudes a 2D side-profile (x = distance FORWARD, y = up) into a bevelled
 * solid `width` metres wide, centred on X and pointing down local -Z. This is
 * how the weapon receivers, grips and stocks get crisp silhouettes with soft
 * chamfered edges instead of raw boxes.
 */
function extrudeForward(points: Array<[number, number]>, width: number, bevel = 0.004): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const depth = Math.max(0.001, width - bevel * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 6,
  });
  // (shapeX, shapeY, extrudeZ) -> (extrudeZ, shapeY, -shapeX): forward = -Z
  geo.rotateY(Math.PI / 2);
  geo.translate(-depth / 2, 0, 0);
  return geo;
}

/** Same as `extrudeForward` but the profile's +x sweeps BACKWARD (+Z). */
function extrudeBackward(shape: THREE.Shape, thickness: number): THREE.ExtrudeGeometry {
  const bevel = 0.003;
  const depth = Math.max(0.001, thickness - bevel * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 12,
  });
  // (shapeX, shapeY, extrudeZ) -> (-extrudeZ, shapeY, shapeX): profile x = +Z
  geo.rotateY(-Math.PI / 2);
  geo.translate(depth / 2, 0, 0);
  return geo;
}

/** Cylinder lying along Z; `rFront` is the radius of the -Z (muzzle) end. */
function zCylinderGeometry(rFront: number, rBack: number, length: number, segments = 14): THREE.CylinderGeometry {
  const geo = new THREE.CylinderGeometry(rFront, rBack, length, segments);
  geo.rotateX(-Math.PI / 2); // +Y (top) -> -Z
  return geo;
}

/** Thin capsule lying along Z (used for neon rails and sight lines). */
function zCapsuleGeometry(radius: number, length: number): THREE.CapsuleGeometry {
  const geo = new THREE.CapsuleGeometry(radius, length, 3, 8);
  geo.rotateX(Math.PI / 2);
  return geo;
}

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

interface WeaponProp {
  group: THREE.Group;
  /** Where the LEFT (support) hand centre should sit, in prop-local space. */
  support: THREE.Object3D;
}

/**
 * Builds the 4 swappable weapon props. Convention: prop origin = centre of
 * the RIGHT hand on the pistol grip; barrel points down local -Z; +Y is up.
 */
function buildWeaponProps(trimMat: THREE.Material, glowMat: THREE.Material): Record<WeaponId, WeaponProp> {
  const metal = new THREE.MeshStandardMaterial({ color: WEAPON_METAL_HEX, metalness: 0.72, roughness: 0.32 });
  const polymer = new THREE.MeshStandardMaterial({ color: WEAPON_POLYMER_HEX, metalness: 0.22, roughness: 0.56 });
  const barrel = new THREE.MeshStandardMaterial({ color: WEAPON_BARREL_HEX, metalness: 0.86, roughness: 0.22 });

  const gripProfile: Array<[number, number]> = [
    [-0.035, 0.02],
    [0.025, 0.02],
    [0.012, -0.08],
    [-0.05, -0.075],
  ];

  const makeSupport = (group: THREE.Group, x: number, y: number, z: number): THREE.Object3D => {
    const anchor = new THREE.Object3D();
    anchor.position.set(x, y, z);
    group.add(anchor);
    return anchor;
  };

  // 1. Pistol — bevelled slide, angled polymer grip, neon sight line.
  const pistol = new THREE.Group();
  addMesh(pistol, extrudeForward([[-0.048, 0.035], [0.165, 0.035], [0.176, 0.05], [0.168, 0.078], [-0.036, 0.081], [-0.05, 0.066]], 0.04), metal);
  addMesh(pistol, extrudeForward([[-0.036, 0.04], [0.03, 0.04], [0.018, -0.065], [-0.046, -0.06]], 0.036), polymer);
  addMesh(pistol, zCylinderGeometry(0.011, 0.011, 0.03), barrel, 0, 0.056, -0.183);
  addMesh(pistol, zCapsuleGeometry(0.0045, 0.14), glowMat, 0, 0.084, -0.065);
  for (const s of [-1, 1]) addMesh(pistol, zCapsuleGeometry(0.0035, 0.1), trimMat, s * 0.021, 0.05, -0.08);
  const pistolSupport = makeSupport(pistol, -0.048, -0.014, -0.012);

  // 2. SMG — compact receiver, forward magazine, suppressor, wire stock.
  const smg = new THREE.Group();
  addMesh(smg, extrudeForward([[-0.1, 0.015], [0.2, 0.015], [0.215, 0.04], [0.2, 0.095], [-0.07, 0.1], [-0.11, 0.07]], 0.052), metal);
  addMesh(smg, extrudeForward(gripProfile, 0.036), polymer);
  addMesh(smg, extrudeForward([[0.07, 0.02], [0.115, 0.02], [0.125, -0.15], [0.08, -0.15]], 0.032), polymer);
  addMesh(smg, zCylinderGeometry(0.026, 0.026, 0.17), polymer, 0, 0.058, -0.3);
  addMesh(smg, zCylinderGeometry(0.0285, 0.0285, 0.014), trimMat, 0, 0.058, -0.36);
  for (const y of [0.075, 0.035]) addMesh(smg, zCylinderGeometry(0.0065, 0.0065, 0.17, 8), barrel, 0, y, 0.175);
  const smgButt = addMesh(smg, new THREE.CapsuleGeometry(0.013, 0.06, 3, 8), polymer, 0, 0.055, 0.26);
  smgButt.scale.set(1.4, 1, 1);
  addMesh(smg, zCapsuleGeometry(0.0055, 0.2), glowMat, 0, 0.101, -0.05);
  const smgSupport = makeSupport(smg, 0, -0.02, -0.17);

  // 3. AR — receiver + wider handguard sleeve, curved mag, optic, muzzle brake.
  const ar = new THREE.Group();
  addMesh(ar, extrudeForward([[-0.1, 0.015], [0.36, 0.015], [0.375, 0.04], [0.36, 0.098], [-0.08, 0.105], [-0.11, 0.08]], 0.058), metal);
  addMesh(ar, extrudeForward([[0.14, 0.008], [0.355, 0.008], [0.355, 0.09], [0.14, 0.092]], 0.066), polymer);
  addMesh(ar, extrudeForward([[-0.1, 0.03], [-0.1, 0.095], [-0.2, 0.09], [-0.22, 0.075], [-0.22, -0.03], [-0.19, -0.03], [-0.15, 0.025]], 0.044), polymer);
  addMesh(ar, extrudeForward(gripProfile, 0.036), polymer);
  addMesh(ar, extrudeForward([[0.06, 0.015], [0.115, 0.015], [0.14, -0.13], [0.085, -0.15]], 0.034), polymer);
  addMesh(ar, zCylinderGeometry(0.013, 0.014, 0.17), barrel, 0, 0.058, -0.46);
  addMesh(ar, zCylinderGeometry(0.021, 0.021, 0.05), metal, 0, 0.058, -0.56);
  addMesh(ar, extrudeForward([[-0.05, 0.1], [0.06, 0.1], [0.05, 0.12], [-0.04, 0.12]], 0.02), barrel);
  addMesh(ar, zCylinderGeometry(0.024, 0.024, 0.11), metal, 0, 0.135, -0.02);
  addMesh(ar, zCylinderGeometry(0.02, 0.02, 0.004), glowMat, 0, 0.135, -0.077);
  for (const s of [-1, 1]) addMesh(ar, zCapsuleGeometry(0.005, 0.16), trimMat, s * 0.035, 0.05, -0.25);
  const arSupport = makeSupport(ar, 0, -0.022, -0.215);

  // 4. Sniper — heavy receiver, fluted long barrel, big scope, folded bipod.
  const sniper = new THREE.Group();
  addMesh(sniper, extrudeForward([[-0.1, 0.015], [0.3, 0.015], [0.31, 0.05], [0.3, 0.1], [-0.1, 0.105]], 0.062), metal);
  addMesh(sniper, extrudeForward([[-0.1, 0.02], [-0.1, 0.1], [-0.24, 0.095], [-0.25, 0.08], [-0.25, -0.05], [-0.21, -0.05], [-0.15, 0.02]], 0.05), polymer);
  addMesh(sniper, extrudeForward(gripProfile, 0.036), polymer);
  addMesh(sniper, extrudeForward([[0.05, 0.015], [0.12, 0.015], [0.12, -0.06], [0.05, -0.06]], 0.04), polymer);
  addMesh(sniper, zCylinderGeometry(0.015, 0.02, 0.55), barrel, 0, 0.06, -0.585);
  addMesh(sniper, zCylinderGeometry(0.026, 0.026, 0.07), metal, 0, 0.06, -0.895);
  addMesh(sniper, zCylinderGeometry(0.03, 0.028, 0.28), metal, 0, 0.15, -0.06);
  addMesh(sniper, zCylinderGeometry(0.038, 0.031, 0.05), metal, 0, 0.15, -0.215);
  addMesh(sniper, zCylinderGeometry(0.033, 0.033, 0.004), glowMat, 0, 0.15, -0.242);
  addMesh(sniper, zCylinderGeometry(0.024, 0.024, 0.004), trimMat, 0, 0.15, 0.081);
  for (const z of [-0.12, 0.02]) addMesh(sniper, extrudeForward([[-0.012, 0.1], [0.012, 0.1], [0.012, 0.125], [-0.012, 0.125]], 0.026), barrel, 0, 0, z);
  for (const s of [-1, 1]) addMesh(sniper, zCylinderGeometry(0.006, 0.006, 0.2, 8), barrel, s * 0.018, 0.028, -0.42);
  addMesh(sniper, zCapsuleGeometry(0.005, 0.3), trimMat, 0.033, 0.06, -0.1);
  const sniperSupport = makeSupport(sniper, 0, -0.02, -0.215);

  return {
    pistol: { group: pistol, support: pistolSupport },
    smg: { group: smg, support: smgSupport },
    ar: { group: ar, support: arSupport },
    sniper: { group: sniper, support: sniperSupport },
  };
}

interface LegRig {
  hip: THREE.Group;
  knee: THREE.Group;
}

interface ArmRig {
  shoulder: THREE.Group;
  elbow: THREE.Group;
}

type Animator = (time: number, dt: number, motion: number) => void;

/**
 * Constructs an articulated, showcase-quality procedural tactical agent
 * matching Chroma Strike's gameplay hitboxes (`body y: 0..1.38`,
 * `head y: 1.38..1.82`), facing -Z at yaw 0.
 *
 * ---------------------------------------------------------------------------
 * Design Note C — The transform hierarchy (Forward Kinematics)
 * ---------------------------------------------------------------------------
 *   root (feet position + yaw)
 *   ├─ bodyTiltGroup (pivot at the soles; death collapse)
 *   │   ├─ pelvis, belt, gear
 *   │   ├─ leftHip ─ thigh ─ leftKnee ─ shin, greave, boot
 *   │   ├─ rightHip ─ ...
 *   │   └─ upperBody (pivot at waist y 0.88; twist / lean / breathing)
 *   │       ├─ torso shell, pauldrons, archetype back-gear
 *   │       ├─ headGroup (y 1.60; look pitch)
 *   │       ├─ aimPivot ─ weaponSocket ─ [pistol | smg | ar | sniper]
 *   │       ├─ leftShoulder ─ upper arm ─ leftElbow ─ gauntlet, hand
 *   │       └─ rightShoulder ─ ...
 *   ├─ team ring, overhead health bar, blind halo (never tilted)
 *
 * Each node stores a local 4x4 matrix `M = T * R * S`; a vertex's world
 * position is the product down the chain, e.g. for a boot vertex:
 *   `M_world = M_root * M_tilt * M_hip(θ_hip) * M_knee(θ_knee) * v_boot`
 * Rotating ONE number (the hip angle) therefore swings thigh, shin and boot
 * together, and rotating the knee only moves what hangs below it.
 */
export function createCharacterModel(scene: THREE.Scene, team: TeamId, colorId: AgentColorId): CharacterRig {
  const agent = AGENT_STYLE[colorId];
  const finish = ARMOR_FINISH[colorId];
  const teamStyle = TEAM_STYLE[team];
  const isEnemy = team === 'enemy';

  // -------------------------------------------------------------------------
  // Per-rig materials (so hit-flash / cryo tint affect one character only)
  // -------------------------------------------------------------------------
  const armorMat = new THREE.MeshStandardMaterial({
    color: agent.primary,
    roughness: finish.roughness,
    metalness: finish.metalness,
    emissive: agent.primary,
    emissiveIntensity: finish.emissiveIntensity,
    side: THREE.DoubleSide, // open domes (pauldrons) / shells read solid from below
  });
  const helmetMat = armorMat.clone(); // separate so headshots flash the head harder
  const suitMat = new THREE.MeshStandardMaterial({
    color: teamStyle.suit,
    roughness: teamStyle.suitRoughness,
    metalness: teamStyle.suitMetalness,
    emissive: teamStyle.suitEmissive,
    emissiveIntensity: teamStyle.suitEmissiveIntensity,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: agent.trim,
    emissive: agent.trim,
    emissiveIntensity: 1.2,
    roughness: 0.2,
    metalness: 0.1,
  });
  // Unlit pure glow for optics / visors / energy cores: always full brightness.
  const glowMat = new THREE.MeshBasicMaterial({ color: agent.trim });
  const shadowMat = new THREE.MeshStandardMaterial({ color: 0x04060b, roughness: 0.9, metalness: 0.1 });
  const visorGlassMat = new THREE.MeshStandardMaterial({ color: 0x0a0f18, roughness: 0.14, metalness: 0.65 });

  const root = new THREE.Group();
  const bodyTiltGroup = new THREE.Group();
  root.add(bodyTiltGroup);

  const upperBody = new THREE.Group();
  upperBody.position.set(0, WAIST_Y, 0);
  bodyTiltGroup.add(upperBody);
  const U = (worldY: number): number => worldY - WAIST_Y; // world y -> upperBody-local y

  const animators: Animator[] = [];

  // -------------------------------------------------------------------------
  // Torso — two lathe slices of one V-taper profile, scaled [1.08, 1, 0.72]
  // -------------------------------------------------------------------------
  const TORSO_SCALE_X = 1.08;
  const TORSO_SCALE_Z = 0.72;
  const profile = buildTorsoProfile();

  const abdomen = addMesh(upperBody, sliceTorsoLathe(profile, 0.86, 1.08, 1.0, WAIST_Y, true), suitMat);
  abdomen.scale.set(TORSO_SCALE_X, 1, TORSO_SCALE_Z);

  const chestShell = addMesh(upperBody, sliceTorsoLathe(profile, 1.035, 1.38, 1.025, WAIST_Y, false), armorMat);
  chestShell.scale.set(TORSO_SCALE_X, 1, TORSO_SCALE_Z);

  // Abdomen ribbing: front-only partial cylinders (thetaStart around PI = face)
  // whose radii follow the profile, leaving undersuit gaps between each rib.
  for (const y of [0.935, 0.98, 1.025]) {
    const rTop = torsoRadiusAt(profile, y + 0.016) + 0.011;
    const rBot = torsoRadiusAt(profile, y - 0.016) + 0.011;
    const rib = addMesh(
      upperBody,
      new THREE.CylinderGeometry(rTop, rBot, 0.03, 18, 1, false, Math.PI - 1.05, 2.1),
      armorMat,
      0,
      U(y),
      0
    );
    rib.scale.set(TORSO_SCALE_X, 1, TORSO_SCALE_Z);
  }

  // Sculpted pectoral plates (flattened spheres turned to follow the chest).
  for (const side of [-1, 1] as const) {
    const pec = addMesh(upperBody, new THREE.SphereGeometry(0.1, 18, 12), armorMat, side * 0.083, U(1.205), -0.112);
    pec.scale.set(1.0, 0.72, 0.42);
    pec.rotation.set(0, -side * 0.3, side * 0.12);

    // Neon lat trims running down each flank.
    const lat = addMesh(upperBody, new THREE.CapsuleGeometry(0.008, 0.12, 3, 8), trimMat, side * 0.212, U(1.12), -0.01);
    lat.rotation.z = side * 0.25;
  }

  // Sternum energy emblem + spine trim.
  const emblem = addMesh(upperBody, new THREE.OctahedronGeometry(0.045, 0), glowMat, 0, U(1.16), -0.15);
  emblem.scale.set(0.8, 1.15, 0.35);
  addMesh(upperBody, new THREE.CapsuleGeometry(0.009, 0.16, 3, 8), trimMat, 0, U(1.14), 0.148);

  // Collar (team undersuit) + neon collar ring + neck.
  const collar = addMesh(upperBody, new THREE.CylinderGeometry(0.078, 0.105, 0.06, 20), suitMat, 0, U(1.365), 0);
  collar.scale.set(TORSO_SCALE_X, 1, 0.85);
  const collarRing = addMesh(upperBody, new THREE.TorusGeometry(0.1, 0.008, 6, 28), trimMat, 0, U(1.338), 0);
  collarRing.rotation.x = Math.PI / 2;
  collarRing.scale.set(TORSO_SCALE_X, 0.85, 1);
  addMesh(upperBody, new THREE.CylinderGeometry(0.055, 0.062, 0.14, 14), suitMat, 0, U(1.43), 0);

  // Contoured shoulder pauldrons: open sphere domes tilted outward + neon rim.
  for (const side of [-1, 1] as const) {
    const domeTheta = Math.PI * 0.56;
    const pauldron = addMesh(
      upperBody,
      new THREE.SphereGeometry(0.108, 18, 10, 0, Math.PI * 2, 0, domeTheta),
      armorMat,
      side * 0.25,
      U(1.335),
      0
    );
    pauldron.scale.set(1, 0.82, 1.12);
    pauldron.rotation.z = -side * 0.34;
    const rim = addMesh(
      pauldron,
      new THREE.TorusGeometry(0.108 * Math.sin(domeTheta), 0.011, 6, 28),
      trimMat,
      0,
      0.108 * Math.cos(domeTheta),
      0
    );
    rim.rotation.x = Math.PI / 2;
  }

  // -------------------------------------------------------------------------
  // Pelvis, belt & pouches (fixed to bodyTiltGroup — torso twists above it)
  // -------------------------------------------------------------------------
  const pelvisProfile = [
    new THREE.Vector2(1e-4, 0.755),
    new THREE.Vector2(0.07, 0.76),
    new THREE.Vector2(0.12, 0.785),
    new THREE.Vector2(0.143, 0.83),
    new THREE.Vector2(0.146, 0.875),
    new THREE.Vector2(0.14, 0.9),
    new THREE.Vector2(1e-4, 0.905),
  ];
  const pelvis = addMesh(bodyTiltGroup, new THREE.LatheGeometry(pelvisProfile, 24), armorMat);
  pelvis.scale.set(TORSO_SCALE_X, 1, 0.78);
  const codpiece = addMesh(bodyTiltGroup, new THREE.SphereGeometry(0.07, 14, 10), armorMat, 0, 0.8, -0.098);
  codpiece.scale.set(1, 1.1, 0.5);

  const BELT_RX = 0.153 * TORSO_SCALE_X;
  const BELT_RZ = 0.153 * 0.8;
  const belt = addMesh(bodyTiltGroup, new THREE.CylinderGeometry(0.153, 0.15, 0.055, 28), suitMat, 0, 0.885, 0);
  belt.scale.set(TORSO_SCALE_X, 1, 0.8);
  const beltTrim = addMesh(bodyTiltGroup, new THREE.TorusGeometry(0.152, 0.006, 6, 32), trimMat, 0, 0.862, 0);
  beltTrim.rotation.x = Math.PI / 2;
  beltTrim.scale.set(TORSO_SCALE_X, 0.8, 1);
  const buckle = addMesh(bodyTiltGroup, new THREE.CylinderGeometry(0.026, 0.026, 0.012, 16), glowMat, 0, 0.885, -BELT_RZ - 0.004);
  buckle.rotation.x = Math.PI / 2;

  /** Places an item on the belt ellipse at angle phi (0 = back, PI = front). */
  const placeOnBelt = (mesh: THREE.Mesh, phi: number, out: number, y: number): void => {
    mesh.position.set(Math.sin(phi) * (BELT_RX + out), y, Math.cos(phi) * (BELT_RZ + out));
    mesh.rotation.y = phi; // local +Z faces radially outward
  };

  // -------------------------------------------------------------------------
  // Legs — 2-joint hip/knee chains
  // -------------------------------------------------------------------------
  function buildLeg(side: -1 | 1): LegRig {
    const hip = new THREE.Group();
    hip.position.set(side * HIP_X, HIP_Y, 0);
    bodyTiltGroup.add(hip);

    addMesh(hip, new THREE.SphereGeometry(0.082, 14, 10), suitMat);
    addMesh(hip, taperedCapsuleGeometry(0.09, 0.066, 0.42), armorMat, 0, 0.01, 0);
    // Inner-thigh undersuit panel peeks out on the medial side (team value).
    addMesh(hip, taperedCapsuleGeometry(0.075, 0.056, 0.36), suitMat, -side * 0.028, -0.02, 0.005);
    const thighTrim = addMesh(hip, new THREE.CapsuleGeometry(0.0075, 0.2, 3, 8), trimMat, side * 0.083, -0.2, -0.012);
    thighTrim.rotation.z = side * 0.04;

    const knee = new THREE.Group();
    knee.position.set(0, -THIGH_LEN, 0);
    hip.add(knee);

    addMesh(knee, new THREE.SphereGeometry(0.062, 14, 10), suitMat);
    const kneeCap = addMesh(knee, new THREE.SphereGeometry(0.06, 14, 10), armorMat, 0, -0.005, -0.052);
    kneeCap.scale.set(0.95, 1.05, 0.65);
    addMesh(knee, taperedCapsuleGeometry(0.066, 0.048, 0.4), suitMat); // calf (undersuit)
    addMesh(knee, taperedCapsuleGeometry(0.068, 0.052, 0.33), armorMat, 0, -0.04, -0.016); // shin greave
    addMesh(knee, new THREE.CapsuleGeometry(0.007, 0.16, 3, 8), trimMat, 0, -0.18, -0.08);
    addMesh(knee, new THREE.CylinderGeometry(0.056, 0.064, 0.06, 16), suitMat, 0, -0.36, -0.005);
    const ankleRing = addMesh(knee, new THREE.TorusGeometry(0.06, 0.008, 6, 20), trimMat, 0, -0.335, -0.005);
    ankleRing.rotation.x = Math.PI / 2;

    // Rounded tactical boot: hemisphere shell on a flat sole touching y = 0.
    const SOLE_H = 0.025;
    const soleY = -KNEE_TO_SOLE + SOLE_H / 2;
    const boot = addMesh(
      knee,
      new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      armorMat,
      0,
      -KNEE_TO_SOLE + SOLE_H,
      -0.035
    );
    boot.scale.set(0.068, 0.1, 0.135);
    const sole = addMesh(knee, new THREE.CylinderGeometry(1, 1, SOLE_H, 20), suitMat, 0, soleY, -0.035);
    sole.scale.set(0.072, 1, 0.14);

    return { hip, knee };
  }

  const leftLeg = buildLeg(-1);
  const rightLeg = buildLeg(1);

  // -------------------------------------------------------------------------
  // Arms — shoulder/elbow chains, driven each frame by 2-bone IK
  // -------------------------------------------------------------------------
  function buildArm(side: -1 | 1): ArmRig {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * SHOULDER_X, U(SHOULDER_Y), 0);
    upperBody.add(shoulder);

    addMesh(shoulder, new THREE.SphereGeometry(0.062, 14, 10), suitMat);
    addMesh(shoulder, taperedCapsuleGeometry(0.058, 0.048, 0.31), armorMat, 0, 0.01, 0);
    addMesh(shoulder, taperedCapsuleGeometry(0.05, 0.042, 0.26), suitMat, -side * 0.016, -0.02, 0.006);

    const elbow = new THREE.Group();
    elbow.position.set(0, -UPPER_ARM_LEN, 0);
    shoulder.add(elbow);

    addMesh(elbow, new THREE.SphereGeometry(0.046, 12, 10), suitMat);
    addMesh(elbow, taperedCapsuleGeometry(0.053, 0.041, 0.25), armorMat);
    const cuff = addMesh(elbow, new THREE.TorusGeometry(0.045, 0.008, 6, 20), trimMat, 0, -0.205, 0);
    cuff.rotation.x = Math.PI / 2;
    const hand = addMesh(elbow, new THREE.SphereGeometry(0.042, 14, 10), suitMat, 0, -FOREARM_LEN, 0);
    hand.scale.set(0.85, 1.2, 1.0);

    return { shoulder, elbow };
  }

  const leftArm = buildArm(-1);
  const rightArm = buildArm(1);

  // -------------------------------------------------------------------------
  // Head group (centre y 1.60 = head hitbox centre)
  // -------------------------------------------------------------------------
  const headGroup = new THREE.Group();
  headGroup.position.set(0, U(HEAD_CENTER_Y), 0);
  headGroup.rotation.order = 'YXZ'; // counter-yaw first, then look pitch
  upperBody.add(headGroup);

  // -------------------------------------------------------------------------
  // Archetype silhouettes — branch once on colorId (exhaustive: every
  // AgentColorId has an explicit builder; the `never` check makes TypeScript
  // flag any future colour that forgets its own silhouette).
  // -------------------------------------------------------------------------
  /** Live per-frame flags archetype animators may read (written in update()). */
  const rigFlags = { sliding: false };

  switch (colorId) {
    case 'red':
      buildBlazeDuelist();
      break;
    case 'blue':
      buildMistController();
      break;
    case 'green':
      buildPulseInitiator();
      break;
    case 'violet':
      buildUmbraController();
      break;
    case 'gold':
      buildVoltDuelist();
      break;
    default: {
      const unreachable: never = colorId;
      throw new Error(`Unknown agent colour: ${String(unreachable)}`);
    }
  }

  /** BLAZE — Agile Duelist: streamlined helmet, chevron V-visor, swept wing-fins, scarf tails, forearm blades. */
  function buildBlazeDuelist(): void {
    const helmet = addMesh(headGroup, new THREE.SphereGeometry(0.165, 26, 20), helmetMat, 0, 0.01, 0.008);
    helmet.scale.set(0.95, 1.05, 1.12);
    const jaw = addMesh(headGroup, new THREE.SphereGeometry(0.1, 18, 12), helmetMat, 0, -0.085, -0.055);
    jaw.scale.set(1.15, 0.75, 1.0);

    // Dark glass visor band (front 2 rad arc) — child of helmet, shares its scale.
    addMesh(helmet, new THREE.CylinderGeometry(0.168, 0.162, 0.07, 28, 1, false, Math.PI - 1.0, 2.0), visorGlassMat);

    // Glowing chevron "V": two capsules meeting at a low centre apex, each
    // yawed to lie tangent on the curved face (yaw = phi - PI).
    const tilt = 1.05;
    const halfLen = 0.06;
    for (const side of [-1, 1] as const) {
      const cx = side * Math.sin(tilt) * halfLen;
      const cy = -0.02 + Math.cos(tilt) * halfLen;
      const delta = Math.asin(Math.abs(cx) / 0.172);
      const arm = addMesh(helmet, new THREE.CapsuleGeometry(0.013, 0.095, 3, 8), glowMat, cx, cy, -Math.cos(delta) * 0.172);
      arm.rotation.set(0, -side * delta, -side * tilt);
    }

    // Swept crest blade + two small rear "ear" fins.
    const crest = addMesh(headGroup, new THREE.ConeGeometry(0.05, 0.24, 4), trimMat, 0, 0.12, 0.07);
    crest.scale.set(0.3, 1, 1);
    crest.rotation.x = Math.PI / 2 - 0.5;
    for (const side of [-1, 1] as const) {
      const ear = addMesh(headGroup, new THREE.ConeGeometry(0.035, 0.16, 4), helmetMat, side * 0.135, 0.04, 0.08);
      ear.scale.set(0.3, 1, 1);
      ear.rotation.set(Math.PI / 2 - 0.35, side * 0.35, 0);
    }

    // Twin energy wing-fins angling off the upper back (+Z).
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0);
    finShape.quadraticCurveTo(0.16, 0.06, 0.4, 0.22);
    finShape.quadraticCurveTo(0.24, 0.05, 0.08, -0.06);
    finShape.closePath();

    const scarfShape = new THREE.Shape();
    scarfShape.moveTo(0, 0.025);
    scarfShape.quadraticCurveTo(0.16, 0.0, 0.34, -0.2);
    scarfShape.lineTo(0.33, -0.235);
    scarfShape.quadraticCurveTo(0.15, -0.04, 0, -0.025);
    scarfShape.closePath();

    const fins: Array<{ node: THREE.Mesh; side: number }> = [];
    const scarves: Array<{ node: THREE.Mesh; side: number }> = [];
    for (const side of [-1, 1] as const) {
      const fin = addMesh(upperBody, extrudeBackward(finShape, 0.014), trimMat, side * 0.075, U(1.3), 0.12);
      fin.rotation.order = 'YXZ';
      fin.rotation.set(-0.15, side * 0.5, -side * 0.35);
      fins.push({ node: fin, side });

      const scarf = addMesh(upperBody, extrudeBackward(scarfShape, 0.01), armorMat, side * 0.035, U(1.36), 0.1);
      scarf.rotation.order = 'YXZ';
      scarf.rotation.set(0.4, side * 0.18, 0);
      scarves.push({ node: scarf, side });
    }

    // Bladed forearm guards along the outer gauntlet.
    for (const [arm, side] of [[leftArm, -1], [rightArm, 1]] as const) {
      const blade = addMesh(arm.elbow, new THREE.ConeGeometry(0.035, 0.26, 4), trimMat, side * 0.05, -0.1, 0);
      blade.scale.set(0.25, 1, 1);
    }

    // Belt pouches.
    for (const phi of [Math.PI - 0.8, Math.PI + 0.8, 1.9, -1.9]) {
      const pouch = addMesh(bodyTiltGroup, new THREE.CapsuleGeometry(0.026, 0.035, 4, 10), armorMat);
      pouch.scale.set(1, 1, 0.6);
      placeOnBelt(pouch, phi, 0.012, 0.872);
    }

    animators.push((time, _dt, motion) => {
      for (const f of fins) {
        // Fins sweep flatter as speed rises, with a subtle energy flutter.
        f.node.rotation.x = -0.15 + motion * 0.22 + Math.sin(time * 3.2 + f.side) * 0.035;
      }
      for (const s of scarves) {
        // Tails hang at rest and stream out behind when running.
        s.node.rotation.x = 0.55 - motion * 0.5 + Math.sin(time * (5 + motion * 6) + s.side * 1.3) * (0.05 + motion * 0.08);
      }
    });
  }

  /** MIST — Shrouded Controller: lathe hood over a shadow mask with 3 optic slits, hovering emitters, cryo canisters. */
  function buildMistController(): void {
    // Hood: a partial lathe sweep that skips ±0.85 rad around the face (phi = PI).
    const hoodProfile = [
      new THREE.Vector2(0.19, -0.23),
      new THREE.Vector2(0.205, -0.14),
      new THREE.Vector2(0.215, -0.04),
      new THREE.Vector2(0.212, 0.06),
      new THREE.Vector2(0.19, 0.14),
      new THREE.Vector2(0.14, 0.205),
      new THREE.Vector2(0.07, 0.235),
      new THREE.Vector2(1e-4, 0.242),
    ];
    const hood = addMesh(
      headGroup,
      new THREE.LatheGeometry(hoodProfile, 30, Math.PI + 0.85, Math.PI * 2 - 1.7),
      helmetMat,
      0,
      0,
      0.012
    );
    hood.scale.set(1, 1, 1.08);

    // Recessed shadow mask filling the hood opening.
    const mask = addMesh(headGroup, new THREE.SphereGeometry(0.15, 22, 16), shadowMat, 0, -0.005, -0.005);
    mask.scale.set(0.94, 1.05, 1.0);
    const respirator = addMesh(headGroup, new THREE.SphereGeometry(0.085, 16, 10), suitMat, 0, -0.095, -0.07);
    respirator.scale.set(1.1, 0.7, 0.8);

    // Three optic slits: two horizontal eyes + one vertical brow slit.
    for (const side of [-1, 1] as const) {
      const eye = addMesh(headGroup, new THREE.CapsuleGeometry(0.011, 0.05, 3, 8), glowMat, side * 0.047, 0.015, -0.145);
      eye.rotation.set(0, -side * 0.32, Math.PI / 2);
    }
    addMesh(headGroup, new THREE.CapsuleGeometry(0.009, 0.045, 3, 8), glowMat, 0, 0.078, -0.134);

    // Two hovering cyan emitters above the pauldrons with orbit rings.
    const emitters: Array<{ orb: THREE.Mesh; ring: THREE.Mesh; side: number }> = [];
    for (const side of [-1, 1] as const) {
      const orb = addMesh(upperBody, new THREE.SphereGeometry(0.042, 16, 12), glowMat, side * 0.28, U(1.55), 0.03);
      const ring = addMesh(orb, new THREE.TorusGeometry(0.07, 0.006, 6, 24), trimMat);
      emitters.push({ orb, ring, side });
    }

    // Cryo canisters clipped to the belt (sides / back) with glowing cores.
    for (const phi of [Math.PI / 2 + 0.55, -(Math.PI / 2 + 0.55), 0.0]) {
      const can = addMesh(bodyTiltGroup, new THREE.CylinderGeometry(0.03, 0.03, 0.11, 14), suitMat);
      placeOnBelt(can, phi, 0.03, 0.86);
      const core = addMesh(can, new THREE.CylinderGeometry(0.032, 0.032, 0.035, 14), glowMat);
      core.position.y = 0;
      addMesh(can, new THREE.CylinderGeometry(0.022, 0.03, 0.02, 14), armorMat, 0, 0.065, 0);
    }
    for (const phi of [Math.PI - 0.8, Math.PI + 0.8]) {
      const pouch = addMesh(bodyTiltGroup, new THREE.CapsuleGeometry(0.026, 0.035, 4, 10), armorMat);
      pouch.scale.set(1, 1, 0.6);
      placeOnBelt(pouch, phi, 0.012, 0.872);
    }

    animators.push((time) => {
      for (const e of emitters) {
        e.orb.position.y = U(1.55) + Math.sin(time * 2.4 + e.side * 1.7) * 0.025;
        e.ring.rotation.x = time * 1.9 + e.side;
        e.ring.rotation.y = time * 1.3;
      }
    });
  }

  /** PULSE — Tech Initiator: wrap-around recon goggles, asymmetric antenna, bio-pulse backpack with spinning core. */
  function buildPulseInitiator(): void {
    const helmet = addMesh(headGroup, new THREE.SphereGeometry(0.165, 26, 20), helmetMat, 0, 0.01, 0);
    helmet.scale.set(0.98, 1.04, 1.04);
    const jaw = addMesh(headGroup, new THREE.SphereGeometry(0.1, 18, 12), helmetMat, 0, -0.088, -0.05);
    jaw.scale.set(1.2, 0.72, 1.0);

    // Goggle frame (team colour) behind a glowing wrap-around lens + strap.
    addMesh(helmet, new THREE.CylinderGeometry(0.168, 0.164, 0.085, 30, 1, false, Math.PI - 1.38, 2.76), suitMat, 0, 0.01, 0);
    addMesh(helmet, new THREE.CylinderGeometry(0.172, 0.168, 0.058, 30, 1, false, Math.PI - 1.3, 2.6), glowMat, 0, 0.01, 0);
    const strap = addMesh(helmet, new THREE.TorusGeometry(0.163, 0.012, 6, 30), suitMat, 0, 0.01, 0);
    strap.rotation.x = Math.PI / 2;

    // Asymmetric comms antenna on the LEFT side of the helmet.
    const antenna = new THREE.Group();
    antenna.position.set(-0.158, 0.03, 0.045);
    antenna.rotation.set(0.3, 0, 0.18); // lean back (+Z) and outward (-X)
    headGroup.add(antenna);
    const puck = addMesh(antenna, new THREE.CylinderGeometry(0.034, 0.034, 0.03, 16), suitMat);
    puck.rotation.z = Math.PI / 2;
    const puckRing = addMesh(antenna, new THREE.TorusGeometry(0.026, 0.005, 6, 16), glowMat, -0.016, 0, 0);
    puckRing.rotation.y = Math.PI / 2;
    addMesh(antenna, new THREE.CylinderGeometry(0.005, 0.009, 0.28, 8), suitMat, 0, 0.15, 0);
    const antennaTip = addMesh(antenna, new THREE.SphereGeometry(0.014, 10, 8), glowMat, 0, 0.295, 0);

    // Bio-pulse generator backpack: rounded lathe housing + core cage.
    const pack = addMesh(upperBody, taperedCapsuleGeometry(0.095, 0.082, 0.31, 18), armorMat, 0, U(1.31), 0.17);
    pack.scale.set(1.15, 1, 0.6);
    for (const side of [-1, 1] as const) {
      addMesh(upperBody, new THREE.CylinderGeometry(0.02, 0.02, 0.26, 10), suitMat, side * 0.1, U(1.16), 0.17);
    }
    const coreRing = addMesh(upperBody, new THREE.TorusGeometry(0.068, 0.012, 8, 28), trimMat, 0, U(1.16), 0.232);
    const core = addMesh(upperBody, new THREE.OctahedronGeometry(0.045, 0), glowMat, 0, U(1.16), 0.25);

    // Tech emitters on knee caps and forearm gauntlets.
    for (const leg of [leftLeg, rightLeg]) {
      const disc = addMesh(leg.knee, new THREE.CylinderGeometry(0.02, 0.02, 0.008, 14), glowMat, 0, -0.005, -0.092);
      disc.rotation.x = Math.PI / 2;
    }
    for (const [arm, side] of [[leftArm, -1], [rightArm, 1]] as const) {
      const disc = addMesh(arm.elbow, new THREE.CylinderGeometry(0.018, 0.018, 0.008, 14), glowMat, side * 0.05, -0.12, 0);
      disc.rotation.z = Math.PI / 2;
    }
    for (const phi of [Math.PI - 0.8, Math.PI + 0.8, 1.9, -1.9]) {
      const pouch = addMesh(bodyTiltGroup, new THREE.CapsuleGeometry(0.026, 0.035, 4, 10), armorMat);
      pouch.scale.set(1, 1, 0.6);
      placeOnBelt(pouch, phi, 0.012, 0.872);
    }

    animators.push((time, dt) => {
      core.rotation.y += dt * 3.2;
      core.rotation.x += dt * 1.4;
      const pulse = 1 + Math.sin(time * 4.0) * 0.08;
      coreRing.scale.set(pulse, pulse, 1);
      antennaTip.scale.setScalar(Math.sin(time * 6.0) > 0.6 ? 1.35 : 1.0); // comms blink
    });
  }

  /**
   * UMBRA — Shadow Controller / Smoker: a bell-shaped lathe cowl open at the
   * face over a recessed void mask with one thin amethyst slit, three dorsal
   * censer vials whose cores bob out of phase, and two translucent shadow-veil
   * ribbons that ripple and stream behind when moving.
   */
  function buildUmbraController(): void {
    // Bell cowl profile (radius, height) in head-local space, bottom -> crown.
    // The flared hem drapes onto the shoulders like a monk's hood.
    const cowlProfile = [
      new THREE.Vector2(0.25, -0.27),
      new THREE.Vector2(0.235, -0.2),
      new THREE.Vector2(0.218, -0.11),
      new THREE.Vector2(0.214, -0.02),
      new THREE.Vector2(0.205, 0.07),
      new THREE.Vector2(0.18, 0.15),
      new THREE.Vector2(0.13, 0.215),
      new THREE.Vector2(0.065, 0.245),
      new THREE.Vector2(1e-4, 0.252),
    ];
    // phiLength = 1.6π starting at 1.2π leaves a 0.4π gap centred on phi = π (the face).
    const COWL_PHI_START = Math.PI * 1.2;
    const COWL_PHI_LENGTH = Math.PI * 1.6;
    const cowl = addMesh(
      headGroup,
      new THREE.LatheGeometry(cowlProfile, 34, COWL_PHI_START, COWL_PHI_LENGTH),
      helmetMat,
      0,
      0,
      0.015
    );
    cowl.scale.set(1, 1, 1.08);

    // Inner lining: the same sweep slightly smaller, rendered BackSide so the
    // inside of the hood reads as deep shadow when seen through the opening.
    const liningMat = new THREE.MeshStandardMaterial({ color: 0x07020d, roughness: 0.95, metalness: 0.0, side: THREE.BackSide });
    const lining = addMesh(cowl, new THREE.LatheGeometry(cowlProfile, 34, COWL_PHI_START, COWL_PHI_LENGTH), liningMat);
    lining.scale.setScalar(0.97);

    // Neon hem trim — a partial torus whose arc matches the cowl sweep.
    // Torus angle a maps to lathe phi = π/2 - a after the +π/2 X rotation, so
    // pre-rotating by -0.3π about Z makes the 1.6π arc cover phi ∈ [-0.8π, 0.8π].
    const hem = addMesh(cowl, new THREE.TorusGeometry(0.25, 0.009, 6, 40, COWL_PHI_LENGTH), trimMat, 0, -0.27, 0);
    hem.rotation.set(Math.PI / 2, 0, -0.3 * Math.PI);

    // Recessed void mask + one thin curved amethyst slit visor.
    const mask = addMesh(headGroup, new THREE.SphereGeometry(0.15, 22, 16), shadowMat, 0, -0.005, -0.005);
    mask.scale.set(0.94, 1.05, 1.0);
    addMesh(mask, new THREE.CylinderGeometry(0.153, 0.153, 0.013, 26, 1, true, Math.PI - 0.6, 1.2), glowMat, 0, 0.018, 0);

    // Dorsal censer vials stacked along the spine on a support rod.
    addMesh(upperBody, new THREE.CylinderGeometry(0.011, 0.011, 0.36, 8), suitMat, 0, U(1.15), 0.158);
    const capProfile = [
      new THREE.Vector2(1e-4, -0.012),
      new THREE.Vector2(0.024, -0.012),
      new THREE.Vector2(0.031, -0.004),
      new THREE.Vector2(0.031, 0.004),
      new THREE.Vector2(0.02, 0.012),
      new THREE.Vector2(1e-4, 0.013),
    ];
    const censerCores: THREE.Mesh[] = [];
    const VIAL_Y = [1.29, 1.155, 1.02];
    VIAL_Y.forEach((worldY, i) => {
      const vial = new THREE.Group();
      vial.position.set(0, U(worldY), 0.182 - (i === 2 ? 0.01 : 0));
      upperBody.add(vial);
      addMesh(vial, new THREE.LatheGeometry(capProfile, 16), armorMat, 0, -0.045, 0);
      const top = addMesh(vial, new THREE.LatheGeometry(capProfile, 16), armorMat, 0, 0.045, 0);
      top.rotation.x = Math.PI; // mirrored cap
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2;
        addMesh(vial, new THREE.CylinderGeometry(0.0035, 0.0035, 0.08, 6), suitMat, Math.sin(a) * 0.026, 0, Math.cos(a) * 0.026);
      }
      censerCores.push(addMesh(vial, new THREE.SphereGeometry(0.018, 12, 10), glowMat));
    });

    // Shadow-veil ribbons: translucent tapered planes hanging from the shoulder
    // blades. Their vertices ripple in place each frame (no allocation).
    const veilMat = new THREE.MeshStandardMaterial({
      color: 0x1a0830,
      emissive: agent.primary,
      emissiveIntensity: 0.22,
      roughness: 0.8,
      metalness: 0.05,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
    });
    const VEIL_LEN = 0.62;
    const veils: Array<{ node: THREE.Mesh; side: number; base: Float32Array }> = [];
    for (const side of [-1, 1] as const) {
      const geo = new THREE.PlaneGeometry(0.12, VEIL_LEN, 1, 10);
      geo.translate(0, -VEIL_LEN / 2, 0);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      for (let v = 0; v < pos.count; v++) {
        const t = -pos.getY(v) / VEIL_LEN; // 0 at shoulder .. 1 at tip
        pos.setX(v, pos.getX(v) * (1 - 0.65 * t)); // taper toward a point
      }
      const veil = addMesh(upperBody, geo, veilMat, side * 0.11, U(1.34), 0.15);
      veil.rotation.z = side * 0.06;
      veils.push({ node: veil, side, base: Float32Array.from(pos.array as Float32Array) });
    }

    // Belt shadow capsules (void-charge grenades) + front pouches.
    for (const phi of [Math.PI / 2 + 0.5, -(Math.PI / 2 + 0.5), 0.45, -0.45]) {
      const cap = addMesh(bodyTiltGroup, new THREE.CapsuleGeometry(0.024, 0.05, 4, 10), shadowMat);
      placeOnBelt(cap, phi, 0.03, 0.86);
      const band = addMesh(cap, new THREE.TorusGeometry(0.025, 0.004, 6, 16), glowMat);
      band.rotation.x = Math.PI / 2;
    }
    for (const phi of [Math.PI - 0.8, Math.PI + 0.8]) {
      const pouch = addMesh(bodyTiltGroup, new THREE.CapsuleGeometry(0.026, 0.035, 4, 10), armorMat);
      pouch.scale.set(1, 1, 0.6);
      placeOnBelt(pouch, phi, 0.012, 0.872);
    }

    animators.push((time, _dt, motion) => {
      // Censer cores bob out of phase: sin(time * 2 + i).
      for (let i = 0; i < censerCores.length; i++) {
        censerCores[i].position.y = Math.sin(time * 2 + i) * 0.014;
      }
      for (const v of veils) {
        // Negative X rotation swings a hanging plane toward +Z (behind the agent).
        v.node.rotation.x = -(0.1 + motion * 0.75 + Math.sin(time * 2.2 + v.side) * 0.06);
        const pos = v.node.geometry.attributes.position as THREE.BufferAttribute;
        const arr = pos.array as Float32Array;
        for (let k = 0; k < pos.count; k++) {
          const t = -v.base[k * 3 + 1] / VEIL_LEN;
          arr[k * 3 + 2] = v.base[k * 3 + 2] + Math.sin(time * (3 + motion * 4) - t * 6 + v.side) * 0.035 * t;
        }
        pos.needsUpdate = true;
      }
    });
  }

  /**
   * VOLT — Electric Duelist: low aero speedster helmet with a 2.6 rad
   * wraparound visor, twin dorsal lightning-coil struts with spinning cores,
   * aerodynamic calf fins, and a pooled zig-zag arc that crackles heel ->
   * coil -> coil -> heel while sprinting or power-sliding.
   */
  function buildVoltDuelist(): void {
    const helmet = addMesh(headGroup, new THREE.SphereGeometry(0.16, 26, 20), helmetMat, 0, 0.0, 0.01);
    helmet.scale.set(0.94, 0.9, 1.2);
    const jaw = addMesh(headGroup, new THREE.SphereGeometry(0.095, 18, 12), helmetMat, 0, -0.085, -0.05);
    jaw.scale.set(1.1, 0.7, 1.0);
    // Swept aero tail: cone rotated to point backward (+Y -> +Z), flattened vertically.
    const tail = addMesh(headGroup, new THREE.ConeGeometry(0.07, 0.2, 12), helmetMat, 0, 0.03, 0.17);
    tail.rotation.x = Math.PI / 2;
    tail.scale.set(1.2, 1, 0.5);

    // Dark backing band + 2.6 rad wraparound electric visor strip (children of
    // the helmet so they share its aero scale).
    addMesh(helmet, new THREE.CylinderGeometry(0.161, 0.157, 0.075, 32, 1, true, Math.PI - 1.36, 2.72), visorGlassMat, 0, 0.01, 0);
    addMesh(helmet, new THREE.CylinderGeometry(0.164, 0.159, 0.045, 32, 1, true, Math.PI - 1.3, 2.6), glowMat, 0, 0.01, 0);
    addMesh(helmet, zCapsuleGeometry(0.008, 0.2), trimMat, 0, 0.157, 0.02); // crest stripe

    // Twin dorsal lightning-coil struts.
    const coilCores: THREE.Mesh[] = [];
    const coilKnots: THREE.Mesh[] = [];
    for (const side of [-1, 1] as const) {
      const coil = new THREE.Group();
      coil.position.set(side * 0.085, U(1.2), 0.17);
      coil.rotation.set(-0.15, 0, -side * 0.18); // lean back, splay outward
      upperBody.add(coil);
      addMesh(coil, new THREE.SphereGeometry(0.026, 12, 10), armorMat, 0, -0.1, 0);
      addMesh(coil, new THREE.CylinderGeometry(0.011, 0.015, 0.3, 10), suitMat, 0, 0.05, 0);
      for (const y of [-0.02, 0.03, 0.08]) {
        const ring = addMesh(coil, new THREE.TorusGeometry(0.028, 0.0055, 6, 20), trimMat, 0, y, 0);
        ring.rotation.x = Math.PI / 2;
      }
      const knot = addMesh(coil, new THREE.TorusKnotGeometry(0.026, 0.0055, 48, 6, 2, 3), trimMat, 0, 0.17, 0);
      coilKnots.push(knot);
      coilCores.push(addMesh(coil, new THREE.OctahedronGeometry(0.02, 0), glowMat, 0, 0.17, 0));
    }

    // Aerodynamic calf fins (shape x = backward, y = up) + heel arc anchors.
    const calfFin = new THREE.Shape();
    calfFin.moveTo(0, 0.07);
    calfFin.quadraticCurveTo(0.06, 0.02, 0.11, -0.03);
    calfFin.lineTo(0.02, -0.08);
    calfFin.lineTo(0, -0.06);
    calfFin.closePath();
    const heelAnchors: THREE.Object3D[] = [];
    for (const [leg, side] of [[leftLeg, -1], [rightLeg, 1]] as const) {
      const fin = addMesh(leg.knee, extrudeBackward(calfFin, 0.008), trimMat, side * 0.035, -0.2, 0.045);
      fin.rotation.y = side * 0.35; // +Y rotation turns +Z toward +X: fins angle outward
      const heel = new THREE.Object3D();
      heel.position.set(0, -KNEE_TO_SOLE + 0.05, 0.07);
      leg.knee.add(heel);
      heelAnchors.push(heel);
    }

    // Forearm lightning stripes + belt power cells.
    for (const [arm, side] of [[leftArm, -1], [rightArm, 1]] as const) {
      const stripe = addMesh(arm.elbow, new THREE.CapsuleGeometry(0.006, 0.12, 3, 8), glowMat, side * 0.05, -0.12, 0);
      stripe.rotation.z = side * 0.25;
    }
    for (const phi of [Math.PI - 0.8, Math.PI + 0.8, 1.9, -1.9]) {
      const cell = addMesh(bodyTiltGroup, new THREE.CylinderGeometry(0.022, 0.022, 0.06, 12), suitMat);
      placeOnBelt(cell, phi, 0.02, 0.868);
      addMesh(cell, new THREE.CylinderGeometry(0.0235, 0.0235, 0.014, 12), glowMat);
    }

    // ---------------------------------------------------------------------
    // Pooled electric arc. ONE preallocated Float32Array is rewritten in place
    // (no per-frame allocation). The zig-zag jitter is reseeded every ~50 ms
    // (a strobe rate that reads as "crackling"), while the anchor-following
    // base path is refreshed every frame so the bolt never detaches from the
    // limbs. Jitter is weighted by sin(πt) so each leg stays pinned to its
    // two anchors.
    // ---------------------------------------------------------------------
    const arcPositions = new Float32Array(ARC_POINT_COUNT * 3);
    const arcJitter = new Float32Array(ARC_POINT_COUNT * 3);
    const arcGeo = new THREE.BufferGeometry();
    const arcAttr = new THREE.BufferAttribute(arcPositions, 3);
    arcAttr.setUsage(THREE.DynamicDrawUsage);
    arcGeo.setAttribute('position', arcAttr);
    const arcMat = new THREE.LineBasicMaterial({
      color: 0xfff6b0,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const arcLine = new THREE.Line(arcGeo, arcMat);
    arcLine.frustumCulled = false; // bounds change every frame
    arcLine.visible = false;
    bodyTiltGroup.add(arcLine);

    const arcAnchors = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const arcNodes: THREE.Object3D[] = [heelAnchors[0], coilCores[0], coilCores[1], heelAnchors[1]];
    let arcReseedTimer = 0;
    let arcFlickerOn = true;

    animators.push((time, dt, motion) => {
      for (let i = 0; i < coilCores.length; i++) {
        coilCores[i].rotation.y += dt * (6 + motion * 10);
        coilCores[i].rotation.x += dt * 2.2;
        coilKnots[i].rotation.y -= dt * (3 + motion * 6);
      }

      const active = motion > 0.8 || rigFlags.sliding;
      if (!active) {
        arcLine.visible = false;
        arcReseedTimer = 0;
        return;
      }

      arcReseedTimer -= dt;
      if (arcReseedTimer <= 0) {
        arcReseedTimer = ARC_RESEED_SEC;
        arcFlickerOn = Math.random() > 0.15;
        for (let k = 0; k < arcJitter.length; k++) {
          arcJitter[k] = (Math.random() * 2 - 1) * 0.045;
        }
      }
      arcLine.visible = arcFlickerOn;
      if (!arcFlickerOn) return;

      for (let a = 0; a < 4; a++) pointInSpace(arcNodes[a], bodyTiltGroup, arcAnchors[a]);
      let idx = 0;
      for (let leg = 0; leg < 3; leg++) {
        const A = arcAnchors[leg];
        const B = arcAnchors[leg + 1];
        for (let s = leg === 0 ? 0 : 1; s <= ARC_SEGMENTS_PER_LEG; s++) {
          const t = s / ARC_SEGMENTS_PER_LEG;
          const w = Math.sin(Math.PI * t);
          const o = idx * 3;
          arcPositions[o] = A.x + (B.x - A.x) * t + arcJitter[o] * w;
          arcPositions[o + 1] = A.y + (B.y - A.y) * t + arcJitter[o + 1] * w;
          arcPositions[o + 2] = A.z + (B.z - A.z) * t + arcJitter[o + 2] * w;
          idx++;
        }
      }
      arcAttr.needsUpdate = true;
      arcMat.opacity = 0.7 + 0.3 * Math.abs(Math.sin(time * 41));
    });
  }

  // -------------------------------------------------------------------------
  // Weapon aim pivot + swappable props
  // -------------------------------------------------------------------------
  const aimPivot = new THREE.Group();
  aimPivot.rotation.order = 'YXZ';
  upperBody.add(aimPivot);
  const weaponSocket = new THREE.Group();
  aimPivot.add(weaponSocket);

  const weaponProps = buildWeaponProps(trimMat, glowMat);
  const WEAPON_IDS: WeaponId[] = ['pistol', 'smg', 'ar', 'sniper'];
  for (const id of WEAPON_IDS) {
    weaponProps[id].group.visible = id === 'ar';
    weaponSocket.add(weaponProps[id].group);
  }
  let activeWeapon: WeaponId = 'ar';

  // -------------------------------------------------------------------------
  // Floor team ring + overhead indicators (children of root, never tilted)
  // -------------------------------------------------------------------------
  const teamRingMat = new THREE.MeshBasicMaterial({
    color: teamStyle.ring,
    transparent: true,
    opacity: teamStyle.ringOpacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const teamRing = addMesh(root, new THREE.RingGeometry(0.36, 0.43, 32), teamRingMat, 0, 0.02, 0);
  teamRing.rotation.x = -Math.PI / 2;

  const healthBarGroup = new THREE.Group();
  healthBarGroup.position.set(0, HEALTH_BAR_Y, 0);
  root.add(healthBarGroup);

  const frameMat = new THREE.MeshBasicMaterial({ color: teamStyle.barFrame, side: THREE.DoubleSide, transparent: true, opacity: 0.95 });
  addMesh(healthBarGroup, new THREE.PlaneGeometry(HEALTH_BAR_WIDTH + 0.1, HEALTH_BAR_HEIGHT + 0.05), frameMat);
  const barBgMat = new THREE.MeshBasicMaterial({ color: 0x0b0e14, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
  addMesh(healthBarGroup, new THREE.PlaneGeometry(HEALTH_BAR_WIDTH + 0.06, HEALTH_BAR_HEIGHT + 0.022), barBgMat, 0, 0, 0.002);

  // Left-anchored fills so `scale.x` drains right-to-left.
  const makeFillGeo = (): THREE.PlaneGeometry => {
    const geo = new THREE.PlaneGeometry(HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT);
    geo.translate(HEALTH_BAR_WIDTH / 2, 0, 0);
    return geo;
  };
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.6 });
  const ghostFill = addMesh(healthBarGroup, makeFillGeo(), ghostMat, -HEALTH_BAR_WIDTH / 2, 0, 0.004);
  const healthFillMat = new THREE.MeshBasicMaterial({ color: agent.primary, side: THREE.DoubleSide });
  const healthFill = addMesh(healthBarGroup, makeFillGeo(), healthFillMat, -HEALTH_BAR_WIDTH / 2, 0, 0.006);

  // Team badge on the left edge: ally = cyan-white disc, enemy = red diamond pip.
  const badgeX = -(HEALTH_BAR_WIDTH + 0.1) / 2 - 0.03;
  const badgeMat = new THREE.MeshBasicMaterial({ color: teamStyle.badge, side: THREE.DoubleSide });
  if (isEnemy) {
    const pipBack = addMesh(healthBarGroup, new THREE.PlaneGeometry(0.09, 0.09), frameMat, badgeX, 0, 0.006);
    pipBack.rotation.z = Math.PI / 4;
    const pip = addMesh(healthBarGroup, new THREE.PlaneGeometry(0.065, 0.065), badgeMat, badgeX, 0, 0.008);
    pip.rotation.z = Math.PI / 4;
  } else {
    addMesh(healthBarGroup, new THREE.CircleGeometry(0.058, 20), frameMat, badgeX, 0, 0.006);
    addMesh(healthBarGroup, new THREE.CircleGeometry(0.042, 20), badgeMat, badgeX, 0, 0.008);
  }

  const blindHaloMat = new THREE.MeshBasicMaterial({ color: 0xc8ffe0, side: THREE.DoubleSide });
  const blindHalo = addMesh(root, new THREE.TorusGeometry(0.28, 0.026, 6, 16), blindHaloMat, 0, BLIND_HALO_Y, 0);
  blindHalo.rotation.x = Math.PI * 0.42;
  blindHalo.visible = false;

  scene.add(root);

  // -------------------------------------------------------------------------
  // Animation & visual state
  // -------------------------------------------------------------------------
  let time = 0;
  let gaitPhase = 0;
  let strideAmpSmoothed = 0;
  let airBlend = 0;
  let recoilKick = 0;
  let hitFlashTimer = 0;
  let lastHitWasHeadshot = false;
  let wasAlive = true;
  let ghostRatio = 1;
  let slideBlend = 0; // 0 = normal gait .. 1 = full Power-Slide pose

  const _shimmerColor = new THREE.Color();
  const _shimmerTarget = new THREE.Color(CONCUSS_SHIMMER_HEX);
  const _agentColor = new THREE.Color(agent.primary);

  const _aimBase = new THREE.Vector3();
  const _gripTarget = new THREE.Vector3();
  const _supportTarget = new THREE.Vector3();
  const RIGHT_ELBOW_POLE = new THREE.Vector3(0.7, -1, 0.3).normalize();
  const LEFT_ELBOW_POLE = new THREE.Vector3(-0.6, -1, 0.0).normalize();

  /** Composes local matrices from `node` up to `upperBody` (no world update needed). */
  function pointInUpperBody(node: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
    return pointInSpace(node, upperBody, out);
  }

  /** Origin of `node` expressed in the local space of ancestor `space` (allocation-free). */
  function pointInSpace(node: THREE.Object3D, space: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    let cur: THREE.Object3D | null = node;
    while (cur && cur !== space) {
      cur.updateMatrix();
      out.applyMatrix4(cur.matrix);
      cur = cur.parent;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Design Note D — Analytic 2-bone IK for the arms
  // -------------------------------------------------------------------------
  // Legs use pure FK (we *choose* joint angles from the gait clock). Arms
  // instead must land the hands exactly on the weapon's grip and foregrip, so
  // we invert the problem: given a target T, find shoulder + elbow angles.
  //   1. Law of cosines on the triangle (shoulder, elbow, T) with sides
  //      L1, L2, D = |T - S| gives the shoulder-offset angle α and elbow bend.
  //   2. A "pole" hint chooses which way the elbow points (down & out).
  //   3. We build the shoulder's orthonormal basis directly: local -Y runs down
  //      the upper arm, local -Z is the bend direction (because +θ about +X
  //      swings a downward limb toward -Z), X = Y × Z. Then the elbow is just
  //      `rotation.x = PI - interiorAngle` — a 1-DOF hinge like a real elbow.
  const _ikDir = new THREE.Vector3();
  const _ikPole = new THREE.Vector3();
  const _ikU = new THREE.Vector3();
  const _ikElbow = new THREE.Vector3();
  const _ikF = new THREE.Vector3();
  const _ikB = new THREE.Vector3();
  const _ikX = new THREE.Vector3();
  const _ikY = new THREE.Vector3();
  const _ikZ = new THREE.Vector3();
  const _ikBasis = new THREE.Matrix4();

  function solveArmIK(arm: ArmRig, target: THREE.Vector3, poleHint: THREE.Vector3): void {
    const L1 = UPPER_ARM_LEN;
    const L2 = FOREARM_LEN;
    const s = arm.shoulder.position;
    _ikDir.subVectors(target, s);
    const dist = _ikDir.length();
    if (dist < 1e-5) {
      _ikDir.set(0, -1, 0);
    } else {
      _ikDir.divideScalar(dist);
    }
    const reach = clamp(dist, Math.abs(L1 - L2) + 0.01, L1 + L2 - 0.002);

    _ikPole.copy(poleHint).addScaledVector(_ikDir, -poleHint.dot(_ikDir));
    if (_ikPole.lengthSq() < 1e-8) {
      _ikPole.set(0, 0, 1).addScaledVector(_ikDir, -_ikDir.z);
    }
    _ikPole.normalize();

    const cosA = clamp((L1 * L1 + reach * reach - L2 * L2) / (2 * L1 * reach), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    _ikU.copy(_ikDir).multiplyScalar(cosA).addScaledVector(_ikPole, sinA);
    _ikElbow.copy(s).addScaledVector(_ikU, L1);
    _ikF.copy(s).addScaledVector(_ikDir, reach).sub(_ikElbow).normalize();

    _ikB.copy(_ikF).addScaledVector(_ikU, -_ikF.dot(_ikU));
    if (_ikB.lengthSq() < 1e-8) {
      _ikB.copy(_ikPole).negate().addScaledVector(_ikU, _ikPole.dot(_ikU));
    }
    _ikB.normalize();

    _ikY.copy(_ikU).negate();
    _ikZ.copy(_ikB).negate();
    _ikX.crossVectors(_ikY, _ikZ);
    _ikBasis.makeBasis(_ikX, _ikY, _ikZ);
    arm.shoulder.quaternion.setFromRotationMatrix(_ikBasis);

    const cosE = clamp((L1 * L1 + L2 * L2 - reach * reach) / (2 * L1 * L2), -1, 1);
    arm.elbow.rotation.set(Math.PI - Math.acos(cosE), 0, 0);
  }

  function setWeaponModel(weaponId: WeaponId): void {
    activeWeapon = weaponId;
    for (const id of WEAPON_IDS) {
      weaponProps[id].group.visible = id === weaponId;
    }
  }

  function triggerFireKick(): void {
    recoilKick = activeWeapon === 'sniper' ? 0.42 : 0.26;
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
      slideTimer?: number;
      concussTimer?: number;
    },
    cameraPos: Vec3
  ): void {
    const stepDt = clamp(dt, 0, 0.1);
    time += stepDt;
    const sliding = (state.slideTimer ?? 0) > 0;
    rigFlags.sliding = sliding && state.alive;

    root.position.set(state.position.x, state.position.y, state.position.z);
    root.rotation.y = state.yaw;

    // Death collapse: exponential smoothing `θ += (target - θ)(1 - e^(-k dt))`
    // around the sole pivot topples the whole rig forward, frame-rate independent.
    if (!state.alive) {
      wasAlive = false;
      const collapseAlpha = 1 - Math.exp(-10 * stepDt);
      bodyTiltGroup.rotation.x += (DEATH_TILT_TARGET_RAD - bodyTiltGroup.rotation.x) * collapseAlpha;
      // Let any slide crouch rise back out so the corpse doesn't sink into the floor.
      slideBlend *= Math.exp(-14 * stepDt);
      bodyTiltGroup.position.y = SLIDE_DROP_M * slideBlend;
      healthBarGroup.visible = false;
      blindHalo.visible = false;
      teamRing.visible = false;
      return;
    }

    if (!wasAlive) {
      wasAlive = true;
      bodyTiltGroup.rotation.x = 0;
      bodyTiltGroup.position.y = 0;
      slideBlend = 0;
      gaitPhase = 0;
      strideAmpSmoothed = 0;
      airBlend = 0;
      recoilKick = 0;
      hitFlashTimer = 0;
      ghostRatio = 1;
    } else {
      bodyTiltGroup.rotation.x *= Math.exp(-14 * stepDt);
    }
    teamRing.visible = true;

    // -----------------------------------------------------------------------
    // Design Note E — 2-joint walk gait (hip + knee Forward Kinematics)
    // -----------------------------------------------------------------------
    // Facing -Z, rotating about +X by +θ maps the downward limb (0,-1,0) to
    // (0, -cos θ, -sin θ): +θ swings a leg FORWARD, -θ swings it BACK.
    //   hipL  =  sin(φ) * A          hipR = -sin(φ) * A      (anti-phase)
    //   kneeL = -max(0, -sin(φ + 0.7)) * A * 1.15 - A * 0.15
    //   kneeR = same with φ + PI
    // The knee term is clamped to ≤ 0, so the shin only ever folds BACKWARD
    // (no hyperextension). The +0.7 rad phase lead makes the knee flex during
    // the swing phase (foot lifting past the planted leg) and straighten just
    // before heel-strike — the signature of a natural human stride.
    const horizSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    const isAirborne = Math.abs(state.velocity.y) > 0.35;
    const targetAmp =
      horizSpeed >= 0.25 && !isAirborne ? Math.min(1, horizSpeed / MAX_WALK_SPEED_MPS) * MAX_STRIDE_AMP_RAD : 0;
    strideAmpSmoothed += (targetAmp - strideAmpSmoothed) * (1 - Math.exp(-12 * stepDt));
    airBlend += ((isAirborne ? 1 : 0) - airBlend) * (1 - Math.exp(-10 * stepDt));
    const strideAmp = strideAmpSmoothed;
    const motion = strideAmp / MAX_STRIDE_AMP_RAD; // 0 idle .. 1 full sprint

    if (targetAmp > 0) {
      // Play the cycle backwards when back-pedalling so feet don't moonwalk.
      const fwdX = -Math.sin(state.yaw);
      const fwdZ = -Math.cos(state.yaw);
      const along = (state.velocity.x * fwdX + state.velocity.z * fwdZ) / horizSpeed;
      const dir = along < -0.3 ? -1 : 1;
      gaitPhase += stepDt * (4.2 + horizSpeed * 1.15) * dir;
    }

    const idle = 1 - motion;
    const hipL = Math.sin(gaitPhase) * strideAmp;
    const hipR = -Math.sin(gaitPhase) * strideAmp;
    const kneeL = -Math.max(0, -Math.sin(gaitPhase + 0.7)) * strideAmp * 1.15 - strideAmp * 0.15;
    const kneeR = -Math.max(0, -Math.sin(gaitPhase + Math.PI + 0.7)) * strideAmp * 1.15 - strideAmp * 0.15;

    // Idle: soft athletic knee bend. Airborne: tuck (hips forward, knees back).
    const gaitHipL = hipL + idle * 0.04 + airBlend * 0.35;
    const gaitHipR = hipR + idle * 0.04 + airBlend * 0.15;
    const gaitKneeL = kneeL - idle * 0.08 - airBlend * 0.6;
    const gaitKneeR = kneeR - idle * 0.08 - airBlend * 0.3;

    // -----------------------------------------------------------------------
    // Power-Slide: blend the gait toward a low slide pose with the same
    // frame-rate independent exponential smoothing `b += (target - b)(1 - e^(-14 dt))`.
    // Lead (left) thigh swings forward with the shin folded under; the
    // trailing (right) leg extends back; the whole body drops 0.35 m and the
    // torso leans back. When the slide ends `slideBlend` decays to 0, which
    // smoothly lifts `bodyTiltGroup.position.y` back to the floor-standing 0.
    // -----------------------------------------------------------------------
    slideBlend += ((sliding ? 1 : 0) - slideBlend) * (1 - Math.exp(-14 * stepDt));
    if (slideBlend < 1e-4) slideBlend = 0;
    const sb = slideBlend;
    leftLeg.hip.rotation.x = gaitHipL + (SLIDE_LEAD_HIP_RAD - gaitHipL) * sb;
    rightLeg.hip.rotation.x = gaitHipR + (SLIDE_TRAIL_HIP_RAD - gaitHipR) * sb;
    leftLeg.knee.rotation.x = gaitKneeL + (SLIDE_LEAD_KNEE_RAD - gaitKneeL) * sb;
    rightLeg.knee.rotation.x = gaitKneeR + (SLIDE_TRAIL_KNEE_RAD - gaitKneeR) * sb;
    bodyTiltGroup.position.y = SLIDE_DROP_M * sb;

    // -----------------------------------------------------------------------
    // Upper body: bladed stance twist, stride counter-rotation, bob & breathing
    // -----------------------------------------------------------------------
    const hold = WEAPON_HOLD[activeWeapon];
    const breathe = Math.sin(time * 1.9) * 0.006 * (0.4 + idle * 0.6);
    const bob = -Math.abs(Math.sin(gaitPhase)) * 0.028 * motion;
    const twist = hold.twist + Math.sin(gaitPhase) * 0.05 * motion;
    upperBody.position.y = WAIST_Y + bob + breathe;
    const gaitLean = -0.07 * motion - airBlend * 0.05;
    upperBody.rotation.set(
      gaitLean + (SLIDE_TORSO_LEAN_RAD - gaitLean) * sb,
      twist,
      Math.sin(gaitPhase) * 0.025 * motion * (1 - sb)
    );

    // Head counter-yaws so the visor always faces the aim direction.
    const aimPitch = clamp(state.pitch, -1.1, 1.1);
    headGroup.rotation.set(aimPitch * 0.45, -twist, 0);

    // Aim pivot: place in a "world-forward" frame by undoing the torso twist,
    // then pitch with the aim + decaying recoil kick + idle sway.
    recoilKick *= Math.exp(-14 * stepDt);
    _aimBase.set(0.05, U(1.27), -0.02).applyAxisAngle(UP, -twist);
    aimPivot.position.copy(_aimBase);
    aimPivot.rotation.set(
      aimPitch + recoilKick * 0.9 + Math.sin(time * 1.3) * 0.012 * idle,
      -twist + Math.sin(time * 0.9) * 0.01 * idle,
      0
    );
    aimPivot.translateZ(recoilKick * 0.1); // kick straight back along the barrel
    weaponSocket.position.set(hold.socket[0], hold.socket[1], hold.socket[2]);

    // Hands onto the weapon via 2-bone IK.
    const prop = weaponProps[activeWeapon];
    pointInUpperBody(prop.group, _gripTarget);
    pointInUpperBody(prop.support, _supportTarget);
    solveArmIK(rightArm, _gripTarget, RIGHT_ELBOW_POLE);
    solveArmIK(leftArm, _supportTarget, LEFT_ELBOW_POLE);

    for (const animate of animators) {
      animate(time, stepDt, motion);
    }

    // Gentle neon breathing on trims.
    trimMat.emissiveIntensity = 1.15 + Math.sin(time * 3.1) * 0.2;

    // Hit flash (0.10 s white) -> cryo slow (frost) -> base self-illumination.
    if (hitFlashTimer > 0) {
      hitFlashTimer = Math.max(0, hitFlashTimer - stepDt);
      armorMat.emissive.setHex(0xffffff);
      helmetMat.emissive.setHex(0xffffff);
      suitMat.emissive.setHex(0xffffff);
      armorMat.emissiveIntensity = lastHitWasHeadshot ? 0.55 : 1.0;
      helmetMat.emissiveIntensity = lastHitWasHeadshot ? 1.8 : 0.9;
      suitMat.emissiveIntensity = lastHitWasHeadshot ? 0.35 : 0.6;
    } else if (state.slowTimer > 0) {
      armorMat.emissive.setHex(0xaef0ff);
      helmetMat.emissive.setHex(0xaef0ff);
      suitMat.emissive.setHex(0x7fdcff);
      armorMat.emissiveIntensity = 0.55;
      helmetMat.emissiveIntensity = 0.55;
      suitMat.emissiveIntensity = 0.45;
    } else if ((state.concussTimer ?? 0) > 0) {
      // Concussed: a fast, jittery electric gold-white shimmer over the
      // agent's own hue (two incommensurate sines read as crackle, not a pulse).
      const s = clamp(0.5 + 0.35 * Math.sin(time * 27) + 0.15 * Math.sin(time * 61), 0, 1);
      _shimmerColor.copy(_agentColor).lerp(_shimmerTarget, 0.35 + 0.5 * s);
      armorMat.emissive.copy(_shimmerColor);
      helmetMat.emissive.copy(_shimmerColor);
      suitMat.emissive.setHex(teamStyle.suitEmissive);
      armorMat.emissiveIntensity = finish.emissiveIntensity + 0.3 * s;
      helmetMat.emissiveIntensity = finish.emissiveIntensity + 0.38 * s;
      suitMat.emissiveIntensity = teamStyle.suitEmissiveIntensity;
    } else {
      armorMat.emissive.setHex(agent.primary);
      helmetMat.emissive.setHex(agent.primary);
      suitMat.emissive.setHex(teamStyle.suitEmissive);
      armorMat.emissiveIntensity = finish.emissiveIntensity;
      helmetMat.emissiveIntensity = finish.emissiveIntensity;
      suitMat.emissiveIntensity = teamStyle.suitEmissiveIntensity;
    }

    // Overhead health bar & blind halo (hidden when occluded by smoke).
    const showOverhead = !state.occludedBySmoke;
    healthBarGroup.visible = showOverhead;

    if (showOverhead) {
      const hpRatio = clamp(state.maxHealth > 0 ? state.health / state.maxHealth : 0, 0, 1);
      healthFill.scale.x = Math.max(0.0001, hpRatio);
      // Damage "ghost" trails behind the real fill so chip damage is readable.
      ghostRatio = hpRatio >= ghostRatio ? hpRatio : Math.max(hpRatio, ghostRatio - stepDt * 0.55);
      ghostFill.scale.x = Math.max(0.0001, ghostRatio);

      root.updateMatrixWorld();
      healthBarGroup.lookAt(cameraPos.x, cameraPos.y, cameraPos.z);

      if (state.blindTimer > 0) {
        blindHalo.visible = true;
        blindHalo.rotation.z += stepDt * 6.0;
        blindHalo.rotation.y += stepDt * 3.5;
      } else {
        blindHalo.visible = false;
      }
    } else {
      blindHalo.visible = false;
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
