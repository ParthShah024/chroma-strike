import * as THREE from 'three';
import type { SpikeHudState, SpikeStatus } from '../core/types';

/**
 * ============================================================================
 * Procedural 3D Radianite Spike Visual Controller
 * ============================================================================
 *
 * Renders the Search & Destroy objective across every lifecycle phase:
 *  - `'carried'`   : Hidden (held in carrier's pack).
 *  - `'dropped'`   : Hexagonal titanium canister resting on floor with a tall
 *                    translucent amber-gold holographic locator beam.
 *  - `'planted'`   : Upright activated Spike with glowing Radianite core, two
 *                    accelerating counter-rotating containment rings, expanding
 *                    pulsing ground ring, and smooth cyan-amber -> urgent crimson
 *                    color shift as `timerSec -> 0`.
 *  - `'defused'`   : Stabilized emerald-cyan core with halted rings.
 *  - `'detonated'` : Dramatic expanding flash sphere and shockwave ring.
 *
 * All GPU geometries and materials are cleanly disposed on `dispose(scene)`.
 */

export interface SpikeModelController {
  update(dt: number, spike: SpikeHudState): void;
  dispose(scene: THREE.Scene): void;
}

const POST_PLANT_REF_SEC = 45.0;
const DETONATION_ANIM_SEC = 1.8;

const COLOR_CYAN = new THREE.Color(0x00e5ff);
const COLOR_AMBER = new THREE.Color(0xffb020);
const COLOR_RED = new THREE.Color(0xff1e38);
const COLOR_DEFUSED = new THREE.Color(0x2ecc71);
const COLOR_DROPPED = new THREE.Color(0xfacc15);
const COLOR_FLASH_CORE = new THREE.Color(0xfff5d6);

export function createSpikeModel(scene: THREE.Scene): SpikeModelController {
  const root = new THREE.Group();
  root.visible = false;
  scene.add(root);

  // Track geometries and materials explicitly for leak-free disposal.
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };

  // --- Canister Assembly (~0.52m tall dark titanium hex body) ---
  const canisterGroup = new THREE.Group();
  root.add(canisterGroup);

  const titaniumMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1e2530,
      metalness: 0.78,
      roughness: 0.28,
    })
  );
  const darkTrimMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x10151d,
      metalness: 0.85,
      roughness: 0.24,
    })
  );
  const coreMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x00e5ff,
      emissive: 0x00e5ff,
      emissiveIntensity: 2.2,
      roughness: 0.15,
      metalness: 0.1,
    })
  );
  const ringMatA = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x00e5ff,
      emissiveIntensity: 1.5,
      metalness: 0.65,
      roughness: 0.22,
    })
  );
  const ringMatB = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.9,
      metalness: 0.8,
      roughness: 0.2,
    })
  );

  // Base flange (y: 0..0.06m)
  const baseFlange = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.16, 0.19, 0.06, 6)),
    darkTrimMat
  );
  baseFlange.position.y = 0.03;
  canisterGroup.add(baseFlange);

  // Lower hex casing (y: 0.06..0.24m)
  const lowerBody = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.115, 0.14, 0.18, 6)),
    titaniumMat
  );
  lowerBody.position.y = 0.15;
  canisterGroup.add(lowerBody);

  // Glowing Radianite core window (y: 0.24..0.38m)
  const coreBand = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.095, 0.095, 0.15, 6)),
    coreMat
  );
  coreBand.position.y = 0.315;
  canisterGroup.add(coreBand);

  // Inner crystalline Radianite crystal suspended inside core
  const coreCrystal = new THREE.Mesh(
    trackGeo(new THREE.OctahedronGeometry(0.075, 0)),
    coreMat
  );
  coreCrystal.position.y = 0.32;
  canisterGroup.add(coreCrystal);

  // Upper hex cap (y: 0.39..0.52m)
  const upperCap = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.085, 0.115, 0.13, 6)),
    titaniumMat
  );
  upperCap.position.y = 0.455;
  canisterGroup.add(upperCap);

  // Top beacon tip (y: 0.52..0.56m)
  const topTip = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.035, 0.06, 0.045, 6)),
    coreMat
  );
  topTip.position.y = 0.54;
  canisterGroup.add(topTip);

  // 3 vertical armor struts framing the Radianite core
  const strutGeo = trackGeo(new THREE.BoxGeometry(0.026, 0.38, 0.032));
  for (let i = 0; i < 3; i++) {
    const angle = (i * Math.PI * 2) / 3;
    const strut = new THREE.Mesh(strutGeo, darkTrimMat);
    strut.position.set(Math.cos(angle) * 0.122, 0.28, Math.sin(angle) * 0.122);
    strut.rotation.y = -angle;
    canisterGroup.add(strut);
  }

  // Two counter-rotating containment rings orbiting the core
  const ringA = new THREE.Mesh(
    trackGeo(new THREE.TorusGeometry(0.21, 0.013, 8, 28)),
    ringMatA
  );
  ringA.position.y = 0.32;
  ringA.rotation.x = Math.PI * 0.36;
  canisterGroup.add(ringA);

  const ringB = new THREE.Mesh(
    trackGeo(new THREE.TorusGeometry(0.265, 0.01, 8, 28)),
    ringMatB
  );
  ringB.position.y = 0.32;
  ringB.rotation.x = -Math.PI * 0.32;
  ringB.rotation.z = Math.PI * 0.22;
  canisterGroup.add(ringB);

  // Local point light for subtle Radianite floor illumination
  const coreLight = new THREE.PointLight(0x00e5ff, 1.4, 7.0, 2);
  coreLight.position.y = 0.42;
  root.add(coreLight);

  // --- Dropped Locator Beam (tall translucent hologram) ---
  const beamMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.26,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  const locatorBeam = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.08, 0.24, 6.2, 12, 1, true)),
    beamMat
  );
  locatorBeam.position.y = 3.12;
  locatorBeam.visible = false;
  root.add(locatorBeam);

  // --- Planted Ground Rings (steady base ring + expanding pulse ring) ---
  const baseGroundRingMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  const baseGroundRing = new THREE.Mesh(
    trackGeo(new THREE.RingGeometry(0.32, 0.42, 32)),
    baseGroundRingMat
  );
  baseGroundRing.rotation.x = -Math.PI * 0.5;
  baseGroundRing.position.y = 0.032;
  baseGroundRing.visible = false;
  root.add(baseGroundRing);

  const pulseRingMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  const pulseGroundRing = new THREE.Mesh(
    trackGeo(new THREE.RingGeometry(0.34, 0.45, 32)),
    pulseRingMat
  );
  pulseGroundRing.rotation.x = -Math.PI * 0.5;
  pulseGroundRing.position.y = 0.036;
  pulseGroundRing.visible = false;
  root.add(pulseGroundRing);

  // --- Detonation Flash Sphere & Shockwave Torus ---
  const flashMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xfff5d6,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  const flashSphere = new THREE.Mesh(
    trackGeo(new THREE.SphereGeometry(1.0, 24, 18)),
    flashMat
  );
  flashSphere.position.y = 0.5;
  flashSphere.visible = false;
  root.add(flashSphere);

  const blastWaveMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xff3b5c,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  const blastWaveRing = new THREE.Mesh(
    trackGeo(new THREE.RingGeometry(0.75, 1.0, 40)),
    blastWaveMat
  );
  blastWaveRing.rotation.x = -Math.PI * 0.5;
  blastWaveRing.position.y = 0.14;
  blastWaveRing.visible = false;
  root.add(blastWaveRing);

  // Animation state
  let elapsed = 0;
  let pulsePhase = 0;
  let lastStatus: SpikeStatus = 'carried';
  let detonationAge = 0;
  const workingColor = new THREE.Color();

  function update(dt: number, spike: SpikeHudState): void {
    elapsed += dt;

    if (spike.status !== lastStatus) {
      if (spike.status === 'detonated') {
        detonationAge = 0;
      }
      if (spike.status === 'planted') {
        pulsePhase = 0;
      }
      lastStatus = spike.status;
    }

    if (spike.status === 'carried') {
      root.visible = false;
      return;
    }

    root.visible = true;
    root.position.set(spike.position.x, Math.max(0, spike.position.y), spike.position.z);

    if (spike.status === 'dropped') {
      canisterGroup.visible = true;
      canisterGroup.rotation.set(0.24, elapsed * 0.9, 0.12);
      canisterGroup.position.y = 0.06 + Math.sin(elapsed * 3.0) * 0.025;

      ringA.rotation.y += dt * 1.4;
      ringB.rotation.y -= dt * 1.1;

      coreMat.color.copy(COLOR_DROPPED);
      coreMat.emissive.copy(COLOR_DROPPED);
      coreMat.emissiveIntensity = 1.6 + Math.sin(elapsed * 5.0) * 0.4;
      ringMatA.emissive.copy(COLOR_DROPPED);
      ringMatB.emissive.copy(COLOR_DROPPED);
      coreLight.color.copy(COLOR_DROPPED);
      coreLight.intensity = 1.5;

      locatorBeam.visible = true;
      beamMat.opacity = 0.22 + Math.sin(elapsed * 4.5) * 0.08;
      const beamScaleXZ = 1.0 + Math.sin(elapsed * 3.2) * 0.12;
      locatorBeam.scale.set(beamScaleXZ, 1.0, beamScaleXZ);

      baseGroundRing.visible = true;
      baseGroundRingMat.color.copy(COLOR_DROPPED);
      baseGroundRingMat.opacity = 0.45;
      baseGroundRing.scale.setScalar(1.0);

      pulseGroundRing.visible = false;
      flashSphere.visible = false;
      blastWaveRing.visible = false;
      return;
    }

    if (spike.status === 'planted') {
      canisterGroup.visible = true;
      canisterGroup.rotation.set(0, 0, 0);
      canisterGroup.position.y = 0;

      const urgency = Math.max(0, Math.min(1, 1 - spike.timerSec / POST_PLANT_REF_SEC));

      // Smooth color transition: cyan (0.0) -> amber (0.55) -> urgent crimson red (1.0)
      if (urgency < 0.55) {
        workingColor.copy(COLOR_CYAN).lerp(COLOR_AMBER, urgency / 0.55);
      } else {
        workingColor.copy(COLOR_AMBER).lerp(COLOR_RED, (urgency - 0.55) / 0.45);
      }

      // Blend subtle emerald tint on rings when defuse is actively progressing
      if (spike.defuseProgress > 0.01) {
        ringMatA.emissive.copy(COLOR_DEFUSED);
        ringMatB.emissive.copy(COLOR_CYAN);
      } else {
        ringMatA.emissive.copy(workingColor);
        ringMatB.emissive.copy(workingColor);
      }

      const spinSpeed = 1.8 + urgency * 10.5;
      ringA.rotation.y += dt * spinSpeed;
      ringA.rotation.z += dt * spinSpeed * 0.35;
      ringB.rotation.y -= dt * spinSpeed * 1.25;
      ringB.rotation.x += dt * spinSpeed * 0.25;
      coreCrystal.rotation.y += dt * (2.2 + urgency * 6.0);

      // Pulse cadence matches accelerating timer beep interval
      const pulsePeriod = Math.max(0.14, Math.min(1.0, spike.timerSec / POST_PLANT_REF_SEC));
      pulsePhase = (pulsePhase + dt / pulsePeriod) % 1.0;

      const flashKick = Math.pow(1 - pulsePhase, 2.5);
      coreMat.color.copy(workingColor);
      coreMat.emissive.copy(workingColor);
      coreMat.emissiveIntensity = 1.6 + flashKick * (2.2 + urgency * 2.5);

      coreLight.color.copy(workingColor);
      coreLight.intensity = 1.5 + flashKick * (2.5 + urgency * 3.0);

      locatorBeam.visible = false;
      flashSphere.visible = false;
      blastWaveRing.visible = false;

      baseGroundRing.visible = true;
      baseGroundRingMat.color.copy(workingColor);
      baseGroundRingMat.opacity = 0.45 + flashKick * 0.35;
      baseGroundRing.scale.setScalar(1.0 + flashKick * 0.14);

      pulseGroundRing.visible = true;
      pulseRingMat.color.copy(workingColor);
      const expandScale = 1.0 + pulsePhase * (4.2 + urgency * 3.0);
      pulseGroundRing.scale.setScalar(expandScale);
      pulseRingMat.opacity = Math.max(0, (1 - pulsePhase) * (0.65 + urgency * 0.3));
      return;
    }

    if (spike.status === 'defused') {
      canisterGroup.visible = true;
      canisterGroup.rotation.set(0, 0, 0);
      canisterGroup.position.y = 0;

      coreMat.color.copy(COLOR_DEFUSED);
      coreMat.emissive.copy(COLOR_DEFUSED);
      coreMat.emissiveIntensity = 1.1;
      ringMatA.emissive.copy(COLOR_DEFUSED);
      ringMatB.emissive.copy(COLOR_DEFUSED);
      coreLight.color.copy(COLOR_DEFUSED);
      coreLight.intensity = 1.0;

      locatorBeam.visible = false;
      pulseGroundRing.visible = false;
      flashSphere.visible = false;
      blastWaveRing.visible = false;

      baseGroundRing.visible = true;
      baseGroundRingMat.color.copy(COLOR_DEFUSED);
      baseGroundRingMat.opacity = 0.4;
      baseGroundRing.scale.setScalar(1.1);
      return;
    }

    // status === 'detonated'
    detonationAge += dt;
    const t = Math.min(1, detonationAge / DETONATION_ANIM_SEC);

    canisterGroup.visible = t < 0.2;
    locatorBeam.visible = false;
    baseGroundRing.visible = false;
    pulseGroundRing.visible = false;

    flashSphere.visible = t < 1.0;
    const sphereRadius = 0.6 + Math.pow(t, 0.55) * 15.5;
    flashSphere.scale.setScalar(sphereRadius);
    workingColor.copy(COLOR_FLASH_CORE).lerp(COLOR_RED, Math.min(1, t * 1.4));
    flashMat.color.copy(workingColor);
    flashMat.opacity = Math.max(0, (1 - t) * (1 - t) * 0.92);

    blastWaveRing.visible = t < 1.0;
    blastWaveRing.scale.setScalar(0.8 + Math.pow(t, 0.65) * 18.0);
    blastWaveMat.opacity = Math.max(0, (1 - t) * 0.85);

    coreLight.color.copy(workingColor);
    coreLight.intensity = Math.max(0, (1 - t) * 18.0);
  }

  function dispose(targetScene: THREE.Scene): void {
    for (const geo of geometries) {
      geo.dispose();
    }
    for (const mat of materials) {
      mat.dispose();
    }
    geometries.length = 0;
    materials.length = 0;
    targetScene.remove(root);
  }

  return {
    update,
    dispose,
  };
}
