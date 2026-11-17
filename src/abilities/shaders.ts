import * as THREE from 'three';

/**
 * Custom GLSL ShaderMaterial factories for Chroma Strike Chapter 2 Ability VFX.
 *
 * ============================================================================
 * GPU Rendering & Shader Math Primer
 * ============================================================================
 * 1. **Z-Buffer Depth Rejection (`transparent: false`, `depthWrite: true`)**:
 *    Standard alpha-blended meshes (`transparent: true`) disable depth writes so
 *    distant objects don't disappear behind semi-transparent surfaces — which
 *    accidentally lets players see silhouettes or health bars through smoke!
 *    By keeping Smoke Dome `transparent: false` and `depthWrite: true`, the GPU
 *    writes every smoke fragment's depth `z_ndc` into the hardware depth buffer,
 *    strictly rejecting any pixel behind the dome during depth testing.
 *
 * 2. **Fresnel Rim Dot Product**:
 *    Given surface unit normal `N` and view vector `V = normalize(cameraPos - worldPos)`:
 *      `dot(N, V) = cos(theta)`
 *    At the center of a sphere facing the camera, `|dot(N, V)| -> 1` (grazing = 0).
 *    Near the silhouette edge, `N` is nearly perpendicular to `V`, so `|dot(N, V)| -> 0`.
 *    Raising `(1.0 - |dot(N, V)|)^2.2` concentrates glowing rim color along the
 *    sphere's silhouette while keeping the center dark and readable.
 *
 * 3. **GLSL `discard` Dissolve (Alpha-Test Cutout without Alpha Blending)**:
 *    Calling `discard` in a fragment shader aborts the fragment before it writes
 *    to either the color buffer or the Z-buffer. Comparing procedural 3D noise
 *    `n in [0.04, 0.96]` against a decreasing threshold `uDissolve` (`1.0 -> 0.0`)
 *    carves organic Swiss-cheese holes during the final 0.45s while remaining
 *    100% opaque everywhere `n <= uDissolve` — zero sorting artifacts!
 */

const SHARED_VORONOI_GLSL = /* glsl */ `
  // Deterministic 2D hash mapping integer lattice coordinates to pseudo-random [0, 1]^2
  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }

  // Computes Voronoi nearest (F1) and second-nearest (F2) Euclidean distances.
  // F2 - F1 approaches 0 along cell boundaries, producing crisp crystalline cracks
  // and glowing magma veins without requiring external noise textures.
  vec2 voronoi2D(vec2 x, float timePhase) {
    vec2 n = floor(x);
    vec2 f = fract(x);
    float f1 = 8.0;
    float f2 = 8.0;

    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = hash22(n + g);
        o = 0.5 + 0.42 * sin(timePhase + 6.2831853 * o);
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    return vec2(sqrt(f1), sqrt(f2));
  }
`;

/**
 * Blue [Q] Smoke Dome — 100% Opaque Z-Buffered Hollow Sphere Shader.
 *
 * - Outside (`gl_FrontFacing == true`): Dark slate-navy core with swirling cyan
 *   turbulence bands and an electric Fresnel silhouette rim.
 * - Inside (`gl_FrontFacing == false`): Moody swirling cavernous interior so
 *   players inside the dome can fight anyone inside with them, while seeing 0%
 *   of the arena outside.
 * - Final 0.45s (`uDissolve: 1.0 -> 0.0`): Organic `discard` Swiss-cheese dissolve.
 */
export function createSmokeDomeMaterial(colorHex: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uDissolve: { value: 1.0 },
      uColorCore: { value: new THREE.Color(0x072536) },
      uColorRim: { value: new THREE.Color(colorHex) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying vec3 vLocalPos;

      void main() {
        vLocalPos = position;
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPosition.xyz;
        // Transform surface normal into world space so Fresnel aligns with cameraPosition.
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uDissolve;
      uniform vec3 uColorCore;
      uniform vec3 uColorRim;

      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying vec3 vLocalPos;

      // Layered 3D trigonometric turbulence normalized strictly into [0.04, 0.96].
      // Keeping the range inside (0, 1) guarantees 0 pinholes when uDissolve = 1.0
      // and complete cutout dissolution when uDissolve reaches 0.0.
      float smokeTurbulence(vec3 localPos, float t) {
        vec3 q = localPos * 1.8;
        float oct1 = sin(q.x + t * 0.85) * cos(q.y - t * 0.65) * sin(q.z + t * 0.75);
        float oct2 = sin(q.x * 2.15 - q.z * 1.35 + t * 1.35) * cos(q.y * 2.25 + q.x * 0.85 - t * 1.15);
        float oct3 = cos(q.z * 3.9 + q.y * 2.6 - t * 1.85) * sin(q.x * 3.6 - q.y * 1.9 + t * 1.55);
        float sum = oct1 * 0.55 + oct2 * 0.30 + oct3 * 0.15;
        return clamp(0.5 + 0.46 * sum, 0.04, 0.96);
      }

      void main() {
        float n = smokeTurbulence(vLocalPos, uTime);

        // Organic Swiss-cheese dissolve without alpha blending
        if (n > uDissolve) {
          discard;
        }

        if (gl_FrontFacing) {
          // Exterior shell: view-dependent Fresnel rim + tactical slate-cyan core
          vec3 V = normalize(cameraPosition - vWorldPos);
          float fresnel = pow(1.0 - clamp(abs(dot(normalize(vNormal), V)), 0.0, 1.0), 2.2);
          vec3 col = mix(uColorCore, uColorRim, n * 0.45);
          col += uColorRim * fresnel * 0.95;
          gl_FragColor = vec4(col, 1.0);
        } else {
          // Interior hollow cavern: dark swirling mist, 100% opaque against outside world
          vec3 col = mix(vec3(0.03, 0.11, 0.16), uColorRim * 0.42, n * 0.5);
          gl_FragColor = vec4(col, 1.0);
        }
      }
    `,
  });
}

/**
 * Red [E] Inferno Orb — Pulsing Volcanic Magma Ground Shader.
 *
 * Uses Voronoi cellular distances (`F1`, `F2 - F1`) on the horizontal disc plane
 * to render molten yellow-orange-red magma veins bounded by a crisp glowing ring.
 */
export function createFireZoneMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vLocalPos;

      void main() {
        vUv = uv;
        vLocalPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uOpacity;

      varying vec2 vUv;
      varying vec3 vLocalPos;

      ${SHARED_VORONOI_GLSL}

      void main() {
        // CircleGeometry UVs sit in [0, 1] centered at (0.5, 0.5)
        vec2 centered = (vUv - 0.5) * 2.0;
        float r = length(centered);
        if (r > 1.0) discard;

        // Evaluate Voronoi in local XZ space (CircleGeometry is rotated -PI/2 on X)
        vec2 cell = voronoi2D(vLocalPos.xz * 1.15, uTime * 1.45);
        float f1 = cell.x;
        float f2 = cell.y;

        // Molten fissures along cell borders + pulsing radial thermal waves
        float veins = 1.0 - smoothstep(0.02, 0.24, f2 - f1);
        float wave = 0.5 + 0.5 * sin(r * 11.0 - uTime * 6.5 + f1 * 4.0);
        float heat = clamp((1.0 - f1 * 0.85) * 0.55 + veins * 0.55 + wave * 0.2, 0.0, 1.0);

        vec3 darkCrust = vec3(0.32, 0.03, 0.02);
        vec3 moltenRed = vec3(0.98, 0.22, 0.04);
        vec3 solarYellow = vec3(1.0, 0.86, 0.28);

        vec3 col = mix(darkCrust, moltenRed, smoothstep(0.15, 0.65, heat));
        col = mix(col, solarYellow, smoothstep(0.62, 0.98, heat));

        // Crisp glowing containment rim at the molotov boundary
        float edgeGlow = smoothstep(0.84, 0.94, r) * (1.0 - smoothstep(0.96, 1.0, r));
        col += vec3(1.0, 0.52, 0.14) * edgeGlow * 0.95;

        float baseMask = smoothstep(1.0, 0.91, r);
        float alpha = clamp((0.68 * baseMask + 0.32 * edgeGlow) * uOpacity, 0.0, 0.95);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

/**
 * Red [E] Inferno Orb — Vertical Scrolling Flame Crown Shader.
 *
 * Applied to an open-ended cylinder (`0.95m` tall) around the molotov perimeter.
 * Uses `2*PI`-periodic angular harmonics scrolling upward over `uTime` and
 * discards gaps between flame tongues for a sharp 3D silhouette.
 */
export function createFlameWallMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uOpacity;

      varying vec2 vUv;

      void main() {
        // Periodic circumferential angle guarantees zero seam at uv.x = 0 / 1
        float angle = vUv.x * 6.2831853;
        float y = vUv.y;
        float scrollY = y * 3.4 - uTime * 4.2;

        float w1 = sin(angle * 8.0 + uTime * 2.4 + sin(scrollY * 2.2));
        float w2 = cos(angle * 15.0 - uTime * 3.3 + scrollY * 3.5);
        float w3 = sin(angle * 24.0 + uTime * 4.8 - scrollY * 5.2);
        float flicker = 0.5 + 0.5 * (w1 * 0.50 + w2 * 0.32 + w3 * 0.18);

        // Taper flame tongues cleanly toward the top of the 0.95m cylinder
        float flameMask = flicker - y * 1.12 + 0.26;
        if (flameMask < 0.06) {
          discard;
        }

        vec3 baseWhiteYellow = vec3(1.0, 0.94, 0.48);
        vec3 midOrange = vec3(1.0, 0.38, 0.04);
        vec3 tipCrimson = vec3(0.95, 0.08, 0.04);

        vec3 col = mix(baseWhiteYellow, midOrange, smoothstep(0.05, 0.48, y));
        col = mix(col, tipCrimson, smoothstep(0.45, 0.95, y));

        float alpha = smoothstep(0.06, 0.38, flameMask) * (1.0 - y * 0.65) * 0.90 * uOpacity;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
      }
    `,
  });
}

/**
 * Blue [E] Cryo Field — Shimmering Crystalline Ice Fracture Shader.
 *
 * Renders high-contrast frosted glass shards (`F2 - F1` Voronoi fracture lines)
 * with travelling specular glints over `uTime` and average opacity ~0.82.
 */
export function createCryoFieldMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vLocalPos;

      void main() {
        vUv = uv;
        vLocalPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uOpacity;

      varying vec2 vUv;
      varying vec3 vLocalPos;

      ${SHARED_VORONOI_GLSL}

      void main() {
        vec2 centered = (vUv - 0.5) * 2.0;
        float r = length(centered);
        if (r > 1.0) discard;

        // Static crystalline fracture lattice with subtle phase shimmer
        vec2 cell = voronoi2D(vLocalPos.xz * 1.45, 0.35);
        float f1 = cell.x;
        float f2 = cell.y;

        // Sharp bright fracture lines where two Voronoi cells meet (F2 - F1 -> 0)
        float crack = 1.0 - smoothstep(0.0, 0.085, f2 - f1);
        float shardShade = clamp(0.35 + 0.55 * f1, 0.0, 1.0);

        // Sweeping glacial specular glint across crystal facets
        float glint = pow(0.5 + 0.5 * sin(vLocalPos.x * 1.85 + vLocalPos.z * 1.45 - uTime * 3.1 + f1 * 3.0), 5.0);
        float rim = smoothstep(0.86, 0.95, r) * (1.0 - smoothstep(0.98, 1.0, r));

        vec3 deepIce = vec3(0.08, 0.44, 0.72);
        vec3 brightCyan = vec3(0.38, 0.88, 1.0);
        vec3 frostWhite = vec3(0.94, 0.99, 1.0);

        vec3 col = mix(deepIce, brightCyan, shardShade);
        col = mix(col, frostWhite, clamp(crack * 0.92 + glint * 0.45 + rim * 0.7, 0.0, 1.0));

        float baseMask = smoothstep(1.0, 0.94, r);
        float alpha = clamp((0.76 + 0.16 * crack + 0.08 * rim) * baseMask * uOpacity, 0.0, 0.92);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}
