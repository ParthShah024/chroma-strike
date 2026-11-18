import type * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Optional Blender -> `.glb` -> `GLTFLoader` Hybrid Asset Pipeline for Chroma Strike.
 *
 * Why a hybrid procedural + optional `.glb` override loader?
 * 1. **Zero-Dependency Fallback**: Every agent, weapon viewmodel, and Spike prop ships
 *    with a self-contained procedural Three.js rig so the game boots cleanly with zero
 *    external binary assets required.
 * 2. **Drop-In Blender Upgrades**: Artists can export rigged/textured meshes from Blender
 *    (`File -> Export -> glTF 2.0 (.glb)`) into `public/models/<asset>.glb`. When present,
 *    `loadOptionalGlbAsset` swaps or augments the procedural rig at runtime without
 *    altering hitboxes, physics AABBs, or ability logic.
 * 3. **SPA-Safe Binary Probing**: Vite's dev server serves `index.html` (`200 OK`,
 *    `text/html`) for unknown paths instead of a 404. Probing `HEAD` Content-Type and/or
 *    the 4-byte binary glTF magic header (`"glTF"`) prevents `GLTFLoader` from trying to
 *    parse HTML as binary GLB and keeps the browser console completely noise-free.
 */

let sharedLoader: GLTFLoader | null = null;

function getLoader(): GLTFLoader {
  if (!sharedLoader) {
    sharedLoader = new GLTFLoader();
  }
  return sharedLoader;
}

function isHtmlLikeContentType(contentType: string): boolean {
  return (
    contentType.includes('text/html') ||
    contentType.includes('application/xhtml+xml') ||
    contentType.includes('text/plain') ||
    contentType.includes('application/json')
  );
}

function isBinaryGlbContentType(contentType: string): boolean {
  return (
    contentType.includes('model/gltf-binary') ||
    contentType.includes('application/octet-stream')
  );
}

async function hasGlbMagicHeader(url: string): Promise<boolean> {
  const probe = await fetch(url, {
    method: 'GET',
    headers: { Range: 'bytes=0-3' },
  });
  if (!probe.ok) return false;
  const ct = (probe.headers.get('content-type') ?? '').toLowerCase();
  if (isHtmlLikeContentType(ct)) return false;

  const buf = await probe.arrayBuffer();
  if (buf.byteLength < 4) return false;
  const bytes = new Uint8Array(buf, 0, 4);
  // Binary glTF magic header: ASCII "glTF" (0x67 0x6C 0x54 0x46)
  return bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

/**
 * Probes `url` and invokes `onLoaded(gltf.scene)` ONLY if a real binary `.glb` asset
 * exists at that path. Fails silently with zero console noise when absent so procedural
 * fallback rigs remain untouched.
 */
export function loadOptionalGlbAsset(url: string, onLoaded: (root: THREE.Group) => void): void {
  if (typeof fetch !== 'function') return;

  void (async () => {
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (!head.ok) return;

      const contentType = (head.headers.get('content-type') ?? '').toLowerCase();
      if (isHtmlLikeContentType(contentType)) return;

      const verified = isBinaryGlbContentType(contentType) || (await hasGlbMagicHeader(url));
      if (!verified) return;

      getLoader().load(
        url,
        (gltf) => {
          if (gltf?.scene) {
            onLoaded(gltf.scene);
          }
        },
        undefined,
        () => {
          // Silent fallback: keep procedural rig intact on parse/network error.
        },
      );
    } catch {
      // Silent fallback: keep procedural rig intact when offline or unhosted.
    }
  })();
}
