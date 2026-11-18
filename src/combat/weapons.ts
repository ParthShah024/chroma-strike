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
   * Switches the active agent color on both the weapon's glowing accent rail
   * and subsequent player bullet tracers.
   */
  function setAgentColor(colorId: AgentColorId): void {
    activeColorId = colorId;
    const hex = AGENT_PALETTES[colorId].hex;
    accentMat.color.setHex(hex);
    accentMat.emissive.setHex(hex);
    muzzleFlashMat.color.setHex(hex);
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
