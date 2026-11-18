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
 *
 * 4. **Polygon Offset (killing floor Z-fighting)**:
 *    A ground disc lying exactly on the floor produces two fragments with the
 *    SAME depth per pixel; rounding noise then flips the depth test frame to
 *    frame ("Z-fighting" shimmer). `polygonOffset` adds a bias to each
 *    fragment's depth before the test:
 *      `depth' = depth + factor * maxSlope + units * r`
 *    where `maxSlope` is the polygon's depth gradient in screen space and `r`
 *    the smallest resolvable depth step. Negative factor/units (-2, -2) pull
 *    the decal toward the camera so it always wins against the floor, without
 *    physically lifting it (which would make it float at grazing angles).
 *
 * 5. **Domain Warping**:
 *    Instead of sampling noise at `p`, sample it at `p + k * noise(p)`. Feeding
 *    one turbulence field into the coordinates of another bends straight bands
 *    into curling filaments; doing it twice ("double warp", Inigo Quilez's
 *    `f(p + f(p + f(p)))`) yields the billowing nebula look of Void Smoke.
 *
 * 6. **Ridged Noise for Lightning**:
 *    Signed noise `n ∈ [-1, 1]` crosses zero along thin meandering curves.
 *    `1 - |n|` turns those zero-crossings into ridges peaking at 1, and raising
 *    the result to a high power (`pow(1 - |n|, 8)`) sharpens the ridges into
 *    hairline, branching filaments — a cheap procedural lightning fork. Summing
 *    octaves (ridged FBM) adds finer and finer side-branches.
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
    // Floor decal: pull the disc toward the camera in depth so it never
    // Z-fights the coplanar concrete arena floor (see primer note 4).
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
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
    // Floor decal: depth bias toward the camera prevents floor Z-fighting.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
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

// ============================================================================
// Chapter 3 — Umbra (violet) & Volt (gold) ability shaders
// ============================================================================

/**
 * Shared trigonometric turbulence (identical maths to the Smoke Dome) kept in
 * [0.04, 0.96] so a `discard` dissolve has no pinholes at uDissolve = 1 and
 * fully vanishes at uDissolve = 0.
 */
const SHARED_SMOKE_TURBULENCE_GLSL = /* glsl */ `
  float smokeTurbulence(vec3 localPos, float t) {
    vec3 q = localPos * 1.8;
    float oct1 = sin(q.x + t * 0.85) * cos(q.y - t * 0.65) * sin(q.z + t * 0.75);
    float oct2 = sin(q.x * 2.15 - q.z * 1.35 + t * 1.35) * cos(q.y * 2.25 + q.x * 0.85 - t * 1.15);
    float oct3 = cos(q.z * 3.9 + q.y * 2.6 - t * 1.85) * sin(q.x * 3.6 - q.y * 1.9 + t * 1.55);
    float sum = oct1 * 0.55 + oct2 * 0.30 + oct3 * 0.15;
    return clamp(0.5 + 0.46 * sum, 0.04, 0.96);
  }
`;

/**
 * Hash-based 2D value noise. Random values live on integer lattice corners and
 * are blended with the cubic Hermite (smoothstep) curve `f*f*(3-2f)`, giving a
 * continuous field in [0, 1] without any texture lookups.
 */
const SHARED_VALUE_NOISE_GLSL = /* glsl */ `
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float valueNoise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
`;

const DISC_VERTEX_GLSL = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vLocalPos;

  void main() {
    vUv = uv;
    vLocalPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Violet [Q] Void Smoke — 100% Opaque Domain-Warped Nebula Sphere.
 *
 * Same contract as `createSmokeDomeMaterial`, so `system.ts` can drive both
 * domes identically:
 *   - `uTime`     seconds, animates the nebula
 *   - `uDissolve` 1.0 -> 0.0 over the final 0.45 s (organic `discard` holes)
 *   - `uColor`    rim / nebula colour (also exposed as `uColorRim`, the SAME
 *                 uniform object, plus a `uColorCore` like the Smoke Dome, so
 *                 code written against either naming keeps working)
 *
 * Because it is `transparent: false` + `depthWrite: true`, nothing behind the
 * shell can ever be seen through it (see primer note 1).
 *
 * - Outside (`gl_FrontFacing`): deep void body streaked with double
 *   domain-warped amethyst filaments and a rich Fresnel rim.
 * - Inside (`!gl_FrontFacing`): a near-black cavernous violet interior with
 *   faint drifting wisps — anyone inside sees 0% of the outside arena.
 */
export function createVoidSmokeMaterial(colorHex = 0xa855f7): THREE.ShaderMaterial {
  const colorUniform = { value: new THREE.Color(colorHex) };
  return new THREE.ShaderMaterial({
    transparent: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uDissolve: { value: 1.0 },
      uColor: colorUniform,
      uColorRim: colorUniform, // alias: same object as uColor
      uColorCore: { value: new THREE.Color(0x12051f) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying vec3 vLocalPos;

      void main() {
        vLocalPos = position;
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPosition.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uDissolve;
      uniform vec3 uColor;
      uniform vec3 uColorCore;

      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying vec3 vLocalPos;

      ${SHARED_SMOKE_TURBULENCE_GLSL}

      // Double domain warp: f(p + k * f(p + k * f(p))). Each pass bends the
      // sampling coordinates of the next, curling bands into nebula filaments.
      // The final value is still a smokeTurbulence() call, so it stays inside
      // [0.04, 0.96] and the dissolve guarantee is preserved.
      float voidNebula(vec3 p, float t) {
        vec3 q = vec3(
          smokeTurbulence(p, t * 0.7),
          smokeTurbulence(p + vec3(5.2, 1.3, 2.8), t * 0.7),
          smokeTurbulence(p + vec3(1.7, 9.2, 4.1), t * 0.7)
        );
        vec3 r = vec3(
          smokeTurbulence(p + 2.2 * q + vec3(8.3, 2.8, 1.1), t * 0.55),
          smokeTurbulence(p + 2.2 * q + vec3(2.1, 6.4, 7.3), t * 0.55),
          smokeTurbulence(p + 2.2 * q + vec3(4.7, 3.9, 9.6), t * 0.55)
        );
        return smokeTurbulence(p + 2.0 * r, t * 0.45);
      }

      void main() {
        float n = voidNebula(vLocalPos, uTime);

        // Organic dissolve: holes open where the nebula is densest first.
        if (n > uDissolve) {
          discard;
        }

        // Edge glow on the dissolving lips so the holes read as "burning away".
        float lip = smoothstep(uDissolve - 0.06, uDissolve, n) * step(uDissolve, 0.999);

        if (gl_FrontFacing) {
          vec3 V = normalize(cameraPosition - vWorldPos);
          float fresnel = pow(1.0 - clamp(abs(dot(normalize(vNormal), V)), 0.0, 1.0), 2.4);
          float filaments = smoothstep(0.45, 0.85, n);
          vec3 col = mix(uColorCore, uColor * 0.55, filaments);
          col += uColor * fresnel * 1.1;                     // amethyst silhouette rim
          col += vec3(0.95, 0.8, 1.0) * fresnel * fresnel * 0.25; // hot lilac edge
          col += uColor * lip * 1.4;
          gl_FragColor = vec4(col, 1.0);
        } else {
          // Cavernous interior: near-black void with slow violet wisps.
          float wisps = smoothstep(0.55, 0.9, n);
          vec3 col = mix(vec3(0.025, 0.008, 0.05), uColor * 0.32, wisps);
          col += uColor * lip * 1.2;
          gl_FragColor = vec4(col, 1.0);
        }
      }
    `,
  });
}

/**
 * Violet [E] Singularity — Swirling Polar Accretion Vortex (floor disc).
 *
 * Works in polar coordinates `(r, ang)` around the disc centre. Adding a term
 * that grows as `1 / r` to the angle ("differential rotation") makes inner
 * material orbit faster than outer material, exactly like a real accretion
 * disc, which winds straight arms into tight spirals:
 *   `ang += 2.5 / (r + 0.15) + uTime * 3.0`
 * Inside `r < 0.18` is a pitch-black event horizon; just outside it a hot
 * violet-white accretion ring glows.
 *
 * Uniforms: `uTime` (seconds), `uFade` (1 -> 0 to fade out).
 * Intended for a `CircleGeometry` rotated flat (UVs centred at 0.5).
 */
export function createSingularityMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 1 },
    },
    vertexShader: DISC_VERTEX_GLSL,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uFade;

      varying vec2 vUv;
      varying vec3 vLocalPos;

      ${SHARED_VALUE_NOISE_GLSL}

      void main() {
        vec2 c = (vUv - 0.5) * 2.0;
        float r = length(c);
        if (r > 1.0) discard;

        // Differential rotation: inner radii are twisted much further.
        float ang = atan(c.y, c.x);
        ang += 2.5 / (r + 0.15) + uTime * 3.0;

        // Spiral arms (4-fold, periodic in ang so no seam at ±π) + dust grain
        // sampled on the swirled unit circle so the noise also spirals.
        float arms = pow(0.5 + 0.5 * sin(ang * 4.0 + r * 5.0), 2.5);
        vec2 swirl = vec2(cos(ang), sin(ang)) * (r * 4.0 + 1.0);
        float dust = valueNoise2D(swirl * 1.6 + uTime * 0.4);
        float density = clamp(arms * 0.7 + dust * 0.45, 0.0, 1.0) * (1.0 - smoothstep(0.55, 1.0, r));

        vec3 deepViolet = vec3(0.22, 0.03, 0.42);
        vec3 brightViolet = vec3(0.72, 0.32, 1.0);
        vec3 hotWhite = vec3(1.0, 0.9, 1.0);

        vec3 col = mix(deepViolet, brightViolet, density);

        // Hot accretion ring hugging the event horizon.
        float ring = exp(-pow((r - 0.24) / 0.055, 2.0));
        col = mix(col, hotWhite, ring * 0.85);

        // Event horizon: pitch black with a razor-thin soft edge.
        float horizon = 1.0 - smoothstep(0.16, 0.18, r);
        col = mix(col, vec3(0.0), horizon);

        float alpha = max(density * 0.85 + ring, horizon);
        alpha *= smoothstep(1.0, 0.88, r) * uFade;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
      }
    `,
  });
}

/**
 * Gold [E] Electric Relay — Crackling Ridged-FBM Lightning Disc.
 *
 * Two layers of ridged noise (primer note 6):
 *   1. Forks: 4 octaves of `pow(1 - |n|, 8)` on the disc plane, each octave
 *      re-seeded 20x per second so the bolts *jump* instead of sliding.
 *   2. Rings: radial shock rings `fract(r * 3 - uTime * 1.6)` whose phase is
 *      wobbled by noise and sharpened with the same ridge power.
 * A gold-white core blooms at the centre.
 *
 * Uniforms: `uTime` (seconds), `uFade` (1 -> 0), `uIntensity` (brightness
 * multiplier, e.g. spike to 2 on a discharge).
 */
export function createElectricRelayMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 1 },
      uIntensity: { value: 1 },
    },
    vertexShader: DISC_VERTEX_GLSL,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uFade;
      uniform float uIntensity;

      varying vec2 vUv;
      varying vec3 vLocalPos;

      ${SHARED_VALUE_NOISE_GLSL}

      void main() {
        vec2 c = (vUv - 0.5) * 2.0;
        float r = length(c);
        if (r > 1.0) discard;

        // Stepped time: a new random offset 20x per second = "jumping" bolts.
        float tick = floor(uTime * 20.0);
        vec2 jump = vec2(hash12(vec2(tick, 1.7)), hash12(vec2(tick, 9.3))) * 17.0;

        // 1. Ridged FBM forks.
        float forks = 0.0;
        float amp = 0.6;
        vec2 p = c * 2.6 + jump;
        for (int o = 0; o < 4; o++) {
          float n = valueNoise2D(p) * 2.0 - 1.0;   // signed noise in [-1, 1]
          forks += amp * pow(1.0 - abs(n), 8.0);   // hairline ridges at zero-crossings
          p = p * 2.03 + vec2(1.3, -0.7);
          amp *= 0.5;
        }

        // 2. Expanding radial shock rings with noisy phase wobble.
        float wobble = (valueNoise2D(c * 4.0 + jump * 0.3) - 0.5) * 0.35;
        float ringPhase = fract(r * 3.0 - uTime * 1.6 + wobble);
        float rings = pow(1.0 - abs(ringPhase * 2.0 - 1.0), 8.0);

        // Global strobe flicker + bright core.
        float flicker = 0.75 + 0.25 * step(0.35, hash12(vec2(tick, 4.2)));
        float core = exp(-r * r * 18.0);

        float edgeMask = 1.0 - smoothstep(0.82, 1.0, r);
        float energy = (forks * 1.1 + rings * 0.8) * edgeMask * flicker + core;
        energy *= uIntensity;

        vec3 gold = vec3(1.0, 0.74, 0.12);
        vec3 whiteHot = vec3(1.0, 0.98, 0.86);
        vec3 col = mix(gold, whiteHot, clamp(energy - 0.55, 0.0, 1.0)) * (0.6 + energy * 0.6);

        // Faint gold containment rim so the relay radius is readable.
        float rim = smoothstep(0.9, 0.96, r) * (1.0 - smoothstep(0.97, 1.0, r));
        col += gold * rim * 0.6;

        float alpha = clamp(energy * 0.9 + rim * 0.5 + 0.08 * edgeMask, 0.0, 1.0) * uFade;
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}
