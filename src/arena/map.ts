import * as THREE from 'three';
import type { AABB, Vec3 } from '../core/types';

/**
 * Default player spawn location in the Attacker side of the range (`+Z`),
 * looking north (`-Z`) toward the tactical lanes and Defender cover.
 */
export const PLAYER_SPAWN: Vec3 = { x: 0, y: 0.1, z: 18 };

/**
 * Static axis-aligned bounding boxes (AABBs) forming the tactical arena.
 *
 * Having a single source of truth (`ARENA_COLLIDERS`) drives BOTH physics
 * collision/raycasting AND visual 3D mesh generation in `buildArenaScene`,
 * guaranteeing zero desync between what players see and what bullets/feet hit.
 */
export const ARENA_COLLIDERS: AABB[] = [
  // Ground floor slab (48m wide x 52m deep, top surface at y = 0)
  {
    min: { x: -24, y: -0.5, z: -26 },
    max: { x: 24, y: 0, z: 26 },
    tag: 'floor',
    color: 0x1a1f2b,
  },

  // Perimeter walls (5m tall) framing the tactical range
  {
    min: { x: -24, y: 0, z: -26 },
    max: { x: 24, y: 5, z: -25 },
    tag: 'wall',
    color: 0x252c3d,
  },
  {
    min: { x: -24, y: 0, z: 25 },
    max: { x: 24, y: 5, z: 26 },
    tag: 'wall',
    color: 0x252c3d,
  },
  {
    min: { x: -24, y: 0, z: -26 },
    max: { x: -23, y: 5, z: 26 },
    tag: 'wall',
    color: 0x252c3d,
  },
  {
    min: { x: 23, y: 0, z: -26 },
    max: { x: 24, y: 5, z: 26 },
    tag: 'wall',
    color: 0x252c3d,
  },

  // Tactical cover geometry (sightline breakers, jiggle-peek angles, head-glitch box)
  // Mid Center Pillar
  {
    min: { x: -2, y: 0, z: -2 },
    max: { x: 2, y: 3.2, z: 2 },
    tag: 'cover',
    color: 0x323b4f,
  },
  // Attacker Mid Box
  {
    min: { x: -4.5, y: 0, z: 9 },
    max: { x: -1.5, y: 1.5, z: 11 },
    tag: 'cover',
    color: 0x39445c,
  },
  // Attacker Right Wall
  {
    min: { x: 6, y: 0, z: 7 },
    max: { x: 11, y: 2.8, z: 8.2 },
    tag: 'cover',
    color: 0x323b4f,
  },
  // West Lane Divider
  {
    min: { x: -13, y: 0, z: -8 },
    max: { x: -11.5, y: 3.0, z: 6 },
    tag: 'cover',
    color: 0x2e374a,
  },
  // East Lane Box
  {
    min: { x: 11.5, y: 0, z: -6 },
    max: { x: 14.5, y: 2.2, z: -2 },
    tag: 'cover',
    color: 0x39445c,
  },
  // Defender Head-Glitch Box Left: height 1.32m intentionally exposes a
  // standing target's head hitbox (y = 1.38..1.82) while shielding the body.
  {
    min: { x: -10, y: 0, z: -15 },
    max: { x: -6, y: 1.32, z: -13.5 },
    tag: 'cover',
    color: 0x3d4861,
  },
  // Defender Cover Right
  {
    min: { x: 6, y: 0, z: -15 },
    max: { x: 10, y: 1.6, z: -13.5 },
    tag: 'cover',
    color: 0x3d4861,
  },
];

/**
 * Populates a Three.js scene with atmospheric lighting, ground reference grid,
 * and crisp edge-outlined box meshes for every collider in `ARENA_COLLIDERS`.
 */
export function buildArenaScene(scene: THREE.Scene): void {
  const bgColor = 0x0d1117;
  scene.background = new THREE.Color(bgColor);
  scene.fog = new THREE.Fog(bgColor, 26, 82);

  // Sky/ground hemisphere fill keeps shadowed corners readable, while the
  // directional key light carves distinct faces for instant spatial depth.
  const hemiLight = new THREE.HemisphereLight(0xd8e2ff, 0x161b22, 0.85);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.15);
  dirLight.position.set(16, 28, 18);
  scene.add(dirLight);

  // Subtle 1m tactical floor grid raised slightly (y = 0.01) to prevent z-fighting.
  const grid = new THREE.GridHelper(52, 52, 0x2b364d, 0x1f2636);
  grid.position.y = 0.01;
  scene.add(grid);

  // Shared edge material highlights corners & peek angles like Valorant's Range.
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: 0x627599,
    transparent: true,
    opacity: 0.48,
  });

  for (const box of ARENA_COLLIDERS) {
    const sizeX = box.max.x - box.min.x;
    const sizeY = box.max.y - box.min.y;
    const sizeZ = box.max.z - box.min.z;

    const geometry = new THREE.BoxGeometry(sizeX, sizeY, sizeZ);
    const isFloor = box.tag === 'floor';
    const material = new THREE.MeshStandardMaterial({
      color: box.color ?? 0x2e374a,
      roughness: isFloor ? 0.92 : 0.76,
      metalness: isFloor ? 0.04 : 0.1,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(
      (box.min.x + box.max.x) * 0.5,
      (box.min.y + box.max.y) * 0.5,
      (box.min.z + box.max.z) * 0.5
    );
    scene.add(mesh);

    if (!isFloor) {
      const edgesGeo = new THREE.EdgesGeometry(geometry);
      const outline = new THREE.LineSegments(edgesGeo, edgeMaterial);
      mesh.add(outline);
    }
  }
}
