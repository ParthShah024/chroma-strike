import type {
  AABB,
  AbilityProjectile,
  InputState,
  MovementModifiers,
  PlayerState,
  RaycastHit,
  Vec3,
} from '../core/types';

// ---------------------------------------------------------------------------
// Player Capsule / AABB & Tuning Constants (Tactical FPS Scale: 1 unit = 1m)
// ---------------------------------------------------------------------------

/** Half-width of the player's horizontal collision box (0.8m total width). */
export const PLAYER_RADIUS = 0.4;

/** Full standing height of the player's collision box in meters. */
export const PLAYER_HEIGHT = 1.8;

/** Eye / camera height above the player's feet (`position.y`) in meters. */
export const EYE_HEIGHT = 1.62;

/** Maximum ground running speed in meters per second. */
export const RUN_SPEED = 8.2;

/** Maximum Shift-walk speed in meters per second (silent, low-spread movement). */
export const WALK_SPEED = 4.3;

/**
 * Maximum vertical ledge/stair height in meters that a grounded player or bot
 * can automatically step up onto while moving horizontally (Quake/Valorant style).
 */
export const STEP_HEIGHT = 0.52;

// Valorant-inspired snappy movement constants:
// High ground acceleration + strong exponential friction allows stopping or
// counter-strafing (tapping the opposite movement key) to reach <0.45 m/s
// in under 80ms for crisp first-shot accuracy.
const ACCEL = 85;
const FRICTION = 12;
const AIR_ACCEL = 18;
const GRAVITY = 21;
const JUMP_SPEED = 7.4;

/**
 * Small geometric inset used on non-moving axes during AABB overlap checks.
 * Without this epsilon, standing flush on a floor (`pos.y === floor.max.y`)
 * or brushing a wall face could falsely trigger a collision on perpendicular axes.
 */
const COLLISION_EPSILON = 1e-5;

/** Maximum frame delta clamped to prevent tunneling if the browser tab pauses. */
const MAX_STEP_DT = 0.05;

/**
 * Creates the starting state for a player at the given spawn coordinate.
 *
 * Notice we clone `spawn` with `{ ...spawn }` rather than storing the reference
 * directly, ensuring mutating `player.position` never mutates `PLAYER_SPAWN`.
 */
export function createInitialPlayerState(
  spawn: Vec3 = { x: 0, y: 0.1, z: 18 }
): PlayerState {
  return {
    position: { ...spawn },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: false,
    health: 100,
    maxHealth: 100,
    colorId: 'red',
  };
}

/**
 * Computes horizontal movement speed on the XZ ground plane (`sqrt(vx^2 + vz^2)`).
 * Vertical velocity (`y`) is excluded because tactical weapon spread depends on
 * lateral ground speed and grounded state separately.
 */
export function getHorizontalSpeed(velocity: Vec3): number {
  return Math.hypot(velocity.x, velocity.z);
}

/**
 * Converts Euler look angles (`yaw`, `pitch`) into a unit 3D aim direction vector
 * matching Three.js's `'YXZ'` camera rotation convention.
 *
 * Math breakdown:
 * - At `yaw = 0, pitch = 0`, the camera looks straight down `-Z`: `(0, 0, -1)`.
 * - Rotating around `+Y` by `yaw` swings `-Z` toward `-X` (`-sin(yaw), 0, -cos(yaw)`).
 * - Rotating around local `+X` by `pitch` tilts the forward ray upward by `sin(pitch)`
 *   and scales the horizontal projection by `cos(pitch)`.
 */
export function getLookDirection(yaw: number, pitch: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  };
}

/**
 * Applies horizontal friction and Quake/Valorant-style directional acceleration.
 *
 * Why project `velocity` onto `wishDir` (`currentSpeed = dot(vel, wishDir)`)?
 * Comparing `wishSpeed - currentSpeed` gives two big benefits:
 * 1. It prevents diagonal or repeated inputs from exceeding `maxSpeed`.
 * 2. When counter-strafing (`A` -> `D`), `currentSpeed` is negative (moving
 *    opposite `wishDir`), so `addSpeed = maxSpeed - (-currentSpeed)` is huge —
 *    letting full `ACCEL` slam horizontal velocity through zero rapidly.
 */
function updateHorizontalVelocity(
  player: PlayerState,
  wishDirX: number,
  wishDirZ: number,
  hasWish: boolean,
  maxSpeed: number,
  dt: number
): void {
  if (player.grounded) {
    // Exponential damping (`e^(-FRICTION * dt)`) is frame-rate independent:
    // whether running at 60Hz or 240Hz, speed decays by the exact same ratio per second.
    const decay = Math.exp(-FRICTION * dt);
    player.velocity.x *= decay;
    player.velocity.z *= decay;

    // Snap tiny residual drift to exact 0 when no movement key is held.
    if (!hasWish && getHorizontalSpeed(player.velocity) < 0.05) {
      player.velocity.x = 0;
      player.velocity.z = 0;
    }
  }

  if (!hasWish) return;

  const accel = player.grounded ? ACCEL : AIR_ACCEL;
  const currentSpeed =
    player.velocity.x * wishDirX + player.velocity.z * wishDirZ;
  const addSpeed = maxSpeed - currentSpeed;

  if (addSpeed <= 0) return;

  const accelSpeed = Math.min(accel * dt, addSpeed);
  player.velocity.x += wishDirX * accelSpeed;
  player.velocity.z += wishDirZ * accelSpeed;
}

/**
 * Checks whether two 1D intervals `[aMin, aMax]` and `[bMin, bMax]` strictly overlap.
 */
function intervalsOverlap(
  aMin: number,
  aMax: number,
  bMin: number,
  bMax: number
): boolean {
  return aMax > bMin && aMin < bMax;
}

/**
 * Returns `true` when a combatant's vertical AABB `[y, y + height]`
 * at `(x, y, z)` is clear of all static colliders (used to verify ceiling/wall
 * clearance before performing a Quake/Valorant stair step-up).
 */
function canStepUpToY(
  x: number,
  newY: number,
  z: number,
  colliders: AABB[],
  height = PLAYER_HEIGHT
): boolean {
  const minX = x - PLAYER_RADIUS + COLLISION_EPSILON;
  const maxX = x + PLAYER_RADIUS - COLLISION_EPSILON;
  const minY = newY + COLLISION_EPSILON;
  const maxY = newY + height - COLLISION_EPSILON;
  const minZ = z - PLAYER_RADIUS + COLLISION_EPSILON;
  const maxZ = z + PLAYER_RADIUS - COLLISION_EPSILON;

  for (const other of colliders) {
    if (
      intervalsOverlap(minX, maxX, other.min.x, other.max.x) &&
      intervalsOverlap(minY, maxY, other.min.y, other.max.y) &&
      intervalsOverlap(minZ, maxZ, other.min.z, other.max.z)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Advances player physics by `dt` seconds and resolves collisions against static AABBs.
 *
 * Resolution order (`X` -> `Z` -> `Y`):
 * Separating position integration and collision resolution one axis at a time
 * lets the player slide cleanly along walls instead of getting stuck on corners,
 * and ensures landing on floors or cover boxes sets `player.grounded = true`.
 *
 * Ability **Impulse Override** (`modifiers?.dashActive`):
 * During an active dash (`0.18s`), normal ground friction, directional acceleration,
 * jump input, and gravity are bypassed and replaced by the constant dash velocity
 * vector (`v = dashVelocity`). Crucially, the full `X -> Z -> Y` AABB collision
 * sweep still executes so high-speed dashes slide along walls and never tunnel
 * through solid arena geometry.
 */
export function updatePlayerMovement(
  player: PlayerState,
  input: InputState,
  colliders: AABB[],
  dt: number,
  modifiers?: MovementModifiers
): void {
  const stepDt = Math.min(Math.max(dt, 0), MAX_STEP_DT);
  if (stepDt === 0) return;

  if (modifiers?.dashActive) {
    // Impulse override: lock velocity to the dash impulse vector and skip
    // ground friction, acceleration, and gravity for the duration of the dash.
    player.velocity.x = modifiers.dashVelocity.x;
    player.velocity.y = modifiers.dashVelocity.y;
    player.velocity.z = modifiers.dashVelocity.z;
  } else {
    // 1. Derive horizontal basis vectors on the XZ plane from camera yaw.
    //    Forward is `-Z` at yaw=0; Right is `+X` at yaw=0 (90° clockwise from Forward).
    const fx = -Math.sin(input.yaw);
    const fz = -Math.cos(input.yaw);
    const rx = Math.cos(input.yaw);
    const rz = -Math.sin(input.yaw);

    // 2. Combine WASD inputs into a normalized horizontal wish direction so
    //    diagonal movement (`W+D`) has the same top speed as straight (`W`).
    const forwardInput = (input.forward ? 1 : 0) - (input.backward ? 1 : 0);
    const strafeInput = (input.right ? 1 : 0) - (input.left ? 1 : 0);

    let wishX = fx * forwardInput + rx * strafeInput;
    let wishZ = fz * forwardInput + rz * strafeInput;
    const wishLen = Math.hypot(wishX, wishZ);
    const hasWish = wishLen > 1e-6;

    if (hasWish) {
      wishX /= wishLen;
      wishZ /= wishLen;
    }

    // Scale movement speed cap by active ability modifiers (e.g., 0.55x Cryo slow, 1.22x Bio-Stim).
    const maxSpeed =
      (input.walk ? WALK_SPEED : RUN_SPEED) * (modifiers?.speedMultiplier ?? 1.0);
    updateHorizontalVelocity(player, wishX, wishZ, hasWish, maxSpeed, stepDt);

    // 3. Jump impulse and downward gravity acceleration.
    //    Cryo Slow Field sets `modifiers.suppressJump = true` to ground targets/players.
    if (player.grounded && input.jump && !modifiers?.suppressJump) {
      player.velocity.y = JUMP_SPEED;
      player.grounded = false;
    }
    player.velocity.y -= GRAVITY * stepDt;
  }

  const activeHeight = modifiers?.slideActive ? 1.22 : PLAYER_HEIGHT;
  const extVx = modifiers?.externalVelocity?.x ?? 0;
  const extVz = modifiers?.externalVelocity?.z ?? 0;

  // 4. Axis-by-axis AABB sweep & resolution: X, then Z, then Y.
  // --- X Axis ---
  const stepVx = player.velocity.x + extVx;
  player.position.x += stepVx * stepDt;
  for (const box of colliders) {
    const overlapY = intervalsOverlap(
      player.position.y + COLLISION_EPSILON,
      player.position.y + activeHeight - COLLISION_EPSILON,
      box.min.y,
      box.max.y
    );
    const overlapZ = intervalsOverlap(
      player.position.z - PLAYER_RADIUS + COLLISION_EPSILON,
      player.position.z + PLAYER_RADIUS - COLLISION_EPSILON,
      box.min.z,
      box.max.z
    );
    if (!overlapY || !overlapZ) continue;

    if (
      intervalsOverlap(
        player.position.x - PLAYER_RADIUS,
        player.position.x + PLAYER_RADIUS,
        box.min.x,
        box.max.x
      )
    ) {
      const stepDelta = box.max.y - player.position.y;
      if (
        player.grounded &&
        stepDelta > 0 &&
        stepDelta <= STEP_HEIGHT &&
        canStepUpToY(player.position.x, box.max.y, player.position.z, colliders, activeHeight)
      ) {
        player.position.y = box.max.y;
        continue;
      }

      if (stepVx > 0) {
        player.position.x = box.min.x - PLAYER_RADIUS;
        if (player.velocity.x > 0) player.velocity.x = 0;
      } else if (stepVx < 0) {
        player.position.x = box.max.x + PLAYER_RADIUS;
        if (player.velocity.x < 0) player.velocity.x = 0;
      } else {
        const pushLeft = Math.abs(player.position.x - (box.min.x - PLAYER_RADIUS));
        const pushRight = Math.abs(box.max.x + PLAYER_RADIUS - player.position.x);
        player.position.x =
          pushLeft <= pushRight ? box.min.x - PLAYER_RADIUS : box.max.x + PLAYER_RADIUS;
        player.velocity.x = 0;
      }
    }
  }

  // --- Z Axis ---
  const stepVz = player.velocity.z + extVz;
  player.position.z += stepVz * stepDt;
  for (const box of colliders) {
    const overlapX = intervalsOverlap(
      player.position.x - PLAYER_RADIUS + COLLISION_EPSILON,
      player.position.x + PLAYER_RADIUS - COLLISION_EPSILON,
      box.min.x,
      box.max.x
    );
    const overlapY = intervalsOverlap(
      player.position.y + COLLISION_EPSILON,
      player.position.y + activeHeight - COLLISION_EPSILON,
      box.min.y,
      box.max.y
    );
    if (!overlapX || !overlapY) continue;

    if (
      intervalsOverlap(
        player.position.z - PLAYER_RADIUS,
        player.position.z + PLAYER_RADIUS,
        box.min.z,
        box.max.z
      )
    ) {
      const stepDelta = box.max.y - player.position.y;
      if (
        player.grounded &&
        stepDelta > 0 &&
        stepDelta <= STEP_HEIGHT &&
        canStepUpToY(player.position.x, box.max.y, player.position.z, colliders, activeHeight)
      ) {
        player.position.y = box.max.y;
        continue;
      }

      if (stepVz > 0) {
        player.position.z = box.min.z - PLAYER_RADIUS;
        if (player.velocity.z > 0) player.velocity.z = 0;
      } else if (stepVz < 0) {
        player.position.z = box.max.z + PLAYER_RADIUS;
        if (player.velocity.z < 0) player.velocity.z = 0;
      } else {
        const pushBack = Math.abs(player.position.z - (box.min.z - PLAYER_RADIUS));
        const pushFront = Math.abs(box.max.z + PLAYER_RADIUS - player.position.z);
        player.position.z =
          pushBack <= pushFront ? box.min.z - PLAYER_RADIUS : box.max.z + PLAYER_RADIUS;
        player.velocity.z = 0;
      }
    }
  }

  // --- Y Axis ---
  player.position.y += player.velocity.y * stepDt;
  player.grounded = false;
  for (const box of colliders) {
    const overlapX = intervalsOverlap(
      player.position.x - PLAYER_RADIUS + COLLISION_EPSILON,
      player.position.x + PLAYER_RADIUS - COLLISION_EPSILON,
      box.min.x,
      box.max.x
    );
    const overlapZ = intervalsOverlap(
      player.position.z - PLAYER_RADIUS + COLLISION_EPSILON,
      player.position.z + PLAYER_RADIUS - COLLISION_EPSILON,
      box.min.z,
      box.max.z
    );
    if (!overlapX || !overlapZ) continue;

    if (
      intervalsOverlap(
        player.position.y,
        player.position.y + activeHeight,
        box.min.y,
        box.max.y
      )
    ) {
      if (player.velocity.y <= 0) {
        // Landing on top of a floor or cover box.
        player.position.y = box.max.y;
        player.velocity.y = 0;
        player.grounded = true;
      } else {
        // Bonking head on an underside ceiling.
        player.position.y = box.min.y - activeHeight;
        player.velocity.y = 0;
      }
    }
  }
}

/**
 * Ray-vs-AABB intersection using Kay-Kajiya's **Slab Method**.
 *
 * Concept:
 * An axis-aligned box is the intersection of three orthogonal "slabs"
 * (infinite space between two parallel planes: `min.x..max.x`, `min.y..max.y`,
 * `min.z..max.z`). A ray `P(t) = origin + dir * t` intersects the box iff the
 * `[tEnter, tExit]` intervals of all three slabs overlap.
 *
 * - `tNear` = `max(tEnter_x, tEnter_y, tEnter_z)` (last plane entered -> box entry)
 * - `tFar`  = `min(tExit_x, tExit_y, tExit_z)`    (first plane exited -> box exit)
 * - Hit exists when `tNear <= tFar` and `0 <= tNear <= maxDist`.
 * - The outward surface normal is simply `±1` along whichever axis set `tNear`.
 */
export function raycastAABB(
  origin: Vec3,
  dir: Vec3,
  box: AABB,
  maxDist = 200
): RaycastHit | null {
  let tNear = -Infinity;
  let tFar = Infinity;
  const normal: Vec3 = { x: 0, y: 0, z: 0 };

  const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];

  for (const axis of axes) {
    const o = origin[axis];
    const d = dir[axis];
    const bMin = box.min[axis];
    const bMax = box.max[axis];

    // Guard against division by zero when the ray runs parallel to a slab's planes.
    if (Math.abs(d) < 1e-8) {
      if (o < bMin || o > bMax) {
        return null;
      }
      continue;
    }

    const invD = 1 / d;
    let t1 = (bMin - o) * invD;
    let t2 = (bMax - o) * invD;
    let enterNormalSign = -1;

    // If ray travels in the negative axis direction, it enters through `max` and exits `min`.
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      enterNormalSign = 1;
    }

    if (t1 > tNear) {
      tNear = t1;
      normal.x = axis === 'x' ? enterNormalSign : 0;
      normal.y = axis === 'y' ? enterNormalSign : 0;
      normal.z = axis === 'z' ? enterNormalSign : 0;
    }

    if (t2 < tFar) {
      tFar = t2;
    }

    if (tNear > tFar) {
      return null;
    }
  }

  if (tNear < 0 || tNear > maxDist) {
    return null;
  }

  return {
    distance: tNear,
    point: {
      x: origin.x + dir.x * tNear,
      y: origin.y + dir.y * tNear,
      z: origin.z + dir.z * tNear,
    },
    normal,
  };
}

/**
 * Analytic Ray-vs-Sphere intersection via the **Quadratic Discriminant**.
 *
 * Mathematical derivation:
 * A point `P(t) = origin + t * dir` (with unit ray direction `||dir|| = 1`) lies
 * on a sphere of center `C` and radius `R` when:
 *   `||P(t) - C||^2 = R^2`
 *
 * Substituting `m = origin - C`:
 *   `(m + t * dir) · (m + t * dir) = R^2`
 *   `(dir · dir) * t^2 + 2 * (m · dir) * t + (m · m - R^2) = 0`
 *
 * Because `||dir|| = 1`, the quadratic simplifies to the monic form
 * `t^2 + 2*b*t + c = 0`, where:
 *   - `b = dot(m, dir)`
 *   - `c = dot(m, m) - radius^2`
 *
 * Applying the reduced quadratic formula `t = -b ± sqrt(b^2 - c)`:
 *   - Discriminant `disc = b^2 - c`:
 *     - `disc < 0`: ray misses the sphere completely (no real roots).
 *     - `disc >= 0`: entry root `t1 = -b - sqrt(disc)` and exit root `t2 = -b + sqrt(disc)`.
 *   - Selecting `tHit = t1 >= 0 ? t1 : t2` picks the entry intersection when the
 *     ray starts outside (`t1 >= 0`), or the exit surface (`t2`) when `origin` is
 *     already inside the sphere (`t1 < 0 < t2`).
 *   - Outward unit normal at impact is `(point - center) / radius`.
 */
export function raycastSphere(
  origin: Vec3,
  dir: Vec3,
  center: Vec3,
  radius: number,
  maxDist = 200
): RaycastHit | null {
  if (radius <= 0) return null;

  const mx = origin.x - center.x;
  const my = origin.y - center.y;
  const mz = origin.z - center.z;

  const b = mx * dir.x + my * dir.y + mz * dir.z;
  const c = mx * mx + my * my + mz * mz - radius * radius;
  const disc = b * b - c;

  if (disc < 0) {
    return null;
  }

  const sqrtDisc = Math.sqrt(disc);
  const t1 = -b - sqrtDisc;
  const t2 = -b + sqrtDisc;
  const tHit = t1 >= 0 ? t1 : t2;

  if (tHit < 0 || tHit > maxDist) {
    return null;
  }

  const px = origin.x + dir.x * tHit;
  const py = origin.y + dir.y * tHit;
  const pz = origin.z + dir.z * tHit;
  const invRadius = 1 / radius;

  return {
    distance: tHit,
    point: { x: px, y: py, z: pz },
    normal: {
      x: (px - center.x) * invRadius,
      y: (py - center.y) * invRadius,
      z: (pz - center.z) * invRadius,
    },
  };
}

/**
 * Advances a thrown ability projectile by `dt` seconds with gravity, swept ray-AABB
 * impact detection, and **Specular Reflection** bouncing.
 *
 * Physics & Bounce Math:
 * 1. **Semi-implicit Euler integration**: Apply gravitational acceleration
 *    (`vy -= gravity * dt`) and increment `age += dt`.
 * 2. **Swept collision ray**: Cast a ray along the normalized velocity vector
 *    with `maxDist = speed * dt + 0.08` (an `8cm` look-ahead padding prevents
 *    thin-wall tunneling at glancing angles).
 * 3. **Surface classification**:
 *    - `|normal.y| >= 0.5`: horizontal surface (floor, cover box top, or ceiling).
 *      If `normal.y >= 0.5 && proj.detonateOnFloor`, snap `position` to `hit.point`
 *      and signal `{ hit, hitHorizontalSurface: true }` for immediate detonation.
 *    - Otherwise (ceiling or vertical wall): bounce using **Specular Reflection**
 *      damped by `proj.restitution` (`e` in `[0, 1]`):
 *        `v_reflected = (v - 2 * dot(v, n) * n) * restitution`
 *      Subtracting `2 * dot(v, n) * n` reverses the component of velocity along the
 *      surface normal `n` while preserving the tangential component, then scaling by
 *      `restitution` models inelastic energy loss on bounce.
 *    - Finally, nudge `proj.position` `0.03m` outward along `hit.normal` so the next
 *      frame's ray never starts embedded behind the impacted face.
 */
export function stepProjectile(
  proj: AbilityProjectile,
  colliders: AABB[],
  dt: number
): { hit: RaycastHit | null; hitHorizontalSurface: boolean } {
  const stepDt = Math.max(0, dt);
  proj.velocity.y -= proj.gravity * stepDt;
  proj.age += stepDt;

  const speed = Math.hypot(proj.velocity.x, proj.velocity.y, proj.velocity.z);
  if (speed > 1e-6 && stepDt > 0) {
    const invSpeed = 1 / speed;
    const dir: Vec3 = {
      x: proj.velocity.x * invSpeed,
      y: proj.velocity.y * invSpeed,
      z: proj.velocity.z * invSpeed,
    };
    const sweepDist = speed * stepDt + 0.08;

    let nearestHit: RaycastHit | null = null;
    let nearestDist = sweepDist;

    for (const box of colliders) {
      const hit = raycastAABB(proj.position, dir, box, nearestDist);
      if (hit && hit.distance <= nearestDist) {
        nearestDist = hit.distance;
        nearestHit = hit;
      }
    }

    if (nearestHit) {
      const isHorizontalSurface = Math.abs(nearestHit.normal.y) >= 0.5;

      if (isHorizontalSurface && nearestHit.normal.y >= 0.5 && proj.detonateOnFloor) {
        proj.position.x = nearestHit.point.x;
        proj.position.y = nearestHit.point.y;
        proj.position.z = nearestHit.point.z;
        return { hit: nearestHit, hitHorizontalSurface: true };
      }

      // Specular reflection: v' = (v - 2 * dot(v, n) * n) * restitution
      const vn =
        proj.velocity.x * nearestHit.normal.x +
        proj.velocity.y * nearestHit.normal.y +
        proj.velocity.z * nearestHit.normal.z;
      const bounceFactor = 2 * vn;

      proj.velocity.x =
        (proj.velocity.x - bounceFactor * nearestHit.normal.x) * proj.restitution;
      proj.velocity.y =
        (proj.velocity.y - bounceFactor * nearestHit.normal.y) * proj.restitution;
      proj.velocity.z =
        (proj.velocity.z - bounceFactor * nearestHit.normal.z) * proj.restitution;

      // Nudge 0.03m along outward normal to avoid re-colliding with the same plane
      proj.position.x = nearestHit.point.x + nearestHit.normal.x * 0.03;
      proj.position.y = nearestHit.point.y + nearestHit.normal.y * 0.03;
      proj.position.z = nearestHit.point.z + nearestHit.normal.z * 0.03;

      return { hit: nearestHit, hitHorizontalSurface: isHorizontalSurface };
    }
  }

  proj.position.x += proj.velocity.x * stepDt;
  proj.position.y += proj.velocity.y * stepDt;
  proj.position.z += proj.velocity.z * stepDt;

  return { hit: null, hitHorizontalSurface: false };
}
