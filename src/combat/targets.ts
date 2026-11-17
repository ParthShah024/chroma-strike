import * as THREE from 'three';
import {
  AABB,
  AGENT_PALETTES,
  AgentColorId,
  SmokeSphere,
  TargetDummy,
  Vec3,
} from '../core/types';
import { raycastSphere } from '../physics/movement';

/**
 * Public interface for managing arena target dummies, their hitboxes,
 * strafe movement, health/respawn lifecycle, status effects, and visual hit feedback.
 */
export interface TargetsManager {
  targets: TargetDummy[];
  update(dt: number, cameraPos: Vec3, activeSmokes?: SmokeSphere[]): void;
  getHitboxes(target: TargetDummy): { head: AABB; body: AABB };
  applyDamage(targetId: string, amount: number, isHeadshot: boolean): boolean;
  applyStatus(targetId: string, kind: 'slow' | 'blind', durationSec: number): void;
}

/** Hitbox dimensions around each target's ground-level `position` (y = 0 at feet). */
const BODY_HALF_WIDTH = 0.38; // Total width/depth = 0.76m
const BODY_HEIGHT = 1.38;     // y: [0, 1.38]
const HEAD_HALF_WIDTH = 0.22; // Total width/depth = 0.44m
const HEAD_HEIGHT = 0.44;     // y: [1.38, 1.82]

const HEALTH_BAR_Y = 2.05;
const BLIND_HALO_Y = 2.22;
const TARGET_CHEST_HEIGHT = 1.1;
const HEALTH_BAR_WIDTH = 0.86;
const HEALTH_BAR_HEIGHT = 0.07;

const RESPAWN_DELAY_SEC = 2.0;
const HIT_FLASH_DURATION_SEC = 0.11;
const SLOW_STRAFE_MULTIPLIER = 0.30;

interface TargetVisual {
  root: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
  headMat: THREE.MeshStandardMaterial;
  blindHaloMesh: THREE.Mesh;
  healthBarGroup: THREE.Group;
  healthFillMesh: THREE.Mesh;
  healthFillMat: THREE.MeshBasicMaterial;
  baseColor: number;
  flashTimer: number;
}

interface TargetSpawnSpec {
  id: string;
  position: Vec3;
  colorId: AgentColorId;
  strafeSpeed: number;
  strafeRange: number;
  initialPhase: number;
}

/**
 * Six collision-free target spawns matching the arena layout:
 * - Static targets test raw crosshair placement & head-glitch peeks (behind 1.32m cover).
 * - Strafing targets test tracking, counter-strafing, and flick timing.
 */
const TARGET_SPAWNS: TargetSpawnSpec[] = [
  { id: 'target-1', position: { x: 0, y: 0, z: -8 }, colorId: 'red', strafeSpeed: 3.2, strafeRange: 4.5, initialPhase: 0.0 },
  { id: 'target-2', position: { x: -17, y: 0, z: -10 }, colorId: 'blue', strafeSpeed: 0, strafeRange: 0, initialPhase: 0.0 },
  { id: 'target-3', position: { x: 17, y: 0, z: -11 }, colorId: 'green', strafeSpeed: 2.8, strafeRange: 3.0, initialPhase: 1.2 },
  { id: 'target-4', position: { x: -8, y: 0, z: -16.2 }, colorId: 'red', strafeSpeed: 0, strafeRange: 0, initialPhase: 0.0 },
  { id: 'target-5', position: { x: 0, y: 0, z: -20 }, colorId: 'blue', strafeSpeed: 3.8, strafeRange: 5.0, initialPhase: 2.4 },
  { id: 'target-6', position: { x: 6.5, y: 0, z: -3 }, colorId: 'green', strafeSpeed: 2.4, strafeRange: 2.0, initialPhase: 0.7 },
];

/**
 * Creates and registers all arena target dummies in the Three.js scene.
 *
 * Each target splits its silhouette into two distinct AABB hitboxes:
 * - **Body hitbox** (`y: 0..1.38`, `0.76m` wide): forgiving target area (40 dmg).
 * - **Head hitbox** (`y: 1.38..1.82`, `0.44m` wide): high-skill reward (160 dmg, 1-tap),
 *   intentionally rising above the arena's `1.32m` head-glitch cover box.
 */
export function createTargetsManager(scene: THREE.Scene): TargetsManager {
  const targets: TargetDummy[] = [];
  const visuals = new Map<string, TargetVisual>();
  const targetById = new Map<string, TargetDummy>();

  // Shared geometries across all 6 targets to keep GPU memory minimal.
  const bodyGeo = new THREE.BoxGeometry(BODY_HALF_WIDTH * 2, BODY_HEIGHT, BODY_HALF_WIDTH * 2);
  const bodyEdgesGeo = new THREE.EdgesGeometry(bodyGeo);
  const headGeo = new THREE.SphereGeometry(HEAD_HALF_WIDTH, 20, 16);
  const blindHaloGeo = new THREE.TorusGeometry(0.28, 0.026, 6, 8);
  const barBgGeo = new THREE.PlaneGeometry(HEALTH_BAR_WIDTH + 0.06, HEALTH_BAR_HEIGHT + 0.04);

  // Shift the fill plane's origin to its left edge so scaling X drains cleanly left-to-right.
  const barFillGeo = new THREE.PlaneGeometry(HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT);
  barFillGeo.translate(HEALTH_BAR_WIDTH * 0.5, 0, 0);

  const edgeLineMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.25,
  });
  const blindHaloMat = new THREE.MeshBasicMaterial({
    color: 0xc8ffe0,
    side: THREE.DoubleSide,
  });
  const barBgMat = new THREE.MeshBasicMaterial({
    color: 0x0b0e14,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
  });

  for (const spec of TARGET_SPAWNS) {
    const palette = AGENT_PALETTES[spec.colorId];

    const target: TargetDummy = {
      id: spec.id,
      basePosition: { ...spec.position },
      position: { ...spec.position },
      colorId: spec.colorId,
      health: 100,
      maxHealth: 100,
      alive: true,
      respawnTimer: 0,
      strafeSpeed: spec.strafeSpeed,
      strafeRange: spec.strafeRange,
      strafePhase: spec.initialPhase,
      slowTimer: 0,
      blindTimer: 0,
    };

    const root = new THREE.Group();
    root.position.set(target.position.x, target.position.y, target.position.z);

    // Body mesh spanning y = [0, 1.38] (center at y = 0.69)
    const bodyMat = new THREE.MeshStandardMaterial({
      color: palette.hex,
      emissive: palette.hex,
      emissiveIntensity: 0.16,
      roughness: 0.45,
      metalness: 0.25,
    });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.position.y = BODY_HEIGHT * 0.5;
    bodyMesh.add(new THREE.LineSegments(bodyEdgesGeo, edgeLineMat));
    root.add(bodyMesh);

    // Distinct glowing head sphere spanning y = [1.38, 1.82] (center at y = 1.60)
    const headMat = new THREE.MeshStandardMaterial({
      color: palette.hex,
      emissive: palette.hex,
      emissiveIntensity: 0.5,
      roughness: 0.25,
      metalness: 0.15,
    });
    const headMesh = new THREE.Mesh(headGeo, headMat);
    headMesh.position.y = BODY_HEIGHT + HEAD_HALF_WIDTH;
    root.add(headMesh);

    // Emerald-white blind halo ring floating above the head (hidden unless blinded)
    const blindHaloMesh = new THREE.Mesh(blindHaloGeo, blindHaloMat);
    blindHaloMesh.position.y = BLIND_HALO_Y;
    blindHaloMesh.rotation.x = Math.PI * 0.42;
    blindHaloMesh.visible = false;
    root.add(blindHaloMesh);

    // Floating 3D health bar above the head that billboards toward the player's camera
    const healthBarGroup = new THREE.Group();
    healthBarGroup.position.y = HEALTH_BAR_Y;

    const barBgMesh = new THREE.Mesh(barBgGeo, barBgMat);
    healthBarGroup.add(barBgMesh);

    const healthFillMat = new THREE.MeshBasicMaterial({
      color: palette.hex,
      side: THREE.DoubleSide,
    });
    const healthFillMesh = new THREE.Mesh(barFillGeo, healthFillMat);
    healthFillMesh.position.set(-HEALTH_BAR_WIDTH * 0.5, 0, 0.005);
    healthBarGroup.add(healthFillMesh);

    root.add(healthBarGroup);
    scene.add(root);

    targets.push(target);
    targetById.set(target.id, target);
    visuals.set(target.id, {
      root,
      bodyMat,
      headMat,
      blindHaloMesh,
      healthBarGroup,
      healthFillMesh,
      healthFillMat,
      baseColor: palette.hex,
      flashTimer: 0,
    });
  }

  /**
   * Computes exact world-space AABB hitboxes for a target's current position.
   * Keeping hitbox math decoupled from Three.js mesh bounds guarantees deterministic
   * hit detection suitable for server-authoritative multiplayer validation.
   */
  function getHitboxes(target: TargetDummy): { head: AABB; body: AABB } {
    const { x, y, z } = target.position;
    return {
      body: {
        min: { x: x - BODY_HALF_WIDTH, y, z: z - BODY_HALF_WIDTH },
        max: { x: x + BODY_HALF_WIDTH, y: y + BODY_HEIGHT, z: z + BODY_HALF_WIDTH },
      },
      head: {
        min: { x: x - HEAD_HALF_WIDTH, y: y + BODY_HEIGHT, z: z - HEAD_HALF_WIDTH },
        max: { x: x + HEAD_HALF_WIDTH, y: y + BODY_HEIGHT + HEAD_HEIGHT, z: z + HEAD_HALF_WIDTH },
      },
    };
  }

  /**
   * Applies damage to a target dummy, triggers a brief white emissive hit flash,
   * updates its floating health bar, and starts the 2.0s respawn timer on death.
   * Returns `true` if this hit killed the target.
   */
  function applyDamage(targetId: string, amount: number, isHeadshot: boolean): boolean {
    const target = targetById.get(targetId);
    const visual = visuals.get(targetId);
    if (!target || !visual || !target.alive) {
      return false;
    }

    target.health = Math.max(0, target.health - amount);

    // Trigger bright white emissive flash on hit (stronger for headshots)
    visual.flashTimer = HIT_FLASH_DURATION_SEC;
    visual.bodyMat.emissive.setHex(0xffffff);
    visual.headMat.emissive.setHex(0xffffff);
    visual.bodyMat.emissiveIntensity = isHeadshot ? 0.65 : 0.95;
    visual.headMat.emissiveIntensity = isHeadshot ? 1.4 : 0.8;

    const healthRatio = Math.max(0, target.health / target.maxHealth);
    visual.healthFillMesh.scale.x = healthRatio;

    if (target.health <= 0) {
      target.alive = false;
      target.respawnTimer = RESPAWN_DELAY_SEC;
      visual.root.visible = false;
      return true;
    }

    return false;
  }

  /**
   * Applies or refreshes a crowd-control status timer on an alive target dummy.
   *
   * Status Timer Refresh Rule (`timer = max(timer, durationSec)`):
   * Rather than stacking durations additively (which would let rapid ticks from
   * a Cryo Field push slow duration arbitrarily high), taking `Math.max` guarantees
   * a bounded remaining duration equal to at least `durationSec` while preserving
   * any longer active debuff already on the target.
   */
  function applyStatus(targetId: string, kind: 'slow' | 'blind', durationSec: number): void {
    const target = targetById.get(targetId);
    if (!target || !target.alive || durationSec <= 0) {
      return;
    }
    if (kind === 'slow') {
      target.slowTimer = Math.max(target.slowTimer, durationSec);
    } else {
      target.blindTimer = Math.max(target.blindTimer, durationSec);
    }
  }

  /**
   * Advances status timers, strafe oscillation, respawn countdowns, hit-flash decay,
   * smoke line-of-sight occlusion, and health-bar billboarding toward the active camera.
   *
   * Status Priority & Decay Equations:
   * - Each frame, active status timers decay linearly (`t = max(0, t - dt)`).
   * - **Blind** (`blindTimer > 0`) overrides **Slow** (`slowTimer > 0`) for strafing:
   *   `strafeScale = blindTimer > 0 ? 0 : (slowTimer > 0 ? 0.30 : 1.0)`.
   *   Blinded targets halt in place with a spinning emerald-white halo above their head
   *   (`y = 2.22`); slowed targets strafe at `0.30x` angular speed with an icy cyan body glow.
   * - **Smoke Vision Occlusion**: Casts a ray from `cameraPos` to each target's chest
   *   (`y + 1.1`) against every active `SmokeSphere` via `raycastSphere(..., distToTarget)`.
   *   Any intersection hides `healthBarGroup` so smokes deny enemy info cleanly.
   */
  function update(dt: number, cameraPos: Vec3, activeSmokes: SmokeSphere[] = []): void {
    for (const target of targets) {
      const visual = visuals.get(target.id);
      if (!visual) continue;

      if (!target.alive) {
        target.respawnTimer -= dt;
        if (target.respawnTimer <= 0) {
          target.alive = true;
          target.health = target.maxHealth;
          target.respawnTimer = 0;
          target.slowTimer = 0;
          target.blindTimer = 0;
          visual.flashTimer = 0;
          visual.blindHaloMesh.visible = false;
          visual.bodyMat.emissive.setHex(visual.baseColor);
          visual.bodyMat.emissiveIntensity = 0.16;
          visual.headMat.emissive.setHex(visual.baseColor);
          visual.headMat.emissiveIntensity = 0.5;
          visual.healthFillMesh.scale.x = 1;
          visual.root.visible = true;
        }
        continue;
      }

      // Linearly decay active status timers toward zero each frame.
      target.slowTimer = Math.max(0, target.slowTimer - dt);
      target.blindTimer = Math.max(0, target.blindTimer - dt);

      const isBlinded = target.blindTimer > 0;
      const isSlowed = target.slowTimer > 0;

      // Determine strafe speed scale: blind freezes movement completely; slow cuts speed by 70%.
      let strafeMultiplier = 1.0;
      if (isBlinded) {
        strafeMultiplier = 0;
        visual.blindHaloMesh.visible = true;
        visual.blindHaloMesh.rotation.z += dt * 6.0;
        visual.blindHaloMesh.rotation.y += dt * 3.5;
      } else {
        visual.blindHaloMesh.visible = false;
        if (isSlowed) {
          strafeMultiplier = SLOW_STRAFE_MULTIPLIER;
        }
      }

      // Sinusoidal horizontal strafing along world X.
      // Angular speed omega = (strafeSpeed / strafeRange) * strafeMultiplier ensures
      // peak linear velocity scales proportionally under slow or freezes to 0 when blinded.
      if (target.strafeSpeed > 0 && target.strafeRange > 0 && strafeMultiplier > 0) {
        const omega = (target.strafeSpeed / target.strafeRange) * strafeMultiplier;
        target.strafePhase += omega * dt;
        target.position.x = target.basePosition.x + Math.sin(target.strafePhase) * target.strafeRange;
      }

      visual.root.position.set(target.position.x, target.position.y, target.position.z);

      // Decay brief white hit-flash; once expired, render active status tint or palette base glow.
      if (visual.flashTimer > 0) {
        visual.flashTimer = Math.max(0, visual.flashTimer - dt);
      }

      if (visual.flashTimer === 0) {
        if (isBlinded) {
          visual.headMat.emissive.setHex(0xc8ffe0);
          visual.headMat.emissiveIntensity = 1.4;
          if (isSlowed) {
            visual.bodyMat.emissive.setHex(0x00d2ff);
            visual.bodyMat.emissiveIntensity = 0.65;
          } else {
            visual.bodyMat.emissive.setHex(visual.baseColor);
            visual.bodyMat.emissiveIntensity = 0.16;
          }
        } else if (isSlowed) {
          visual.bodyMat.emissive.setHex(0x00d2ff);
          visual.bodyMat.emissiveIntensity = 0.65;
          visual.headMat.emissive.setHex(visual.baseColor);
          visual.headMat.emissiveIntensity = 0.5;
        } else {
          visual.bodyMat.emissive.setHex(visual.baseColor);
          visual.bodyMat.emissiveIntensity = 0.16;
          visual.headMat.emissive.setHex(visual.baseColor);
          visual.headMat.emissiveIntensity = 0.5;
        }
      }

      // Smoke vision occlusion: raycast from camera eye to target chest against all active smokes.
      let occluded = false;
      if (activeSmokes.length > 0) {
        const dx = target.position.x - cameraPos.x;
        const dy = target.position.y + TARGET_CHEST_HEIGHT - cameraPos.y;
        const dz = target.position.z - cameraPos.z;
        const distToTarget = Math.hypot(dx, dy, dz);

        if (distToTarget > 1e-6) {
          const invDist = 1 / distToTarget;
          const dir: Vec3 = { x: dx * invDist, y: dy * invDist, z: dz * invDist };
          for (const smoke of activeSmokes) {
            if (raycastSphere(cameraPos, dir, smoke.center, smoke.radius, distToTarget) !== null) {
              occluded = true;
              break;
            }
          }
        }
      }

      visual.healthBarGroup.visible = !occluded;

      // Billboard the floating health bar so it always faces the player's camera
      if (!occluded) {
        visual.healthBarGroup.lookAt(cameraPos.x, cameraPos.y, cameraPos.z);
      }
    }
  }

  return {
    targets,
    update,
    getHitboxes,
    applyDamage,
    applyStatus,
  };
}
