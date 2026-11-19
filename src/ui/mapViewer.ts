import * as THREE from 'three';
import { Combatant, MatchHudState, PlayerState, Vec3 } from '../core/types';
import {
  ARENA_COLLIDERS,
  ASCENT_CALLOUTS,
  getArenaDoors,
  setArenaBuyBarriersVisible,
  toggleArenaDoor,
} from '../arena/map';
import { EYE_HEIGHT, raycastAABB } from '../physics/movement';
import {
  drawAscentBlueprintBase,
  drawAscentDynamicEntities,
  mapToWorldX,
  mapToWorldZ,
  worldToMapX,
  worldToMapY,
} from './minimap';

export type ViewerTab = '2d' | '3d';

export interface MapViewerController {
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): boolean;
  setTab(tab: ViewerTab): void;
  is3DViewActive(): boolean;
  render3D(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void;
  update2D(hud: MatchHudState, combatants: readonly Combatant[], player: PlayerState): void;
  setOnClose(cb: () => void): void;
  dispose(): void;
}

interface CameraPreset {
  id: string;
  target: Vec3;
  theta: number;
  phi: number;
  radius: number;
}

const CAMERA_PRESETS: Record<string, CameraPreset> = {
  overview: {
    id: 'overview',
    target: { x: 0, y: 0.5, z: -2 },
    theta: 0.44,
    phi: 0.72,
    radius: 92,
  },
  site_a: {
    id: 'site_a',
    target: { x: -25.5, y: 1.5, z: -20.5 },
    theta: 0.65,
    phi: 0.96,
    radius: 26,
  },
  a_tree: {
    id: 'a_tree',
    target: { x: -12.0, y: 0.8, z: -12.0 },
    theta: 0.78,
    phi: 0.88,
    radius: 24,
  },
  mid_market: {
    id: 'mid_market',
    target: { x: 3.5, y: 0.6, z: -10.5 },
    theta: -0.45,
    phi: 0.82,
    radius: 30,
  },
  site_b: {
    id: 'site_b',
    target: { x: 27.0, y: 1.0, z: -21.5 },
    theta: -0.68,
    phi: 0.88,
    radius: 27,
  },
  t_spawn: {
    id: 't_spawn',
    target: { x: 0, y: 0.5, z: 34.0 },
    theta: 0.25,
    phi: 0.85,
    radius: 30,
  },
  ct_spawn: {
    id: 'ct_spawn',
    target: { x: 2.0, y: 0.5, z: -38.0 },
    theta: 2.85,
    phi: 0.85,
    radius: 30,
  },
};

const PHI_MIN = 0.18;
const PHI_MAX = 1.45;
const RADIUS_MIN = 16;
const RADIUS_MAX = 135;

const DEFAULT_BLUEPRINT_W = 620;
const DEFAULT_BLUEPRINT_H = 680;
const BLUEPRINT_DPR = 2;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function getCalloutPinY(name: string, baseY: number): number {
  if (name === 'A HEAVEN') return baseY + 1.85;
  if (name === 'A HELL') return baseY + 0.95;
  return baseY + 2.0;
}

/**
 * Creates the `[M]` Valorant Tactical 2D Blueprint & 3D Ascent Orbit Viewer.
 */
export function createMapViewerController(_scene: THREE.Scene): MapViewerController {
  const modalEl = document.getElementById('map-viewer-modal') as HTMLDivElement | null;
  const tab3dBtn = document.getElementById('mv-tab-3d') as HTMLButtonElement | null;
  const tab2dBtn = document.getElementById('mv-tab-2d') as HTMLButtonElement | null;
  const closeBtn = document.getElementById('mv-close-btn') as HTMLButtonElement | null;

  const layer3dEl = document.getElementById('map-viewer-3d-layer') as HTMLDivElement | null;
  const orbitSurfaceEl = document.getElementById('map-viewer-orbit-surface') as HTMLDivElement | null;
  const pinsLayerEl = document.getElementById('map-viewer-pins') as HTMLDivElement | null;
  const toggleBarriersBtn = document.getElementById('mv-toggle-barriers') as HTMLButtonElement | null;
  const toggleCalloutsBtn = document.getElementById('mv-toggle-callouts') as HTMLButtonElement | null;
  const doorABtn = document.getElementById('mv-door-a-btn') as HTMLButtonElement | null;
  const doorBBtn = document.getElementById('mv-door-b-btn') as HTMLButtonElement | null;
  const presetBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-mv-preset]')
  );

  const layer2dEl = document.getElementById('map-viewer-2d-layer') as HTMLDivElement | null;
  const canvas2d = document.getElementById('map-viewer-2d-canvas') as HTMLCanvasElement | null;
  const ctx2d = canvas2d?.getContext('2d') ?? null;
  const rulerReadoutEl = document.getElementById('mv-ruler-readout') as HTMLDivElement | null;
  const zoomReadoutEl = document.getElementById('mv-2d-zoom') as HTMLSpanElement | null;
  const reset2dBtn = document.getElementById('mv-2d-reset-btn') as HTMLButtonElement | null;

  let blueprintW = DEFAULT_BLUEPRINT_W;
  let blueprintH = DEFAULT_BLUEPRINT_H;
  let staticBlueprintW = 0;
  let staticBlueprintH = 0;

  // Cached static 2D blueprint (2x DPR backing buffer, e.g. 1240x1360)
  const staticBlueprint = document.createElement('canvas');
  const staticCtx = staticBlueprint.getContext('2d');

  function syncBlueprintBufferSize(): void {
    let targetW = DEFAULT_BLUEPRINT_W;
    let targetH = DEFAULT_BLUEPRINT_H;

    if (canvas2d && canvas2d.clientWidth > 40 && canvas2d.clientHeight > 40) {
      targetW = Math.round(canvas2d.clientWidth);
      targetH = Math.round(canvas2d.clientHeight);
    }

    const pixelW = targetW * BLUEPRINT_DPR;
    const pixelH = targetH * BLUEPRINT_DPR;

    if (canvas2d && (canvas2d.width !== pixelW || canvas2d.height !== pixelH)) {
      canvas2d.width = pixelW;
      canvas2d.height = pixelH;
    }

    if (targetW === staticBlueprintW && targetH === staticBlueprintH) {
      blueprintW = targetW;
      blueprintH = targetH;
      return;
    }

    blueprintW = targetW;
    blueprintH = targetH;
    staticBlueprintW = targetW;
    staticBlueprintH = targetH;

    staticBlueprint.width = pixelW;
    staticBlueprint.height = pixelH;
    if (staticCtx) {
      staticCtx.setTransform(BLUEPRINT_DPR, 0, 0, BLUEPRINT_DPR, 0, 0);
      drawAscentBlueprintBase(staticCtx, {
        width: blueprintW,
        height: blueprintH,
        showCallouts: true,
        showSiteLabels: true,
        labelScale: (blueprintW / 580) * 1.32,
      });
    }
  }

  syncBlueprintBufferSize();

  // 3D Orbit Camera
  const orbitCam = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / Math.max(1, window.innerHeight),
    0.2,
    320
  );

  let openState = false;
  let activeTab: ViewerTab = '2d';
  let onCloseCallback: (() => void) | null = null;

  let showBarriers = false;
  let showCallouts = true;

  // Orbit spherical state + smooth targets
  const initialPreset = CAMERA_PRESETS.overview;
  let theta = initialPreset.theta;
  let phi = initialPreset.phi;
  let radius = initialPreset.radius;
  const target = new THREE.Vector3(
    initialPreset.target.x,
    initialPreset.target.y,
    initialPreset.target.z
  );

  let desiredTheta = theta;
  let desiredPhi = phi;
  let desiredRadius = radius;
  const desiredTarget = target.clone();
  let activePresetId: string | null = 'overview';

  let lastRenderMs = performance.now();
  let drag3dMode: 'orbit' | 'pan' | null = null;
  let lastPointerX = 0;
  let lastPointerY = 0;

  // Build projected 3D Callout Pin elements once
  const pinEntries: Array<{
    callout: (typeof ASCENT_CALLOUTS)[number];
    el: HTMLDivElement;
  }> = [];

  if (pinsLayerEl) {
    pinsLayerEl.replaceChildren();
    for (const c of ASCENT_CALLOUTS) {
      const pin = document.createElement('div');
      pin.className = `mv-callout-pin${c.major ? ' major' : ''}${c.name === 'A HEAVEN' ? ' high' : ''}`;
      pin.textContent = c.name === 'A HEAVEN' ? 'A HEAVEN (+3m)' : c.name;
      pinsLayerEl.appendChild(pin);
      pinEntries.push({ callout: c, el: pin });
    }
  }

  // 2D Blueprint Zoom / Pan / LoS Ruler state
  let zoom2d = 1.0;
  let pan2dX = 0;
  let pan2dY = 0;
  let drag2dMode: 'ruler' | 'pan' | null = null;
  let drag2dLastSx = 0;
  let drag2dLastSy = 0;

  let rulerActive = false;
  let rulerStart = { x: 0, z: 0 };
  let rulerEnd = { x: 0, z: 0 };
  let rulerDistM = 0;
  let rulerBlocked = false;
  let rulerBlockPoint: Vec3 | null = null;
  let rulerBlockDistM = 0;

  let last2dSnapshot: {
    hud: MatchHudState;
    combatants: readonly Combatant[];
    player: PlayerState;
  } | null = null;

  const tempProj = new THREE.Vector3();

  function syncBodyClasses(): void {
    document.body.classList.toggle('map-viewer-open', openState);
    document.body.classList.toggle('map-viewer-3d', openState && activeTab === '3d');
  }

  function syncTabUi(): void {
    const is3d = activeTab === '3d';
    modalEl?.classList.toggle('mode-3d', is3d);
    modalEl?.classList.toggle('mode-2d', !is3d);
    tab3dBtn?.classList.toggle('active', is3d);
    tab2dBtn?.classList.toggle('active', !is3d);
    layer3dEl?.classList.toggle('hidden', !is3d);
    layer2dEl?.classList.toggle('hidden', is3d);
    syncBodyClasses();
  }

  function syncPresetButtons(): void {
    for (const btn of presetBtns) {
      btn.classList.toggle('active', btn.dataset.mvPreset === activePresetId);
    }
  }

  function syncToggleUi(): void {
    if (toggleBarriersBtn) {
      toggleBarriersBtn.textContent = `Buy Barriers: ${showBarriers ? 'ON' : 'OFF'}`;
      toggleBarriersBtn.classList.toggle('active', showBarriers);
    }
    if (toggleCalloutsBtn) {
      toggleCalloutsBtn.textContent = `Callouts: ${showCallouts ? 'ON' : 'OFF'}`;
      toggleCalloutsBtn.classList.toggle('active', showCallouts);
    }
    pinsLayerEl?.classList.toggle('hidden', !showCallouts || activeTab !== '3d');

    const doors = getArenaDoors();
    const doorA = doors.find((d) => d.id === 'a_tree');
    const doorB = doors.find((d) => d.id === 'b_market');

    if (doorABtn && doorA) {
      doorABtn.textContent = `A Tree Door: ${doorA.status.toUpperCase()}`;
      doorABtn.dataset.status = doorA.status;
    }
    if (doorBBtn && doorB) {
      doorBBtn.textContent = `B Market Door: ${doorB.status.toUpperCase()}`;
      doorBBtn.dataset.status = doorB.status;
    }
  }

  function applyPreset(presetId: string, immediate = false): void {
    const preset = CAMERA_PRESETS[presetId];
    if (!preset) return;
    activePresetId = presetId;
    desiredTarget.set(preset.target.x, preset.target.y, preset.target.z);
    desiredTheta = preset.theta;
    desiredPhi = clamp(preset.phi, PHI_MIN, PHI_MAX);
    desiredRadius = clamp(preset.radius, RADIUS_MIN, RADIUS_MAX);
    if (immediate) {
      target.copy(desiredTarget);
      theta = desiredTheta;
      phi = desiredPhi;
      radius = desiredRadius;
    }
    syncPresetButtons();
  }

  function updateOrbitCameraPosition(): void {
    const sinPhi = Math.sin(phi);
    orbitCam.position.set(
      target.x + radius * sinPhi * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * sinPhi * Math.cos(theta)
    );
    orbitCam.lookAt(target);
    orbitCam.updateMatrixWorld();
  }

  function updateProjectedPins(): void {
    if (!showCallouts || activeTab !== '3d') return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    for (const entry of pinEntries) {
      const c = entry.callout;
      tempProj.set(c.x, getCalloutPinY(c.name, c.y ?? 0), c.z).project(orbitCam);
      const inFrustum =
        tempProj.z > -1 &&
        tempProj.z < 1 &&
        tempProj.x >= -0.95 &&
        tempProj.x <= 0.95 &&
        tempProj.y >= -0.92 &&
        tempProj.y <= 0.92;

      if (!inFrustum) {
        entry.el.style.display = 'none';
        continue;
      }

      const sx = (tempProj.x * 0.5 + 0.5) * vw;
      const sy = (-tempProj.y * 0.5 + 0.5) * vh;
      entry.el.style.display = 'block';
      entry.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -50%)`;
    }
  }

  function render3D(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    if (!openState || activeTab !== '3d') return;

    const now = performance.now();
    const dt = Math.min(Math.max((now - lastRenderMs) / 1000, 0.001), 0.05);
    lastRenderMs = now;

    const smooth = 1 - Math.exp(-12 * dt);
    theta += (desiredTheta - theta) * smooth;
    phi += (desiredPhi - phi) * smooth;
    radius += (desiredRadius - radius) * smooth;
    target.lerp(desiredTarget, smooth);

    updateOrbitCameraPosition();
    syncToggleUi();
    renderer.render(scene, orbitCam);
    updateProjectedPins();
  }

  // -------------------------------------------------------------------------
  // 2D Blueprint Coordinate Transforms & Interactive LoS Ruler
  // -------------------------------------------------------------------------
  function clientToLogical2d(clientX: number, clientY: number): { sx: number; sy: number } | null {
    if (!canvas2d) return null;
    const rect = canvas2d.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      sx: ((clientX - rect.left) / rect.width) * blueprintW,
      sy: ((clientY - rect.top) / rect.height) * blueprintH,
    };
  }

  function logicalToWorld2d(sx: number, sy: number): { x: number; z: number } {
    const mx = (sx - blueprintW * 0.5 - pan2dX) / zoom2d + blueprintW * 0.5;
    const my = (sy - blueprintH * 0.5 - pan2dY) / zoom2d + blueprintH * 0.5;
    return {
      x: mapToWorldX(mx, blueprintW),
      z: mapToWorldZ(my, blueprintH),
    };
  }

  function clamp2dPan(): void {
    const maxPanX = blueprintW * 0.45 * zoom2d;
    const maxPanY = blueprintH * 0.45 * zoom2d;
    pan2dX = clamp(pan2dX, -maxPanX, maxPanX);
    pan2dY = clamp(pan2dY, -maxPanY, maxPanY);
  }

  function recomputeRulerLoS(): void {
    const dx = rulerEnd.x - rulerStart.x;
    const dz = rulerEnd.z - rulerStart.z;
    const dist = Math.hypot(dx, dz);
    rulerDistM = dist;
    rulerBlocked = false;
    rulerBlockPoint = null;
    rulerBlockDistM = dist;

    if (dist < 0.15) {
      syncRulerHud();
      return;
    }

    const origin: Vec3 = { x: rulerStart.x, y: EYE_HEIGHT, z: rulerStart.z };
    const dir: Vec3 = { x: dx / dist, y: 0, z: dz / dist };

    let nearestDist = dist;
    let nearestPoint: Vec3 | null = null;
    for (const box of ARENA_COLLIDERS) {
      const hit = raycastAABB(origin, dir, box, nearestDist);
      if (hit && hit.distance < nearestDist) {
        nearestDist = hit.distance;
        nearestPoint = hit.point;
      }
    }

    if (nearestPoint) {
      rulerBlocked = true;
      rulerBlockPoint = nearestPoint;
      rulerBlockDistM = nearestDist;
    }
    syncRulerHud();
  }

  function syncRulerHud(): void {
    if (zoomReadoutEl) {
      zoomReadoutEl.textContent = `${zoom2d.toFixed(2)}x`;
    }
    if (!rulerReadoutEl) return;
    if (!rulerActive || rulerDistM < 0.25) {
      rulerReadoutEl.className = 'mv-ruler-readout';
      rulerReadoutEl.textContent = 'RULER: Left-drag on blueprint to measure distance & 1.62m LoS';
      return;
    }

    if (rulerBlocked) {
      rulerReadoutEl.className = 'mv-ruler-readout blocked';
      rulerReadoutEl.textContent = `SIGHTLINE: ${rulerDistM.toFixed(1)} m • BLOCKED @ ${rulerBlockDistM.toFixed(1)} m`;
    } else {
      rulerReadoutEl.className = 'mv-ruler-readout clear';
      rulerReadoutEl.textContent = `SIGHTLINE: ${rulerDistM.toFixed(1)} m • CLEAR (1.62m EYE)`;
    }
  }

  function drawRulerOverlay(ctx: CanvasRenderingContext2D): void {
    if (!rulerActive || rulerDistM < 0.25) return;

    const x0 = worldToMapX(rulerStart.x, blueprintW);
    const y0 = worldToMapY(rulerStart.z, blueprintH);
    const x1 = worldToMapX(rulerEnd.x, blueprintW);
    const y1 = worldToMapY(rulerEnd.z, blueprintH);
    const invScale = 1 / Math.sqrt(zoom2d);

    ctx.save();
    if (rulerBlocked && rulerBlockPoint) {
      const bx = worldToMapX(rulerBlockPoint.x, blueprintW);
      const by = worldToMapY(rulerBlockPoint.z, blueprintH);

      // Clear segment up to impact
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2.2 * invScale;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(bx, by);
      ctx.stroke();

      // Obstructed segment beyond impact
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.9 * invScale;
      ctx.setLineDash([5 * invScale, 4 * invScale]);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.setLineDash([]);

      // Impact X mark
      const r = 4.5 * invScale;
      ctx.strokeStyle = '#ff4d6d';
      ctx.lineWidth = 2.2 * invScale;
      ctx.beginPath();
      ctx.moveTo(bx - r, by - r);
      ctx.lineTo(bx + r, by + r);
      ctx.moveTo(bx + r, by - r);
      ctx.lineTo(bx - r, by + r);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#2ecc71';
      ctx.shadowColor = 'rgba(46, 204, 113, 0.7)';
      ctx.shadowBlur = 6;
      ctx.lineWidth = 2.3 * invScale;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Endpoint nodes
    for (const [nx, ny] of [
      [x0, y0],
      [x1, y1],
    ]) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#0d1117';
      ctx.lineWidth = 1.5 * invScale;
      ctx.beginPath();
      ctx.arc(nx, ny, 3.6 * invScale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Floating distance + status pill at midpoint
    const mx = (x0 + x1) * 0.5;
    const my = (y0 + y1) * 0.5 - 12 * invScale;
    const label = `${rulerDistM.toFixed(1)} m • ${rulerBlocked ? 'BLOCKED' : 'CLEAR'}`;
    ctx.save();
    ctx.translate(mx, my);
    ctx.scale(invScale, invScale);
    ctx.font = '800 10.5px Inter, "Segoe UI", sans-serif';
    const textW = ctx.measureText(label).width;
    const padX = 7;
    const boxW = textW + padX * 2;
    const boxH = 18;
    ctx.fillStyle = 'rgba(9, 14, 23, 0.92)';
    ctx.strokeStyle = rulerBlocked ? '#ef4444' : '#2ecc71';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(-boxW * 0.5, -boxH * 0.5, boxW, boxH, 5);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = rulerBlocked ? '#fca5a5' : '#86efac';
    ctx.fillText(label, 0, 0.5);
    ctx.restore();

    ctx.restore();
  }

  function render2DBlueprint(
    hud: MatchHudState | null,
    combatants: readonly Combatant[],
    player: PlayerState | null
  ): void {
    if (!canvas2d || !ctx2d) return;
    syncBlueprintBufferSize();
    const nowSec = performance.now() * 0.001;

    ctx2d.setTransform(BLUEPRINT_DPR, 0, 0, BLUEPRINT_DPR, 0, 0);
    ctx2d.clearRect(0, 0, blueprintW, blueprintH);
    ctx2d.fillStyle = '#070b12';
    ctx2d.fillRect(0, 0, blueprintW, blueprintH);

    ctx2d.save();
    ctx2d.translate(blueprintW * 0.5 + pan2dX, blueprintH * 0.5 + pan2dY);
    ctx2d.scale(zoom2d, zoom2d);
    ctx2d.translate(-blueprintW * 0.5, -blueprintH * 0.5);

    ctx2d.drawImage(staticBlueprint, 0, 0, blueprintW, blueprintH);

    if (hud && player) {
      const playerCombatant = combatants.find((c) => c.isPlayer);
      drawAscentDynamicEntities(ctx2d, {
        width: blueprintW,
        height: blueprintH,
        hud,
        combatants,
        player,
        playerYaw: playerCombatant?.yaw ?? 0,
        ultRevealActive: false,
        nowSec,
        detailedDoors: true,
        drawSiteLabelsUpright: false,
        entityScale: (blueprintW / 580) * 1.4,
      });
    }

    drawRulerOverlay(ctx2d);
    ctx2d.restore();
  }

  function update2D(
    hud: MatchHudState,
    combatants: readonly Combatant[],
    player: PlayerState
  ): void {
    last2dSnapshot = { hud, combatants, player };
    if (!openState || activeTab !== '2d') return;
    render2DBlueprint(hud, combatants, player);
  }

  function redraw2DIfActive(): void {
    if (!openState || activeTab !== '2d') return;
    if (last2dSnapshot) {
      render2DBlueprint(last2dSnapshot.hud, last2dSnapshot.combatants, last2dSnapshot.player);
    } else {
      render2DBlueprint(null, [], null);
    }
  }

  // -------------------------------------------------------------------------
  // Event Listeners (3D Orbit/Pan/Zoom + 2D Zoom/Pan/LoS Ruler + Buttons)
  // -------------------------------------------------------------------------
  const onWindowResize = () => {
    orbitCam.aspect = window.innerWidth / Math.max(1, window.innerHeight);
    orbitCam.updateProjectionMatrix();
    if (openState && activeTab === '2d') {
      syncBlueprintBufferSize();
      redraw2DIfActive();
    }
  };

  const onOrbitMouseDown = (e: MouseEvent) => {
    if (!openState || activeTab !== '3d') return;
    e.preventDefault();
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    drag3dMode = e.button === 2 || e.shiftKey ? 'pan' : 'orbit';
  };

  const onOrbitWheel = (e: WheelEvent) => {
    if (!openState || activeTab !== '3d') return;
    e.preventDefault();
    const zoomFactor = Math.exp(e.deltaY * 0.0011);
    desiredRadius = clamp(desiredRadius * zoomFactor, RADIUS_MIN, RADIUS_MAX);
  };

  const on2dMouseDown = (e: MouseEvent) => {
    if (!openState || activeTab !== '2d') return;
    e.preventDefault();
    const pt = clientToLogical2d(e.clientX, e.clientY);
    if (!pt) return;

    if (e.button === 2 || e.shiftKey) {
      drag2dMode = 'pan';
      drag2dLastSx = pt.sx;
      drag2dLastSy = pt.sy;
    } else if (e.button === 0) {
      drag2dMode = 'ruler';
      const world = logicalToWorld2d(pt.sx, pt.sy);
      rulerStart = world;
      rulerEnd = world;
      rulerActive = true;
      recomputeRulerLoS();
      redraw2DIfActive();
    }
  };

  const on2dWheel = (e: WheelEvent) => {
    if (!openState || activeTab !== '2d') return;
    e.preventDefault();
    const pt = clientToLogical2d(e.clientX, e.clientY);
    if (!pt) return;

    const beforeMx = (pt.sx - blueprintW * 0.5 - pan2dX) / zoom2d + blueprintW * 0.5;
    const beforeMy = (pt.sy - blueprintH * 0.5 - pan2dY) / zoom2d + blueprintH * 0.5;

    const factor = Math.exp(-e.deltaY * 0.0012);
    zoom2d = clamp(zoom2d * factor, 0.75, 3.2);
    pan2dX = pt.sx - blueprintW * 0.5 - (beforeMx - blueprintW * 0.5) * zoom2d;
    pan2dY = pt.sy - blueprintH * 0.5 - (beforeMy - blueprintH * 0.5) * zoom2d;
    clamp2dPan();
    syncRulerHud();
    redraw2DIfActive();
  };

  const onWindowMouseMove = (e: MouseEvent) => {
    if (!openState) return;

    if (activeTab === '3d' && drag3dMode) {
      const dx = e.clientX - lastPointerX;
      const dy = e.clientY - lastPointerY;
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;

      if (drag3dMode === 'orbit') {
        desiredTheta -= dx * 0.0065;
        desiredPhi = clamp(desiredPhi - dy * 0.0065, PHI_MIN, PHI_MAX);
        activePresetId = null;
        syncPresetButtons();
      } else {
        const panScale = desiredRadius * 0.00135;
        const rightX = Math.cos(desiredTheta);
        const rightZ = -Math.sin(desiredTheta);
        const fwdX = -Math.sin(desiredTheta);
        const fwdZ = -Math.cos(desiredTheta);

        desiredTarget.x = clamp(
          desiredTarget.x - rightX * dx * panScale - fwdX * dy * panScale,
          -44,
          44
        );
        desiredTarget.z = clamp(
          desiredTarget.z - rightZ * dx * panScale - fwdZ * dy * panScale,
          -48,
          48
        );
        activePresetId = null;
        syncPresetButtons();
      }
      return;
    }

    if (activeTab === '2d' && drag2dMode) {
      const pt = clientToLogical2d(e.clientX, e.clientY);
      if (!pt) return;

      if (drag2dMode === 'pan') {
        pan2dX += pt.sx - drag2dLastSx;
        pan2dY += pt.sy - drag2dLastSy;
        drag2dLastSx = pt.sx;
        drag2dLastSy = pt.sy;
        clamp2dPan();
        redraw2DIfActive();
      } else if (drag2dMode === 'ruler') {
        rulerEnd = logicalToWorld2d(pt.sx, pt.sy);
        recomputeRulerLoS();
        redraw2DIfActive();
      }
    }
  };

  const onWindowMouseUp = () => {
    if (drag2dMode === 'ruler' && rulerDistM < 0.25) {
      rulerActive = false;
      syncRulerHud();
      redraw2DIfActive();
    }
    drag3dMode = null;
    drag2dMode = null;
  };

  function setTab(tab: ViewerTab): void {
    activeTab = tab;
    if (tab === '3d') {
      lastRenderMs = performance.now();
    }
    syncTabUi();
    syncToggleUi();
    if (tab === '2d') {
      syncBlueprintBufferSize();
      syncRulerHud();
      redraw2DIfActive();
    }
  }

  const onTab3dClick = () => setTab('3d');

  const onTab2dClick = () => setTab('2d');

  const onCloseClick = () => close();

  const onBarriersClick = () => {
    showBarriers = !showBarriers;
    setArenaBuyBarriersVisible(showBarriers);
    syncToggleUi();
  };

  const onCalloutsClick = () => {
    showCallouts = !showCallouts;
    syncToggleUi();
  };

  const onDoorAClick = () => {
    toggleArenaDoor('a_tree');
    syncToggleUi();
  };

  const onDoorBClick = () => {
    toggleArenaDoor('b_market');
    syncToggleUi();
  };

  const on2dResetClick = () => {
    zoom2d = 1.0;
    pan2dX = 0;
    pan2dY = 0;
    rulerActive = false;
    syncRulerHud();
    redraw2DIfActive();
  };

  const on2dContextMenu = (e: MouseEvent) => e.preventDefault();
  const onOrbitContextMenu = (e: MouseEvent) => e.preventDefault();

  const presetHandlers: Array<{ btn: HTMLButtonElement; fn: () => void }> = [];
  for (const btn of presetBtns) {
    const fn = () => {
      const id = btn.dataset.mvPreset;
      if (id) applyPreset(id, false);
    };
    btn.addEventListener('click', fn);
    presetHandlers.push({ btn, fn });
  }

  window.addEventListener('resize', onWindowResize);
  window.addEventListener('mousemove', onWindowMouseMove);
  window.addEventListener('mouseup', onWindowMouseUp);

  orbitSurfaceEl?.addEventListener('mousedown', onOrbitMouseDown);
  orbitSurfaceEl?.addEventListener('wheel', onOrbitWheel, { passive: false });
  orbitSurfaceEl?.addEventListener('contextmenu', onOrbitContextMenu);

  canvas2d?.addEventListener('mousedown', on2dMouseDown);
  canvas2d?.addEventListener('wheel', on2dWheel, { passive: false });
  canvas2d?.addEventListener('contextmenu', on2dContextMenu);

  tab3dBtn?.addEventListener('click', onTab3dClick);
  tab2dBtn?.addEventListener('click', onTab2dClick);
  closeBtn?.addEventListener('click', onCloseClick);
  toggleBarriersBtn?.addEventListener('click', onBarriersClick);
  toggleCalloutsBtn?.addEventListener('click', onCalloutsClick);
  doorABtn?.addEventListener('click', onDoorAClick);
  doorBBtn?.addEventListener('click', onDoorBClick);
  reset2dBtn?.addEventListener('click', on2dResetClick);

  function open(): void {
    openState = true;
    setArenaBuyBarriersVisible(showBarriers);
    modalEl?.classList.remove('hidden');
    setTab('2d');
    syncPresetButtons();
  }

  function close(): void {
    if (!openState) return;
    openState = false;
    drag3dMode = null;
    drag2dMode = null;
    modalEl?.classList.add('hidden');
    syncBodyClasses();
    onCloseCallback?.();
  }

  function toggle(): boolean {
    if (openState) close();
    else open();
    return openState;
  }

  function dispose(): void {
    window.removeEventListener('resize', onWindowResize);
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onWindowMouseUp);

    orbitSurfaceEl?.removeEventListener('mousedown', onOrbitMouseDown);
    orbitSurfaceEl?.removeEventListener('wheel', onOrbitWheel);
    orbitSurfaceEl?.removeEventListener('contextmenu', onOrbitContextMenu);

    canvas2d?.removeEventListener('mousedown', on2dMouseDown);
    canvas2d?.removeEventListener('wheel', on2dWheel);
    canvas2d?.removeEventListener('contextmenu', on2dContextMenu);

    tab3dBtn?.removeEventListener('click', onTab3dClick);
    tab2dBtn?.removeEventListener('click', onTab2dClick);
    closeBtn?.removeEventListener('click', onCloseClick);
    toggleBarriersBtn?.removeEventListener('click', onBarriersClick);
    toggleCalloutsBtn?.removeEventListener('click', onCalloutsClick);
    doorABtn?.removeEventListener('click', onDoorAClick);
    doorBBtn?.removeEventListener('click', onDoorBClick);
    reset2dBtn?.removeEventListener('click', on2dResetClick);

    for (const item of presetHandlers) {
      item.btn.removeEventListener('click', item.fn);
    }
    syncBodyClasses();
  }

  applyPreset('overview', true);
  setTab('2d');

  return {
    isOpen: () => openState,
    open,
    close,
    toggle,
    setTab,
    is3DViewActive: () => openState && activeTab === '3d',
    render3D,
    update2D,
    setOnClose(cb: () => void): void {
      onCloseCallback = cb;
    },
    dispose,
  };
}
