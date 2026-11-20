import type { AbilityAudioEvent, AgentColorId, WeaponId } from '../core/types';

/**
 * Procedural zero-dependency Web Audio API synthesizer for Chroma Strike.
 *
 * Designed for warm, tactical clarity without listener fatigue:
 * - **Warm Master Conditioning**: All voices sum through a gentle `6.8 kHz`
 *   air-absorption lowpass, a `-3.5 dB` dip at `2.8 kHz` (harshness scoop),
 *   and a smooth dynamics compressor.
 * - **3-Pole Pink Noise**: Generated alongside white noise so gunfire, boots,
 *   and blade whooshes carry natural punch instead of fatiguing hiss.
 * - **Stereo Spatialization & Proximity**: World shots and footsteps within
 *   `24 m` are attenuated by distance, air-filtered, and stereo-panned
 *   around the listener's active camera orientation.
 */
export interface SoundEngine {
  unlock(): void;
  setMasterVolume(vol01: number): void;
  setMuted(muted: boolean): void;
  playShot(stimmed: boolean): void;
  playWeaponShot(weaponId: WeaponId, stimmed: boolean, distanceM?: number, pan?: number): void;
  playFootstep(distanceM: number, pan: number, isEnemy: boolean, isLocal?: boolean): void;
  playLandingThud(distanceM: number, pan: number, intensity01: number, isLocal?: boolean): void;
  playHeadshot(): void;
  playBodyHit(): void;
  playReload(): void;
  playLowAmmoClick(): void;
  playUiLockIn(): void;
  playAbility(event: AbilityAudioEvent): void;
  playUltimateActivate(colorId: AgentColorId): void;
  playBarrierDrop(): void;
  playRoundCue(cue: 'buy' | 'fight' | 'win' | 'lose'): void;
  playBuyPurchase(): void;
  playBuyError(): void;
  playSpikePickup(): void;
  playSpikePlantTick(): void;
  playSpikePlanted(): void;
  playSpikeBeep(urgency01: number): void;
  playSpikeDefuseCue(halfwayReached: boolean): void;
  playSpikeDefused(): void;
  playSpikeDetonate(): void;
  playDoorToggle(closing: boolean): void;
  playDoorHit(): void;
  playDoorBreak(): void;
}

const NOISE_BUFFER_DURATION_SEC = 1.0;
const GAIN_EPSILON = 0.0001;
const FOOTSTEP_HEAR_RADIUS_M = 24.0;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function buildPinkNoiseBuffer(context: AudioContext, sampleCount: number): AudioBuffer {
  const buf = context.createBuffer(1, sampleCount, context.sampleRate);
  const data = buf.getChannelData(0);
  // Paul Kellet 3-pole pink noise approximation normalized cleanly <= 0.9 peak.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let maxAbs = 1e-6;
  for (let i = 0; i < sampleCount; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    const sample = b0 + b1 + b2 + white * 0.1848;
    data[i] = sample;
    const abs = Math.abs(sample);
    if (abs > maxAbs) maxAbs = abs;
  }
  const scale = 0.9 / maxAbs;
  for (let i = 0; i < sampleCount; i++) {
    data[i] *= scale;
  }
  return buf;
}

/**
 * Creates the procedural Web Audio synthesizer with warm master EQ, smooth
 * compression, pink-noise foley, and stereo distance attenuation.
 */
export function createSoundEngine(): SoundEngine {
  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let pinkNoiseBuffer: AudioBuffer | null = null;
  let masterVolume = 0.85;
  let muted = false;
  let stepParity = 0;

  function applyMasterGain(): void {
    if (!ctx || !masterGain) return;
    masterGain.gain.setValueAtTime(muted ? 0 : masterVolume, ctx.currentTime);
  }

  function setMasterVolume(vol01: number): void {
    const safe = Number.isFinite(vol01) ? vol01 : 0.85;
    masterVolume = clamp(safe, 0, 1);
    applyMasterGain();
  }

  function setMuted(isMuted: boolean): void {
    muted = Boolean(isMuted);
    applyMasterGain();
  }

  function getAudioContextCtor(): (new () => AudioContext) | null {
    const win = window as Window & {
      webkitAudioContext?: new () => AudioContext;
    };
    return window.AudioContext ?? win.webkitAudioContext ?? null;
  }

  function ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;

    if (!ctx) {
      const Ctor = getAudioContextCtor();
      if (!Ctor) return null;

      ctx = new Ctor();
      const now = ctx.currentTime;

      const warmLowpass = ctx.createBiquadFilter();
      warmLowpass.type = 'lowpass';
      warmLowpass.frequency.setValueAtTime(6800, now);
      warmLowpass.Q.setValueAtTime(0.65, now);

      const presenceScoop = ctx.createBiquadFilter();
      presenceScoop.type = 'peaking';
      presenceScoop.frequency.setValueAtTime(2800, now);
      presenceScoop.Q.setValueAtTime(1.1, now);
      presenceScoop.gain.setValueAtTime(-3.5, now);

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-14, now);
      compressor.knee.setValueAtTime(14, now);
      compressor.ratio.setValueAtTime(4, now);
      compressor.attack.setValueAtTime(0.004, now);
      compressor.release.setValueAtTime(0.14, now);

      masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(muted ? 0 : masterVolume, now);

      masterGain.connect(warmLowpass);
      warmLowpass.connect(presenceScoop);
      presenceScoop.connect(compressor);
      compressor.connect(ctx.destination);

      const sampleCount = Math.floor(ctx.sampleRate * NOISE_BUFFER_DURATION_SEC);
      noiseBuffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < sampleCount; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      pinkNoiseBuffer = buildPinkNoiseBuffer(ctx, sampleCount);
    }

    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {
        // Ignore autoplay policy rejections until the next user gesture.
      });
    }

    return ctx;
  }

  function unlock(): void {
    ensureContext();
  }

  function getReadyNodes(): {
    context: AudioContext;
    out: GainNode;
    noise: AudioBuffer;
    pink: AudioBuffer;
  } | null {
    const context = ensureContext();
    if (!context || !masterGain || !noiseBuffer || !pinkNoiseBuffer) return null;
    if (context.state === 'suspended') return null;
    return { context, out: masterGain, noise: noiseBuffer, pink: pinkNoiseBuffer };
  }

  /**
   * Builds a stereo-panned, air-absorbed spatial output bus for world audio.
   * Returns `null` when attenuated below threshold so far events cost zero nodes.
   */
  function createSpatialOut(
    context: AudioContext,
    out: AudioNode,
    distanceM: number,
    pan = 0,
    maxDist = 48,
  ): { dest: AudioNode; atten: number } | null {
    const d = Math.max(0, distanceM);
    const atten =
      d <= 1 ? 1 : Math.max(0, (1 / (1 + 0.09 * d + 0.0022 * d * d)) * (1 - d / maxDist));
    if (atten < 0.015) return null;

    if (d <= 0.5 && Math.abs(pan) < 0.04) {
      return { dest: out, atten };
    }

    const now = context.currentTime;
    const airLp = context.createBiquadFilter();
    airLp.type = 'lowpass';
    airLp.frequency.setValueAtTime(Math.max(700, 6200 / (1 + 0.08 * d)), now);
    airLp.Q.setValueAtTime(0.6, now);

    if (typeof context.createStereoPanner === 'function') {
      const panner = context.createStereoPanner();
      panner.pan.setValueAtTime(clamp(pan, -0.92, 0.92), now);
      airLp.connect(panner);
      panner.connect(out);
    } else {
      airLp.connect(out);
    }

    return { dest: airLp, atten };
  }

  /**
   * Warm, low-fatigue weapon synthesis scaled by distance & stereo pan:
   * uses organic pink-noise transients and subtle ±4% per-shot pitch variation.
   */
  function playWeaponShot(
    weaponId: WeaponId,
    stimmed: boolean,
    distanceM = 0,
    pan = 0,
  ): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out, pink } = nodes;
    const spatial = createSpatialOut(context, out, distanceM, pan, 48);
    if (!spatial) return;

    const now = context.currentTime;
    const { dest, atten } = spatial;
    const jitter = 1 + (Math.random() - 0.5) * 0.08;
    const stimScale = stimmed ? 1.08 : 1.0;
    const safePeak = (v: number): number => Math.max(GAIN_EPSILON * 2, v * atten * stimScale);

    if (weaponId === 'pistol') {
      const bodyOsc = context.createOscillator();
      const bodyGain = context.createGain();
      bodyOsc.type = 'sine';
      bodyOsc.frequency.setValueAtTime(210 * jitter, now);
      bodyOsc.frequency.exponentialRampToValueAtTime(78 * jitter, now + 0.055);
      bodyGain.gain.setValueAtTime(safePeak(0.24), now);
      bodyGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.065);
      bodyOsc.connect(bodyGain);
      bodyGain.connect(dest);
      bodyOsc.start(now);
      bodyOsc.stop(now + 0.075);

      const crackSrc = context.createBufferSource();
      crackSrc.buffer = pink;
      const crackFilter = context.createBiquadFilter();
      crackFilter.type = 'bandpass';
      crackFilter.frequency.setValueAtTime(1650 * jitter, now);
      crackFilter.Q.setValueAtTime(0.85, now);
      const crackGain = context.createGain();
      crackGain.gain.setValueAtTime(safePeak(0.22), now);
      crackGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.042);
      crackSrc.connect(crackFilter);
      crackFilter.connect(crackGain);
      crackGain.connect(dest);
      crackSrc.start(now);
      crackSrc.stop(now + 0.05);
    } else if (weaponId === 'smg') {
      const bodyOsc = context.createOscillator();
      const bodyGain = context.createGain();
      bodyOsc.type = 'sine';
      bodyOsc.frequency.setValueAtTime(165 * jitter, now);
      bodyOsc.frequency.exponentialRampToValueAtTime(62 * jitter, now + 0.045);
      bodyGain.gain.setValueAtTime(safePeak(0.2), now);
      bodyGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.055);
      bodyOsc.connect(bodyGain);
      bodyGain.connect(dest);
      bodyOsc.start(now);
      bodyOsc.stop(now + 0.065);

      const crackSrc = context.createBufferSource();
      crackSrc.buffer = pink;
      const crackFilter = context.createBiquadFilter();
      crackFilter.type = 'bandpass';
      crackFilter.frequency.setValueAtTime(1100 * jitter, now);
      crackFilter.Q.setValueAtTime(0.95, now);
      const crackGain = context.createGain();
      crackGain.gain.setValueAtTime(safePeak(0.18), now);
      crackGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.036);
      crackSrc.connect(crackFilter);
      crackFilter.connect(crackGain);
      crackGain.connect(dest);
      crackSrc.start(now);
      crackSrc.stop(now + 0.045);
    } else if (weaponId === 'shotgun') {
      // Heavy low-end 12-gauge boom + broad warm pink blast + pump rack *chk-chk*
      const subOsc = context.createOscillator();
      const subGain = context.createGain();
      subOsc.type = 'sine';
      subOsc.frequency.setValueAtTime(108 * jitter, now);
      subOsc.frequency.exponentialRampToValueAtTime(34, now + 0.19);
      subGain.gain.setValueAtTime(safePeak(0.42), now);
      subGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.21);
      subOsc.connect(subGain);
      subGain.connect(dest);
      subOsc.start(now);
      subOsc.stop(now + 0.23);

      const blastSrc = context.createBufferSource();
      blastSrc.buffer = pink;
      const blastFilter = context.createBiquadFilter();
      blastFilter.type = 'lowpass';
      blastFilter.frequency.setValueAtTime(2600 * jitter, now);
      blastFilter.frequency.exponentialRampToValueAtTime(340, now + 0.22);
      const blastGain = context.createGain();
      blastGain.gain.setValueAtTime(safePeak(0.42), now);
      blastGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.22);
      blastSrc.connect(blastFilter);
      blastFilter.connect(blastGain);
      blastGain.connect(dest);
      blastSrc.start(now);
      blastSrc.stop(now + 0.24);

      const pumpClicks = [
        { delay: 0.26, freq: 1450, peak: 0.09 },
        { delay: 0.36, freq: 1950, peak: 0.11 },
      ];
      for (const click of pumpClicks) {
        const t0 = now + click.delay;
        const clickSrc = context.createBufferSource();
        clickSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(click.freq * jitter, t0);
        bp.Q.setValueAtTime(2.6, t0);
        const clickGain = context.createGain();
        clickGain.gain.setValueAtTime(safePeak(click.peak), t0);
        clickGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, t0 + 0.036);
        clickSrc.connect(bp);
        bp.connect(clickGain);
        clickGain.connect(dest);
        clickSrc.start(t0);
        clickSrc.stop(t0 + 0.045);
      }
    } else if (weaponId === 'sniper') {
      const subOsc = context.createOscillator();
      const subGain = context.createGain();
      subOsc.type = 'sine';
      subOsc.frequency.setValueAtTime(95 * jitter, now);
      subOsc.frequency.exponentialRampToValueAtTime(32, now + 0.24);
      subGain.gain.setValueAtTime(safePeak(0.38), now);
      subGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.26);
      subOsc.connect(subGain);
      subGain.connect(dest);
      subOsc.start(now);
      subOsc.stop(now + 0.28);

      const blastSrc = context.createBufferSource();
      blastSrc.buffer = pink;
      const blastFilter = context.createBiquadFilter();
      blastFilter.type = 'lowpass';
      blastFilter.frequency.setValueAtTime(2500 * jitter, now);
      blastFilter.frequency.exponentialRampToValueAtTime(380, now + 0.22);
      const blastGain = context.createGain();
      blastGain.gain.setValueAtTime(safePeak(0.36), now);
      blastGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.25);
      blastSrc.connect(blastFilter);
      blastFilter.connect(blastGain);
      blastGain.connect(dest);
      blastSrc.start(now);
      blastSrc.stop(now + 0.27);

      const boltClicks = [
        { delay: 0.3, freq: 1600, peak: 0.08 },
        { delay: 0.39, freq: 2150, peak: 0.1 },
      ];
      for (const click of boltClicks) {
        const t0 = now + click.delay;
        const boltSrc = context.createBufferSource();
        boltSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(click.freq * jitter, t0);
        bp.Q.setValueAtTime(2.8, t0);
        const boltGain = context.createGain();
        boltGain.gain.setValueAtTime(safePeak(click.peak), t0);
        boltGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, t0 + 0.032);
        boltSrc.connect(bp);
        bp.connect(boltGain);
        boltGain.connect(dest);
        boltSrc.start(t0);
        boltSrc.stop(t0 + 0.04);
      }
    } else if (weaponId === 'knife') {
      const slashSrc = context.createBufferSource();
      slashSrc.buffer = pink;
      const slashFilter = context.createBiquadFilter();
      slashFilter.type = 'bandpass';
      slashFilter.frequency.setValueAtTime(1800 * jitter, now);
      slashFilter.frequency.exponentialRampToValueAtTime(480, now + 0.14);
      slashFilter.Q.setValueAtTime(1.5, now);
      const slashGain = context.createGain();
      slashGain.gain.setValueAtTime(GAIN_EPSILON, now);
      slashGain.gain.exponentialRampToValueAtTime(safePeak(0.24), now + 0.014);
      slashGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.15);
      slashSrc.connect(slashFilter);
      slashFilter.connect(slashGain);
      slashGain.connect(dest);
      slashSrc.start(now);
      slashSrc.stop(now + 0.16);

      const glintOsc = context.createOscillator();
      const glintGain = context.createGain();
      glintOsc.type = 'sine';
      glintOsc.frequency.setValueAtTime(1600 * jitter, now);
      glintOsc.frequency.exponentialRampToValueAtTime(920, now + 0.075);
      glintGain.gain.setValueAtTime(safePeak(0.06), now);
      glintGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.08);
      glintOsc.connect(glintGain);
      glintGain.connect(dest);
      glintOsc.start(now);
      glintOsc.stop(now + 0.09);
    } else {
      // 'ar' (Pulse Rifle): warm low-mid membrane punch + shaped pink crack
      const bodyOsc = context.createOscillator();
      const bodyGain = context.createGain();
      bodyOsc.type = 'triangle';
      bodyOsc.frequency.setValueAtTime(135 * jitter, now);
      bodyOsc.frequency.exponentialRampToValueAtTime(48 * jitter, now + 0.065);
      bodyGain.gain.setValueAtTime(safePeak(0.28), now);
      bodyGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.08);
      bodyOsc.connect(bodyGain);
      bodyGain.connect(dest);
      bodyOsc.start(now);
      bodyOsc.stop(now + 0.09);

      const crackSrc = context.createBufferSource();
      crackSrc.buffer = pink;
      const crackFilter = context.createBiquadFilter();
      crackFilter.type = 'bandpass';
      crackFilter.frequency.setValueAtTime(1100 * jitter, now);
      crackFilter.Q.setValueAtTime(0.85, now);
      const crackGain = context.createGain();
      crackGain.gain.setValueAtTime(safePeak(0.3), now);
      crackGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.048);
      crackSrc.connect(crackFilter);
      crackFilter.connect(crackGain);
      crackGain.connect(dest);
      crackSrc.start(now);
      crackSrc.stop(now + 0.06);
    }
  }

  /** Backward-compatible default rifle shot wrapper (`playWeaponShot('ar', stimmed)`). */
  function playShot(stimmed: boolean): void {
    playWeaponShot('ar', stimmed, 0, 0);
  }

  /**
   * Tactile running footstep within `24 m` (silent when walking `[Shift]` or crouching).
   * Enemy boots use a slightly crisper upper-mid sole tap for combat legibility.
   */
  function playFootstep(
    distanceM: number,
    pan: number,
    isEnemy: boolean,
    isLocal = false,
  ): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    if (!isLocal && distanceM >= FOOTSTEP_HEAR_RADIUS_M) return;

    const { context, out, pink } = nodes;
    const now = context.currentTime;
    const d = Math.max(0, distanceM);
    const prox = isLocal ? 1 : Math.max(0, 1 - d / FOOTSTEP_HEAR_RADIUS_M);
    const gainScale = isLocal ? 0.13 : prox * prox * (isEnemy ? 0.34 : 0.2);
    if (gainScale < 0.008) return;

    stepParity = (stepParity + 1) & 1;
    const parityMult = stepParity === 0 ? 0.95 : 1.05;
    const pitchMod = parityMult * (1 + (Math.random() - 0.5) * 0.06);

    const airLp = context.createBiquadFilter();
    airLp.type = 'lowpass';
    airLp.frequency.setValueAtTime(Math.max(600, 3600 / (1 + 0.1 * d)), now);
    airLp.Q.setValueAtTime(0.7, now);

    if (!isLocal && typeof context.createStereoPanner === 'function') {
      const panner = context.createStereoPanner();
      panner.pan.setValueAtTime(clamp(pan, -0.92, 0.92), now);
      airLp.connect(panner);
      panner.connect(out);
    } else {
      airLp.connect(out);
    }

    const thumpOsc = context.createOscillator();
    const thumpGain = context.createGain();
    thumpOsc.type = 'sine';
    thumpOsc.frequency.setValueAtTime(86 * pitchMod, now);
    thumpOsc.frequency.exponentialRampToValueAtTime(42 * pitchMod, now + 0.036);
    thumpGain.gain.setValueAtTime(gainScale * 0.72, now);
    thumpGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.042);
    thumpOsc.connect(thumpGain);
    thumpGain.connect(airLp);
    thumpOsc.start(now);
    thumpOsc.stop(now + 0.05);

    const scuffSrc = context.createBufferSource();
    scuffSrc.buffer = pink;
    const bp = context.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime((isEnemy && !isLocal ? 1200 : 850) * pitchMod, now);
    bp.Q.setValueAtTime(1.4, now);
    const scuffGain = context.createGain();
    scuffGain.gain.setValueAtTime(gainScale * 0.55, now);
    scuffGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.028);
    scuffSrc.connect(bp);
    bp.connect(scuffGain);
    scuffGain.connect(airLp);
    scuffSrc.start(now);
    scuffSrc.stop(now + 0.036);
  }

  /**
   * Low-end boot touchdown thud on hard vertical landings (local + within `24 m`).
   */
  function playLandingThud(
    distanceM: number,
    pan: number,
    intensity01: number,
    isLocal = false,
  ): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    if (!isLocal && distanceM >= FOOTSTEP_HEAR_RADIUS_M) return;

    const { context, out, pink } = nodes;
    const now = context.currentTime;
    const d = Math.max(0, distanceM);
    const prox = isLocal ? 1 : Math.max(0, 1 - d / FOOTSTEP_HEAR_RADIUS_M);
    const strength = clamp(intensity01, 0.25, 1);
    const baseGain = (isLocal ? 0.2 : prox * prox * 0.42) * strength;
    if (baseGain < 0.01) return;

    const airLp = context.createBiquadFilter();
    airLp.type = 'lowpass';
    airLp.frequency.setValueAtTime(Math.max(520, 2600 / (1 + 0.1 * d)), now);
    if (!isLocal && typeof context.createStereoPanner === 'function') {
      const panner = context.createStereoPanner();
      panner.pan.setValueAtTime(clamp(pan, -0.92, 0.92), now);
      airLp.connect(panner);
      panner.connect(out);
    } else {
      airLp.connect(out);
    }

    const subOsc = context.createOscillator();
    const subGain = context.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(78, now);
    subOsc.frequency.exponentialRampToValueAtTime(34, now + 0.085);
    subGain.gain.setValueAtTime(baseGain * 0.85, now);
    subGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.095);
    subOsc.connect(subGain);
    subGain.connect(airLp);
    subOsc.start(now);
    subOsc.stop(now + 0.11);

    const thudSrc = context.createBufferSource();
    thudSrc.buffer = pink;
    const lp = context.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(520, now);
    const thudGain = context.createGain();
    thudGain.gain.setValueAtTime(baseGain * 0.5, now);
    thudGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.075);
    thudSrc.connect(lp);
    lp.connect(thudGain);
    thudGain.connect(airLp);
    thudSrc.start(now);
    thudSrc.stop(now + 0.085);
  }

  /** Warm muted helmet crunch + short bell overtone on headshots. */
  function playHeadshot(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out, pink } = nodes;
    const now = context.currentTime;

    const partials: Array<{ freq: number; peak: number; dur: number }> = [
      { freq: 920, peak: 0.18, dur: 0.11 },
      { freq: 1480, peak: 0.11, dur: 0.095 },
    ];
    for (const p of partials) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(p.freq, now);
      gain.gain.setValueAtTime(p.peak, now);
      gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + p.dur);
      osc.connect(gain);
      gain.connect(out);
      osc.start(now);
      osc.stop(now + p.dur + 0.015);
    }

    const crunchSrc = context.createBufferSource();
    crunchSrc.buffer = pink;
    const bp = context.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1600, now);
    bp.Q.setValueAtTime(1.4, now);
    const crunchGain = context.createGain();
    crunchGain.gain.setValueAtTime(0.14, now);
    crunchGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.045);
    crunchSrc.connect(bp);
    bp.connect(crunchGain);
    crunchGain.connect(out);
    crunchSrc.start(now);
    crunchSrc.stop(now + 0.055);
  }

  /** Subtle dull body impact thud (`145 -> 72 Hz`). */
  function playBodyHit(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(145, now);
    osc.frequency.exponentialRampToValueAtTime(72, now + 0.05);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.055);

    osc.connect(gain);
    gain.connect(out);
    osc.start(now);
    osc.stop(now + 0.065);
  }

  /** Soft mechanical two-click magazine release + bolt latch transient. */
  function playReload(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out, pink } = nodes;
    const now = context.currentTime;

    const clicks = [
      { offset: 0, centerHz: 1850, gainPeak: 0.1 },
      { offset: 0.14, centerHz: 2400, gainPeak: 0.12 },
    ];

    for (const click of clicks) {
      const t0 = now + click.offset;
      const src = context.createBufferSource();
      src.buffer = pink;

      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(click.centerHz, t0);
      filter.Q.setValueAtTime(2.6, t0);

      const gain = context.createGain();
      gain.gain.setValueAtTime(click.gainPeak, t0);
      gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, t0 + 0.028);

      src.connect(filter);
      filter.connect(gain);
      gain.connect(out);
      src.start(t0);
      src.stop(t0 + 0.035);
    }
  }

  /** Soft muted bolt tick signaling low remaining ammunition. */
  function playLowAmmoClick(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out, pink } = nodes;
    const now = context.currentTime;

    const clickSrc = context.createBufferSource();
    clickSrc.buffer = pink;
    const bp = context.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2200, now);
    bp.Q.setValueAtTime(3.2, now);
    const clickGain = context.createGain();
    clickGain.gain.setValueAtTime(0.06, now);
    clickGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.02);
    clickSrc.connect(bp);
    bp.connect(clickGain);
    clickGain.connect(out);
    clickSrc.start(now);
    clickSrc.stop(now + 0.028);
  }

  /** Subtle warm two-voice lock-in confirmation chord. */
  function playUiLockIn(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const voices: Array<{ fStart: number; fEnd: number; delay: number; dur: number; peak: number }> = [
      { fStart: 440, fEnd: 523.25, delay: 0, dur: 0.16, peak: 0.11 },
      { fStart: 659.25, fEnd: 783.99, delay: 0.045, dur: 0.2, peak: 0.11 },
    ];

    for (const v of voices) {
      const t0 = now + v.delay;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(v.fStart, t0);
      osc.frequency.exponentialRampToValueAtTime(v.fEnd, t0 + 0.05);
      gain.gain.setValueAtTime(0.004, t0);
      gain.gain.linearRampToValueAtTime(v.peak, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, t0 + v.dur);
      osc.connect(gain);
      gain.connect(out);
      osc.start(t0);
      osc.stop(t0 + v.dur + 0.02);
    }
  }

  function playAbility(event: AbilityAudioEvent): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out, pink } = nodes;
    const now = context.currentTime;

    switch (event) {
      case 'dash': {
        const src = context.createBufferSource();
        src.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(1.5, now);
        bp.frequency.setValueAtTime(280, now);
        bp.frequency.exponentialRampToValueAtTime(1450, now + 0.08);
        bp.frequency.exponentialRampToValueAtTime(360, now + 0.22);
        const gain = context.createGain();
        gain.gain.setValueAtTime(0.015, now);
        gain.gain.linearRampToValueAtTime(0.26, now + 0.04);
        gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.22);
        src.connect(bp);
        bp.connect(gain);
        gain.connect(out);
        src.start(now);
        src.stop(now + 0.24);
        break;
      }

      case 'throw': {
        const src = context.createBufferSource();
        src.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(1.8, now);
        bp.frequency.setValueAtTime(260, now);
        bp.frequency.exponentialRampToValueAtTime(520, now + 0.08);
        const gain = context.createGain();
        gain.gain.setValueAtTime(0.16, now);
        gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.08);
        src.connect(bp);
        bp.connect(gain);
        gain.connect(out);
        src.start(now);
        src.stop(now + 0.09);
        break;
      }

      case 'fire_ignite': {
        const thumpOsc = context.createOscillator();
        const thumpGain = context.createGain();
        thumpOsc.type = 'sine';
        thumpOsc.frequency.setValueAtTime(95, now);
        thumpOsc.frequency.exponentialRampToValueAtTime(42, now + 0.22);
        thumpGain.gain.setValueAtTime(0.25, now);
        thumpGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.24);
        thumpOsc.connect(thumpGain);
        thumpGain.connect(out);
        thumpOsc.start(now);
        thumpOsc.stop(now + 0.26);

        const crackleSrc = context.createBufferSource();
        crackleSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(1.3, now);
        bp.frequency.setValueAtTime(1150, now);
        bp.frequency.exponentialRampToValueAtTime(580, now + 0.32);
        const crackleGain = context.createGain();
        crackleGain.gain.setValueAtTime(0.2, now);
        crackleGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.34);
        crackleSrc.connect(bp);
        bp.connect(crackleGain);
        crackleGain.connect(out);
        crackleSrc.start(now);
        crackleSrc.stop(now + 0.36);
        break;
      }

      case 'smoke_bloom': {
        const subOsc = context.createOscillator();
        const subGain = context.createGain();
        subOsc.type = 'sine';
        subOsc.frequency.setValueAtTime(125, now);
        subOsc.frequency.exponentialRampToValueAtTime(50, now + 0.38);
        subGain.gain.setValueAtTime(0.26, now);
        subGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.4);
        subOsc.connect(subGain);
        subGain.connect(out);
        subOsc.start(now);
        subOsc.stop(now + 0.42);

        const airSrc = context.createBufferSource();
        airSrc.buffer = pink;
        const lp = context.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(1000, now);
        lp.frequency.exponentialRampToValueAtTime(360, now + 0.38);
        const airGain = context.createGain();
        airGain.gain.setValueAtTime(0.015, now);
        airGain.gain.linearRampToValueAtTime(0.15, now + 0.08);
        airGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.38);
        airSrc.connect(lp);
        lp.connect(airGain);
        airGain.connect(out);
        airSrc.start(now);
        airSrc.stop(now + 0.4);
        break;
      }

      case 'slow_shatter': {
        const chimes = [980, 1280, 1620];
        for (let i = 0; i < chimes.length; i++) {
          const osc = context.createOscillator();
          const gain = context.createGain();
          const t0 = now + i * 0.014;
          osc.type = 'sine';
          osc.frequency.setValueAtTime(chimes[i], t0);
          gain.gain.setValueAtTime(0.11, t0);
          gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.24);
          osc.connect(gain);
          gain.connect(out);
          osc.start(t0);
          osc.stop(now + 0.26);
        }

        const iceSrc = context.createBufferSource();
        iceSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1900, now);
        bp.Q.setValueAtTime(1.5, now);
        const iceGain = context.createGain();
        iceGain.gain.setValueAtTime(0.15, now);
        iceGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.13);
        iceSrc.connect(bp);
        bp.connect(iceGain);
        iceGain.connect(out);
        iceSrc.start(now);
        iceSrc.stop(now + 0.15);
        break;
      }

      case 'flash_warn': {
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(740, now);
        osc.frequency.exponentialRampToValueAtTime(1480, now + 0.16);
        gain.gain.setValueAtTime(0.01, now);
        gain.gain.linearRampToValueAtTime(0.12, now + 0.1);
        gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.16);
        osc.connect(gain);
        gain.connect(out);
        osc.start(now);
        osc.stop(now + 0.18);
        break;
      }

      case 'flash_pop': {
        const snapSrc = context.createBufferSource();
        snapSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1400, now);
        bp.Q.setValueAtTime(1.2, now);
        const snapGain = context.createGain();
        snapGain.gain.setValueAtTime(0.24, now);
        snapGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.065);
        snapSrc.connect(bp);
        bp.connect(snapGain);
        snapGain.connect(out);
        snapSrc.start(now);
        snapSrc.stop(now + 0.075);

        // Warm muffled thump instead of piercing 2800 Hz tinnitus tone.
        const ringOsc = context.createOscillator();
        const ringGain = context.createGain();
        ringOsc.type = 'sine';
        ringOsc.frequency.setValueAtTime(680, now);
        ringOsc.frequency.exponentialRampToValueAtTime(220, now + 0.22);
        ringGain.gain.setValueAtTime(0.08, now);
        ringGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.24);
        ringOsc.connect(ringGain);
        ringGain.connect(out);
        ringOsc.start(now);
        ringOsc.stop(now + 0.26);
        break;
      }

      case 'beacon_deploy': {
        const notes = [
          { freq: 440, delay: 0 },
          { freq: 660, delay: 0.06 },
        ];
        for (const n of notes) {
          const t0 = now + n.delay;
          const osc = context.createOscillator();
          const gain = context.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(n.freq, t0);
          gain.gain.setValueAtTime(0.12, t0);
          gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.24);
          osc.connect(gain);
          gain.connect(out);
          osc.start(t0);
          osc.stop(now + 0.26);
        }
        break;
      }

      case 'void_cast': {
        const phaseOsc = context.createOscillator();
        const phaseGain = context.createGain();
        phaseOsc.type = 'sine';
        phaseOsc.frequency.setValueAtTime(380, now);
        phaseOsc.frequency.exponentialRampToValueAtTime(135, now + 0.22);
        phaseGain.gain.setValueAtTime(0.008, now);
        phaseGain.gain.linearRampToValueAtTime(0.16, now + 0.03);
        phaseGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.23);
        phaseOsc.connect(phaseGain);
        phaseGain.connect(out);
        phaseOsc.start(now);
        phaseOsc.stop(now + 0.25);

        const whooshSrc = context.createBufferSource();
        whooshSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(2.4, now);
        bp.frequency.setValueAtTime(840, now);
        bp.frequency.exponentialRampToValueAtTime(260, now + 0.2);
        const whooshGain = context.createGain();
        whooshGain.gain.setValueAtTime(0.13, now);
        whooshGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.21);
        whooshSrc.connect(bp);
        bp.connect(whooshGain);
        whooshGain.connect(out);
        whooshSrc.start(now);
        whooshSrc.stop(now + 0.23);
        break;
      }

      case 'void_bloom': {
        const subOsc = context.createOscillator();
        const subGain = context.createGain();
        subOsc.type = 'sine';
        subOsc.frequency.setValueAtTime(145, now);
        subOsc.frequency.exponentialRampToValueAtTime(44, now + 0.42);
        subGain.gain.setValueAtTime(0.24, now);
        subGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.44);
        subOsc.connect(subGain);
        subGain.connect(out);
        subOsc.start(now);
        subOsc.stop(now + 0.46);

        for (const freq of [311.13, 466.16]) {
          const chimeOsc = context.createOscillator();
          const chimeGain = context.createGain();
          chimeOsc.type = 'sine';
          chimeOsc.frequency.setValueAtTime(freq, now);
          chimeOsc.frequency.exponentialRampToValueAtTime(freq * 0.94, now + 0.36);
          chimeGain.gain.setValueAtTime(0.008, now);
          chimeGain.gain.linearRampToValueAtTime(0.08, now + 0.05);
          chimeGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.38);
          chimeOsc.connect(chimeGain);
          chimeGain.connect(out);
          chimeOsc.start(now);
          chimeOsc.stop(now + 0.4);
        }
        break;
      }

      case 'vortex_pull': {
        const vacSrc = context.createBufferSource();
        vacSrc.buffer = pink;
        const lp = context.createBiquadFilter();
        lp.type = 'bandpass';
        lp.Q.setValueAtTime(2.0, now);
        lp.frequency.setValueAtTime(180, now);
        lp.frequency.exponentialRampToValueAtTime(860, now + 0.25);
        lp.frequency.exponentialRampToValueAtTime(120, now + 0.42);
        const vacGain = context.createGain();
        vacGain.gain.setValueAtTime(0.015, now);
        vacGain.gain.linearRampToValueAtTime(0.2, now + 0.2);
        vacGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.42);
        vacSrc.connect(lp);
        lp.connect(vacGain);
        vacGain.connect(out);
        vacSrc.start(now);
        vacSrc.stop(now + 0.44);

        const gravOsc = context.createOscillator();
        const gravGain = context.createGain();
        gravOsc.type = 'triangle';
        gravOsc.frequency.setValueAtTime(108, now);
        gravOsc.frequency.exponentialRampToValueAtTime(46, now + 0.38);
        gravGain.gain.setValueAtTime(0.16, now);
        gravGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.4);
        gravOsc.connect(gravGain);
        gravGain.connect(out);
        gravOsc.start(now);
        gravOsc.stop(now + 0.42);
        break;
      }

      case 'overdrive_on': {
        const surgeOsc = context.createOscillator();
        const surgeGain = context.createGain();
        surgeOsc.type = 'triangle';
        surgeOsc.frequency.setValueAtTime(240, now);
        surgeOsc.frequency.exponentialRampToValueAtTime(680, now + 0.16);
        surgeGain.gain.setValueAtTime(0.008, now);
        surgeGain.gain.linearRampToValueAtTime(0.14, now + 0.04);
        surgeGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.22);
        surgeOsc.connect(surgeGain);
        surgeGain.connect(out);
        surgeOsc.start(now);
        surgeOsc.stop(now + 0.24);

        const sparkSrc = context.createBufferSource();
        sparkSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1800, now);
        const sparkGain = context.createGain();
        sparkGain.gain.setValueAtTime(0.13, now);
        sparkGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.12);
        sparkSrc.connect(bp);
        bp.connect(sparkGain);
        sparkGain.connect(out);
        sparkSrc.start(now);
        sparkSrc.stop(now + 0.14);
        break;
      }

      case 'power_slide': {
        const skidSrc = context.createBufferSource();
        skidSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(1.4, now);
        bp.frequency.setValueAtTime(1450, now);
        bp.frequency.exponentialRampToValueAtTime(440, now + 0.3);
        const skidGain = context.createGain();
        skidGain.gain.setValueAtTime(0.015, now);
        skidGain.gain.linearRampToValueAtTime(0.22, now + 0.03);
        skidGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.32);
        skidSrc.connect(bp);
        bp.connect(skidGain);
        skidGain.connect(out);
        skidSrc.start(now);
        skidSrc.stop(now + 0.34);

        const coilOsc = context.createOscillator();
        const coilGain = context.createGain();
        coilOsc.type = 'sine';
        coilOsc.frequency.setValueAtTime(520, now);
        coilOsc.frequency.exponentialRampToValueAtTime(180, now + 0.26);
        coilGain.gain.setValueAtTime(0.1, now);
        coilGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.28);
        coilOsc.connect(coilGain);
        coilGain.connect(out);
        coilOsc.start(now);
        coilOsc.stop(now + 0.3);
        break;
      }

      case 'relay_bounce': {
        const chirpOsc = context.createOscillator();
        const chirpGain = context.createGain();
        chirpOsc.type = 'sine';
        chirpOsc.frequency.setValueAtTime(980, now);
        chirpOsc.frequency.exponentialRampToValueAtTime(1650, now + 0.055);
        chirpGain.gain.setValueAtTime(0.12, now);
        chirpGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.085);
        chirpOsc.connect(chirpGain);
        chirpGain.connect(out);
        chirpOsc.start(now);
        chirpOsc.stop(now + 0.095);
        break;
      }

      case 'relay_zap': {
        const arcSrc = context.createBufferSource();
        arcSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1450, now);
        const arcGain = context.createGain();
        arcGain.gain.setValueAtTime(0.22, now);
        arcGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.15);
        arcSrc.connect(bp);
        bp.connect(arcGain);
        arcGain.connect(out);
        arcSrc.start(now);
        arcSrc.stop(now + 0.17);

        const zapOsc = context.createOscillator();
        const zapGain = context.createGain();
        zapOsc.type = 'triangle';
        zapOsc.frequency.setValueAtTime(420, now);
        zapOsc.frequency.exponentialRampToValueAtTime(92, now + 0.2);
        zapGain.gain.setValueAtTime(0.18, now);
        zapGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.22);
        zapOsc.connect(zapGain);
        zapGain.connect(out);
        zapOsc.start(now);
        zapOsc.stop(now + 0.24);
        break;
      }

      case 'ult_blaze': {
        const roarSrc = context.createBufferSource();
        roarSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(1.1, now);
        bp.frequency.setValueAtTime(300, now);
        bp.frequency.exponentialRampToValueAtTime(1350, now + 0.16);
        bp.frequency.exponentialRampToValueAtTime(420, now + 0.48);
        const roarGain = context.createGain();
        roarGain.gain.setValueAtTime(0.015, now);
        roarGain.gain.linearRampToValueAtTime(0.24, now + 0.08);
        roarGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.5);
        roarSrc.connect(bp);
        bp.connect(roarGain);
        roarGain.connect(out);
        roarSrc.start(now);
        roarSrc.stop(now + 0.52);

        for (const freq of [110, 164.81, 220]) {
          const osc = context.createOscillator();
          const gain = context.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq * 0.9, now);
          osc.frequency.exponentialRampToValueAtTime(freq * 1.1, now + 0.38);
          gain.gain.setValueAtTime(0.005, now);
          gain.gain.linearRampToValueAtTime(0.09, now + 0.05);
          gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.44);
          osc.connect(gain);
          gain.connect(out);
          osc.start(now);
          osc.stop(now + 0.46);
        }
        break;
      }

      case 'ult_mist': {
        const windSrc = context.createBufferSource();
        windSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(1.6, now);
        bp.frequency.setValueAtTime(1750, now);
        bp.frequency.exponentialRampToValueAtTime(520, now + 0.55);
        const windGain = context.createGain();
        windGain.gain.setValueAtTime(0.015, now);
        windGain.gain.linearRampToValueAtTime(0.2, now + 0.1);
        windGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.56);
        windSrc.connect(bp);
        bp.connect(windGain);
        windGain.connect(out);
        windSrc.start(now);
        windSrc.stop(now + 0.58);

        const frostFreqs = [880, 1174.66, 1480];
        frostFreqs.forEach((freq, idx) => {
          const t0 = now + idx * 0.03;
          const osc = context.createOscillator();
          const gain = context.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, t0);
          gain.gain.setValueAtTime(0.005, t0);
          gain.gain.linearRampToValueAtTime(0.08, t0 + 0.02);
          gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, t0 + 0.4);
          osc.connect(gain);
          gain.connect(out);
          osc.start(t0);
          osc.stop(t0 + 0.42);
        });
        break;
      }

      case 'ult_pulse': {
        const pings = [
          { delay: 0, freq: 740, peak: 0.14 },
          { delay: 0.14, freq: 1108.73, peak: 0.11 },
        ];
        for (const p of pings) {
          const t0 = now + p.delay;
          const osc = context.createOscillator();
          const gain = context.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(p.freq, t0);
          osc.frequency.exponentialRampToValueAtTime(p.freq * 1.03, t0 + 0.3);
          gain.gain.setValueAtTime(0.005, t0);
          gain.gain.linearRampToValueAtTime(p.peak, t0 + 0.015);
          gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, t0 + 0.4);
          osc.connect(gain);
          gain.connect(out);
          osc.start(t0);
          osc.stop(t0 + 0.42);
        }
        break;
      }

      case 'ult_umbra': {
        const subOsc = context.createOscillator();
        const subGain = context.createGain();
        subOsc.type = 'sine';
        subOsc.frequency.setValueAtTime(135, now);
        subOsc.frequency.exponentialRampToValueAtTime(38, now + 0.55);
        subGain.gain.setValueAtTime(0.28, now);
        subGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.58);
        subOsc.connect(subGain);
        subGain.connect(out);
        subOsc.start(now);
        subOsc.stop(now + 0.6);

        const sliceSrc = context.createBufferSource();
        sliceSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(2.6, now);
        bp.frequency.setValueAtTime(1300, now);
        bp.frequency.exponentialRampToValueAtTime(180, now + 0.45);
        const sliceGain = context.createGain();
        sliceGain.gain.setValueAtTime(0.18, now);
        sliceGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.46);
        sliceSrc.connect(bp);
        bp.connect(sliceGain);
        sliceGain.connect(out);
        sliceSrc.start(now);
        sliceSrc.stop(now + 0.48);
        break;
      }

      case 'ult_volt': {
        const thunderOsc = context.createOscillator();
        const thunderGain = context.createGain();
        thunderOsc.type = 'triangle';
        thunderOsc.frequency.setValueAtTime(110, now);
        thunderOsc.frequency.exponentialRampToValueAtTime(34, now + 0.42);
        thunderGain.gain.setValueAtTime(0.25, now);
        thunderGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.45);
        thunderOsc.connect(thunderGain);
        thunderGain.connect(out);
        thunderOsc.start(now);
        thunderOsc.stop(now + 0.47);

        const arcSrc = context.createBufferSource();
        arcSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1450, now);
        const arcGain = context.createGain();
        arcGain.gain.setValueAtTime(0.24, now);
        arcGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.25);
        arcSrc.connect(bp);
        bp.connect(arcGain);
        arcGain.connect(out);
        arcSrc.start(now);
        arcSrc.stop(now + 0.27);

        const surgeOsc = context.createOscillator();
        const surgeGain = context.createGain();
        surgeOsc.type = 'sine';
        surgeOsc.frequency.setValueAtTime(330, now);
        surgeOsc.frequency.exponentialRampToValueAtTime(980, now + 0.22);
        surgeGain.gain.setValueAtTime(0.01, now);
        surgeGain.gain.linearRampToValueAtTime(0.12, now + 0.04);
        surgeGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.28);
        surgeOsc.connect(surgeGain);
        surgeGain.connect(out);
        surgeOsc.start(now);
        surgeOsc.stop(now + 0.3);
        break;
      }

      case 'wind_updraft': {
        const upSrc = context.createBufferSource();
        upSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(2.2, now);
        bp.frequency.setValueAtTime(380, now);
        bp.frequency.exponentialRampToValueAtTime(1900, now + 0.22);
        const upGain = context.createGain();
        upGain.gain.setValueAtTime(0.24, now);
        upGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.26);
        upSrc.connect(bp);
        bp.connect(upGain);
        upGain.connect(out);
        upSrc.start(now);
        upSrc.stop(now + 0.28);

        const liftOsc = context.createOscillator();
        const liftGain = context.createGain();
        liftOsc.type = 'sine';
        liftOsc.frequency.setValueAtTime(290, now);
        liftOsc.frequency.exponentialRampToValueAtTime(780, now + 0.18);
        liftGain.gain.setValueAtTime(0.11, now);
        liftGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.22);
        liftOsc.connect(liftGain);
        liftGain.connect(out);
        liftOsc.start(now);
        liftOsc.stop(now + 0.24);
        break;
      }

      case 'wind_dash': {
        const galeSrc = context.createBufferSource();
        galeSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(1.6, now);
        bp.frequency.setValueAtTime(1950, now);
        bp.frequency.exponentialRampToValueAtTime(440, now + 0.22);
        const galeGain = context.createGain();
        galeGain.gain.setValueAtTime(0.26, now);
        galeGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.24);
        galeSrc.connect(bp);
        bp.connect(galeGain);
        galeGain.connect(out);
        galeSrc.start(now);
        galeSrc.stop(now + 0.26);
        break;
      }

      case 'ult_windy': {
        const bladeNotes = [740, 987.77, 1318.51];
        bladeNotes.forEach((freq, idx) => {
          const osc = context.createOscillator();
          const gain = context.createGain();
          osc.type = 'sine';
          const t0 = now + idx * 0.045;
          osc.frequency.setValueAtTime(freq, t0);
          osc.frequency.exponentialRampToValueAtTime(freq * 1.1, t0 + 0.16);
          gain.gain.setValueAtTime(0.1, t0);
          gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, t0 + 0.24);
          osc.connect(gain);
          gain.connect(out);
          osc.start(t0);
          osc.stop(t0 + 0.26);
        });
        const galeSrc = context.createBufferSource();
        galeSrc.buffer = pink;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(1.3, now);
        bp.frequency.setValueAtTime(520, now);
        bp.frequency.exponentialRampToValueAtTime(1850, now + 0.3);
        const gGain = context.createGain();
        gGain.gain.setValueAtTime(0.2, now);
        gGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.34);
        galeSrc.connect(bp);
        bp.connect(gGain);
        gGain.connect(out);
        galeSrc.start(now);
        galeSrc.stop(now + 0.36);
        break;
      }
    }
  }

  /** Warm brass & sub-bass ultimate activation sting tuned to each agent archetype. */
  function playUltimateActivate(colorId: AgentColorId): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const archetypeConfigs: Record<
      AgentColorId,
      { subStart: number; subEnd: number; chord: number[]; filterStart: number; filterPeak: number }
    > = {
      red: { subStart: 120, subEnd: 38, chord: [110, 164.81, 220], filterStart: 380, filterPeak: 1800 },
      blue: { subStart: 135, subEnd: 44, chord: [130.81, 196.0, 293.66], filterStart: 480, filterPeak: 2100 },
      green: { subStart: 125, subEnd: 42, chord: [146.83, 220.0, 293.66], filterStart: 420, filterPeak: 1900 },
      violet: { subStart: 110, subEnd: 34, chord: [98.0, 138.59, 196.0], filterStart: 320, filterPeak: 1500 },
      gold: { subStart: 140, subEnd: 45, chord: [164.81, 246.94, 369.99], filterStart: 540, filterPeak: 2200 },
      cyan: { subStart: 150, subEnd: 48, chord: [196.0, 293.66, 440.0], filterStart: 620, filterPeak: 2400 },
    };

    const cfg = archetypeConfigs[colorId];

    const subOsc = context.createOscillator();
    const subGain = context.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(cfg.subStart, now);
    subOsc.frequency.exponentialRampToValueAtTime(cfg.subEnd, now + 0.45);
    subGain.gain.setValueAtTime(0.26, now);
    subGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.48);
    subOsc.connect(subGain);
    subGain.connect(out);
    subOsc.start(now);
    subOsc.stop(now + 0.5);

    const brassFilter = context.createBiquadFilter();
    brassFilter.type = 'lowpass';
    brassFilter.Q.setValueAtTime(1.4, now);
    brassFilter.frequency.setValueAtTime(cfg.filterStart, now);
    brassFilter.frequency.exponentialRampToValueAtTime(cfg.filterPeak, now + 0.15);
    brassFilter.frequency.exponentialRampToValueAtTime(cfg.filterStart * 1.3, now + 0.5);
    brassFilter.connect(out);

    cfg.chord.forEach((freq, idx) => {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = idx === 0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq * 0.99, now);
      osc.frequency.exponentialRampToValueAtTime(freq, now + 0.08);
      gain.gain.setValueAtTime(0.005, now);
      gain.gain.linearRampToValueAtTime(idx === 0 ? 0.12 : 0.09, now + 0.06);
      gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.5);
      osc.connect(gain);
      gain.connect(brassFilter);
      osc.start(now);
      osc.stop(now + 0.52);
    });
  }

  /** Soft crystalline buy-phase barrier power-down sweep. */
  function playBarrierDrop(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out, pink } = nodes;
    const now = context.currentTime;

    const partials = [
      { fStart: 1046.5, fEnd: 523.25, delay: 0, dur: 0.28, peak: 0.1 },
      { fStart: 783.99, fEnd: 392.0, delay: 0.04, dur: 0.32, peak: 0.1 },
    ];
    for (const p of partials) {
      const t0 = now + p.delay;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(p.fStart, t0);
      osc.frequency.exponentialRampToValueAtTime(p.fEnd, t0 + p.dur);
      gain.gain.setValueAtTime(0.005, t0);
      gain.gain.linearRampToValueAtTime(p.peak, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, t0 + p.dur);
      osc.connect(gain);
      gain.connect(out);
      osc.start(t0);
      osc.stop(t0 + p.dur + 0.02);
    }

    const sweepSrc = context.createBufferSource();
    sweepSrc.buffer = pink;
    const bp = context.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.setValueAtTime(2.0, now);
    bp.frequency.setValueAtTime(2100, now);
    bp.frequency.exponentialRampToValueAtTime(380, now + 0.3);
    const sweepGain = context.createGain();
    sweepGain.gain.setValueAtTime(0.01, now);
    sweepGain.gain.linearRampToValueAtTime(0.12, now + 0.04);
    sweepGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.32);
    sweepSrc.connect(bp);
    bp.connect(sweepGain);
    sweepGain.connect(out);
    sweepSrc.start(now);
    sweepSrc.stop(now + 0.34);
  }

  /** Warm rounded synth stingers signaling round transitions (`buy`, `fight`, `win`, `lose`). */
  function playRoundCue(cue: 'buy' | 'fight' | 'win' | 'lose'): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const scheduleNotes = (
      notes: Array<{ freq: number; delay: number; dur: number; peak: number }>,
    ): void => {
      for (const n of notes) {
        const t0 = now + n.delay;
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.freq, t0);
        gain.gain.setValueAtTime(0.004, t0);
        gain.gain.linearRampToValueAtTime(n.peak, t0 + 0.018);
        gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, t0 + n.dur);
        osc.connect(gain);
        gain.connect(out);
        osc.start(t0);
        osc.stop(t0 + n.dur + 0.02);
      }
    };

    switch (cue) {
      case 'buy':
        scheduleNotes([
          { freq: 329.63, delay: 0, dur: 0.24, peak: 0.1 },
          { freq: 493.88, delay: 0.085, dur: 0.28, peak: 0.09 },
        ]);
        break;
      case 'fight':
        scheduleNotes([
          { freq: 440.0, delay: 0, dur: 0.14, peak: 0.12 },
          { freq: 659.25, delay: 0.07, dur: 0.16, peak: 0.13 },
          { freq: 880.0, delay: 0.14, dur: 0.28, peak: 0.14 },
        ]);
        break;
      case 'win':
        scheduleNotes([
          { freq: 440.0, delay: 0, dur: 0.18, peak: 0.11 },
          { freq: 554.37, delay: 0.07, dur: 0.2, peak: 0.11 },
          { freq: 659.25, delay: 0.14, dur: 0.24, peak: 0.12 },
          { freq: 880.0, delay: 0.21, dur: 0.36, peak: 0.14 },
        ]);
        break;
      case 'lose':
        scheduleNotes([
          { freq: 392.0, delay: 0, dur: 0.2, peak: 0.11 },
          { freq: 349.23, delay: 0.1, dur: 0.22, peak: 0.1 },
          { freq: 293.66, delay: 0.2, dur: 0.28, peak: 0.11 },
        ]);
        break;
    }
  }

  /** Soft ascending shop purchase chime. */
  function playBuyPurchase(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const tones = [
      { freq: 587.33, delay: 0, dur: 0.1, peak: 0.1 },
      { freq: 880.0, delay: 0.045, dur: 0.15, peak: 0.11 },
    ];
    for (const t of tones) {
      const t0 = now + t.delay;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(t.freq, t0);
      gain.gain.setValueAtTime(0.004, t0);
      gain.gain.linearRampToValueAtTime(t.peak, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, t0 + t.dur);
      osc.connect(gain);
      gain.connect(out);
      osc.start(t0);
      osc.stop(t0 + t.dur + 0.015);
    }
  }

  /** Soft muted low double-thud signaling invalid purchase or insufficient credits. */
  function playBuyError(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const pulses = [
      { delay: 0, fStart: 160, fEnd: 120 },
      { delay: 0.07, fStart: 140, fEnd: 105 },
    ];
    for (const p of pulses) {
      const t0 = now + p.delay;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(p.fStart, t0);
      osc.frequency.exponentialRampToValueAtTime(p.fEnd, t0 + 0.05);
      gain.gain.setValueAtTime(0.1, t0);
      gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, t0 + 0.055);
      osc.connect(gain);
      gain.connect(out);
      osc.start(t0);
      osc.stop(t0 + 0.065);
    }
  }

  /** Subtle rising magnetic Spike pickup chime. */
  function playSpikePickup(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(480, now);
    osc.frequency.exponentialRampToValueAtTime(840, now + 0.09);
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.13);
    osc.connect(gain);
    gain.connect(out);
    osc.start(now);
    osc.stop(now + 0.145);
  }

  /** Soft damped keypad tap emitted while planting Spike. */
  function playSpikePlantTick(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1180, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.024);
    gain.gain.setValueAtTime(0.09, now);
    gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.028);
    osc.connect(gain);
    gain.connect(out);
    osc.start(now);
    osc.stop(now + 0.036);
  }

  /** Sub-bass Spike anchor lock + warm arming chime. */
  function playSpikePlanted(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out, pink } = nodes;
    const now = context.currentTime;

    const subOsc = context.createOscillator();
    const subGain = context.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(135, now);
    subOsc.frequency.exponentialRampToValueAtTime(38, now + 0.34);
    subGain.gain.setValueAtTime(0.32, now);
    subGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.36);
    subOsc.connect(subGain);
    subGain.connect(out);
    subOsc.start(now);
    subOsc.stop(now + 0.38);

    const thudSrc = context.createBufferSource();
    thudSrc.buffer = pink;
    const lp = context.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(750, now);
    const thudGain = context.createGain();
    thudGain.gain.setValueAtTime(0.18, now);
    thudGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.14);
    thudSrc.connect(lp);
    lp.connect(thudGain);
    thudGain.connect(out);
    thudSrc.start(now);
    thudSrc.stop(now + 0.16);

    const armOsc = context.createOscillator();
    const armGain = context.createGain();
    armOsc.type = 'sine';
    armOsc.frequency.setValueAtTime(660, now + 0.04);
    armOsc.frequency.exponentialRampToValueAtTime(990, now + 0.14);
    armGain.gain.setValueAtTime(0.004, now + 0.04);
    armGain.gain.linearRampToValueAtTime(0.12, now + 0.06);
    armGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.28);
    armOsc.connect(armGain);
    armGain.connect(out);
    armOsc.start(now + 0.04);
    armOsc.stop(now + 0.3);
  }

  /** Warm rounded pure-sine Spike countdown pulse (`740 -> 1080 Hz`). */
  function playSpikeBeep(urgency01: number): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const u = clamp(urgency01, 0, 1);
    const freq = 740 + (1080 - 740) * u;
    const dur = 0.088 - 0.028 * u;

    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.004, now);
    gain.gain.linearRampToValueAtTime(0.11 + 0.06 * u, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + dur);
    osc.connect(gain);
    gain.connect(out);
    osc.start(now);
    osc.stop(now + dur + 0.015);
  }

  /** Smooth defuse tether hum stepping up cleanly past halfway checkpoint. */
  function playSpikeDefuseCue(halfwayReached: boolean): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const baseFreq = halfwayReached ? 440 : 330;
    const fifthFreq = halfwayReached ? 660 : 495;
    for (const p of [
      { freq: baseFreq, peak: 0.1 },
      { freq: fifthFreq, peak: 0.08 },
    ]) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(p.freq * 0.96, now);
      osc.frequency.exponentialRampToValueAtTime(p.freq, now + 0.06);
      gain.gain.setValueAtTime(0.004, now);
      gain.gain.linearRampToValueAtTime(p.peak, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.22);
      osc.connect(gain);
      gain.connect(out);
      osc.start(now);
      osc.stop(now + 0.24);
    }
  }

  /** Clean major resolution chime for Spike defusal. */
  function playSpikeDefused(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const notes = [
      { freq: 440.0, delay: 0, dur: 0.2, peak: 0.11 },
      { freq: 659.25, delay: 0.065, dur: 0.24, peak: 0.12 },
      { freq: 880.0, delay: 0.13, dur: 0.34, peak: 0.14 },
    ];
    for (const n of notes) {
      const t0 = now + n.delay;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.freq, t0);
      gain.gain.setValueAtTime(0.004, t0);
      gain.gain.linearRampToValueAtTime(n.peak, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, t0 + n.dur);
      osc.connect(gain);
      gain.connect(out);
      osc.start(t0);
      osc.stop(t0 + n.dur + 0.02);
    }
  }

  /** Deep sub-bass drop + warm lowpass pink shockwave for Spike detonation. */
  function playSpikeDetonate(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out, pink } = nodes;
    const now = context.currentTime;

    const subOsc = context.createOscillator();
    const subGain = context.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(110, now);
    subOsc.frequency.exponentialRampToValueAtTime(26, now + 0.78);
    subGain.gain.setValueAtTime(0.42, now);
    subGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.82);
    subOsc.connect(subGain);
    subGain.connect(out);
    subOsc.start(now);
    subOsc.stop(now + 0.84);

    const blastSrc = context.createBufferSource();
    blastSrc.buffer = pink;
    const lp = context.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, now);
    lp.frequency.exponentialRampToValueAtTime(140, now + 0.78);
    const blastGain = context.createGain();
    blastGain.gain.setValueAtTime(0.38, now);
    blastGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.82);
    blastSrc.connect(lp);
    lp.connect(blastGain);
    blastGain.connect(out);
    blastSrc.start(now);
    blastSrc.stop(now + 0.84);
  }

  /** Hydraulic steel slide + muted latch slam on Blast Doors. */
  function playDoorToggle(closing: boolean): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out, pink } = nodes;
    const now = context.currentTime;

    if (closing) {
      const slideSrc = context.createBufferSource();
      slideSrc.buffer = pink;
      const slideFilter = context.createBiquadFilter();
      slideFilter.type = 'bandpass';
      slideFilter.frequency.setValueAtTime(680, now);
      slideFilter.frequency.exponentialRampToValueAtTime(240, now + 0.2);
      slideFilter.Q.setValueAtTime(1.6, now);
      const slideGain = context.createGain();
      slideGain.gain.setValueAtTime(0.005, now);
      slideGain.gain.linearRampToValueAtTime(0.15, now + 0.025);
      slideGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.22);
      slideSrc.connect(slideFilter);
      slideFilter.connect(slideGain);
      slideGain.connect(out);
      slideSrc.start(now);
      slideSrc.stop(now + 0.24);

      const slamTime = now + 0.11;
      const slamOsc = context.createOscillator();
      const slamGain = context.createGain();
      slamOsc.type = 'sine';
      slamOsc.frequency.setValueAtTime(115, slamTime);
      slamOsc.frequency.exponentialRampToValueAtTime(48, slamTime + 0.14);
      slamGain.gain.setValueAtTime(0.26, slamTime);
      slamGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, slamTime + 0.17);
      slamOsc.connect(slamGain);
      slamGain.connect(out);
      slamOsc.start(slamTime);
      slamOsc.stop(slamTime + 0.19);
    } else {
      const hissSrc = context.createBufferSource();
      hissSrc.buffer = pink;
      const hissFilter = context.createBiquadFilter();
      hissFilter.type = 'bandpass';
      hissFilter.frequency.setValueAtTime(340, now + 0.02);
      hissFilter.frequency.exponentialRampToValueAtTime(1750, now + 0.22);
      hissFilter.Q.setValueAtTime(1.4, now + 0.02);
      const hissGain = context.createGain();
      hissGain.gain.setValueAtTime(0.005, now + 0.02);
      hissGain.gain.linearRampToValueAtTime(0.15, now + 0.06);
      hissGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.24);
      hissSrc.connect(hissFilter);
      hissFilter.connect(hissGain);
      hissGain.connect(out);
      hissSrc.start(now + 0.02);
      hissSrc.stop(now + 0.26);

      const servoOsc = context.createOscillator();
      const servoGain = context.createGain();
      servoOsc.type = 'sine';
      servoOsc.frequency.setValueAtTime(150, now + 0.02);
      servoOsc.frequency.exponentialRampToValueAtTime(310, now + 0.2);
      servoGain.gain.setValueAtTime(0.005, now + 0.02);
      servoGain.gain.linearRampToValueAtTime(0.09, now + 0.06);
      servoGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.22);
      servoOsc.connect(servoGain);
      servoGain.connect(out);
      servoOsc.start(now + 0.02);
      servoOsc.stop(now + 0.24);
    }
  }

  /** Damped metallic clank against armored Blast Door plate. */
  function playDoorHit(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out, pink } = nodes;
    const now = context.currentTime;

    const crackSrc = context.createBufferSource();
    crackSrc.buffer = pink;
    const bp = context.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1400, now);
    bp.Q.setValueAtTime(1.5, now);
    const crackGain = context.createGain();
    crackGain.gain.setValueAtTime(0.11, now);
    crackGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.036);
    crackSrc.connect(bp);
    bp.connect(crackGain);
    crackGain.connect(out);
    crackSrc.start(now);
    crackSrc.stop(now + 0.045);

    const clankOsc = context.createOscillator();
    const clankGain = context.createGain();
    clankOsc.type = 'sine';
    clankOsc.frequency.setValueAtTime(640, now);
    clankOsc.frequency.exponentialRampToValueAtTime(410, now + 0.075);
    clankGain.gain.setValueAtTime(0.09, now);
    clankGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.085);
    clankOsc.connect(clankGain);
    clankGain.connect(out);
    clankOsc.start(now);
    clankOsc.stop(now + 0.095);
  }

  /** Warm structural lowpassed crunch + debris settle when an armored door shatters. */
  function playDoorBreak(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out, pink } = nodes;
    const now = context.currentTime;

    const subOsc = context.createOscillator();
    const subGain = context.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(125, now);
    subOsc.frequency.exponentialRampToValueAtTime(34, now + 0.34);
    subGain.gain.setValueAtTime(0.32, now);
    subGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.36);
    subOsc.connect(subGain);
    subGain.connect(out);
    subOsc.start(now);
    subOsc.stop(now + 0.38);

    const shatterSrc = context.createBufferSource();
    shatterSrc.buffer = pink;
    const lp = context.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2600, now);
    lp.frequency.exponentialRampToValueAtTime(240, now + 0.36);
    const shatterGain = context.createGain();
    shatterGain.gain.setValueAtTime(0.34, now);
    shatterGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.38);
    shatterSrc.connect(lp);
    lp.connect(shatterGain);
    shatterGain.connect(out);
    shatterSrc.start(now);
    shatterSrc.stop(now + 0.4);
  }

  return {
    unlock,
    setMasterVolume,
    setMuted,
    playShot,
    playWeaponShot,
    playFootstep,
    playLandingThud,
    playHeadshot,
    playBodyHit,
    playReload,
    playLowAmmoClick,
    playUiLockIn,
    playAbility,
    playUltimateActivate,
    playBarrierDrop,
    playRoundCue,
    playBuyPurchase,
    playBuyError,
    playSpikePickup,
    playSpikePlantTick,
    playSpikePlanted,
    playSpikeBeep,
    playSpikeDefuseCue,
    playSpikeDefused,
    playSpikeDetonate,
    playDoorToggle,
    playDoorHit,
    playDoorBreak,
  };
}
