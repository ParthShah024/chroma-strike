import type { AbilityAudioEvent, WeaponId } from '../core/types';

/**
 * Procedural zero-dependency Web Audio API synthesizer for Chroma Strike.
 *
 * Audio Synthesis Mathematics:
 * - **Exponential Amplitude Envelopes**: Percussion, gunshots, and metallic dinks
 *   decay along $A(t) = A_0 e^{-t / \tau}$, where time constant $\tau$ controls how
 *   quickly energy drops to $1/e \approx 36.8\%$ of peak amplitude. Web Audio's
 *   `exponentialRampToValueAtTime(A_end, t_end)` computes $A_0 (A_{end}/A_0)^{(t/\Delta t)}$,
 *   equivalent to $e^{-t/\tau}$ with $\tau = \Delta t / \ln(A_0 / A_{end})$.
 * - **Pitch-Drop Sweeps**: Simulates acoustic membrane punch (e.g., rifle bolt &
 *   sub-bass smoke bloom) by ramping oscillator frequency exponentially downward
 *   from $f_{start}$ to $f_{end}$ over $30\text{–}150\text{ms}$.
 * - **Biquad Filtering**: White noise passed through `highpass` (gunshot crack),
 *   swept `bandpass` (dash wind rush / fire crackle), or `lowpass` (soft air hiss)
 *   shapes broadband noise into distinct tactile foley without audio file assets.
 * - **Distance Sound Attenuation**: World-space gunfire (such as 3v3 AI bot shots)
 *   scales peak oscillator and noise gain by the rational rolloff curve
 *   $g(d) = \frac{1}{1 + 0.045 \, d}$. Unlike a raw $1/d$ inverse law, adding $1$
 *   in the denominator avoids division-by-zero singularities at $d = 0\text{ m}$
 *   (giving unity gain $1.0$ for the player's own weapon), drops to $50\%$ loudness
 *   around $22.2\text{ m}$ (mid-lane duel distance), and settles cleanly to $\sim 35\%$
 *   across the full $42\text{ m}$ arena so distant skirmishes remain audible cues.
 */
export interface SoundEngine {
  unlock(): void;
  playShot(stimmed: boolean): void;
  playWeaponShot(weaponId: WeaponId, stimmed: boolean, distanceM?: number): void;
  playHeadshot(): void;
  playBodyHit(): void;
  playReload(): void;
  playLowAmmoClick(): void;
  playUiLockIn(): void;
  playAbility(event: AbilityAudioEvent): void;
  playRoundCue(cue: 'buy' | 'fight' | 'win' | 'lose'): void;
}

const NOISE_BUFFER_DURATION_SEC = 1.0;
const GAIN_EPSILON = 0.0001;

/**
 * Creates the procedural Web Audio synthesizer with lazy `AudioContext` setup,
 * master dynamics compression (preventing clipping during Bio-Stim rapid fire
 * and multi-bot firefights), and a shared 1-second white-noise buffer.
 */
export function createSoundEngine(): SoundEngine {
  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;

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

      // Master compressor + gain ensures overlapping shots, dinks, and abilities stay punchy and unclipped.
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-12, ctx.currentTime);
      compressor.knee.setValueAtTime(12, ctx.currentTime);
      compressor.ratio.setValueAtTime(6, ctx.currentTime);
      compressor.attack.setValueAtTime(0.002, ctx.currentTime);
      compressor.release.setValueAtTime(0.12, ctx.currentTime);

      masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(0.65, ctx.currentTime);

      masterGain.connect(compressor);
      compressor.connect(ctx.destination);

      // Pre-generate 1.0s of uniform [-1, 1] white noise for zero-allocation foley bursts.
      const sampleCount = Math.floor(ctx.sampleRate * NOISE_BUFFER_DURATION_SEC);
      noiseBuffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < sampleCount; i++) {
        data[i] = Math.random() * 2 - 1;
      }
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

  function getReadyNodes(): { context: AudioContext; out: GainNode; noise: AudioBuffer } | null {
    const context = ensureContext();
    if (!context || !masterGain || !noiseBuffer) return null;
    if (context.state === 'suspended') return null;
    return { context, out: masterGain, noise: noiseBuffer };
  }

  /**
   * Synthesizes weapon-specific gunfire scaled by rational distance attenuation
   * `atten = 1 / (1 + 0.045 * distanceM)`:
   * - `pistol`: crisp high-mid pop (`260Hz -> 90Hz`) + tight snap crack.
   * - `smg`: fast, suppressed-tight punch (`195Hz -> 72Hz`) + crisp transient.
   * - `ar`: classic Pulse Rifle crack (`155Hz -> 48Hz` + `1200Hz` highpass burst).
   * - `sniper`: thunderous `65Hz` rail-boom + `0.28s` delayed mechanical bolt-rack click-clack.
   */
  function playWeaponShot(weaponId: WeaponId, stimmed: boolean, distanceM = 0): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out, noise } = nodes;
    const now = context.currentTime;

    const clampedDist = Math.max(0, distanceM);
    const atten = 1 / (1 + 0.045 * clampedDist);
    if (atten < 0.02) return;

    const safePeak = (v: number): number => Math.max(GAIN_EPSILON * 2, v * atten);

    if (weaponId === 'pistol') {
      // Crisp high-mid pop + short bright muzzle snap
      const bodyOsc = context.createOscillator();
      const bodyGain = context.createGain();
      bodyOsc.type = stimmed ? 'sawtooth' : 'triangle';
      bodyOsc.frequency.setValueAtTime(stimmed ? 310 : 260, now);
      bodyOsc.frequency.exponentialRampToValueAtTime(stimmed ? 105 : 90, now + 0.045);
      bodyGain.gain.setValueAtTime(safePeak(0.34), now);
      bodyGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.055);
      bodyOsc.connect(bodyGain);
      bodyGain.connect(out);
      bodyOsc.start(now);
      bodyOsc.stop(now + 0.065);

      const crackSrc = context.createBufferSource();
      crackSrc.buffer = noise;
      const crackFilter = context.createBiquadFilter();
      crackFilter.type = 'highpass';
      crackFilter.frequency.setValueAtTime(stimmed ? 2100 : 1800, now);
      crackFilter.Q.setValueAtTime(1.0, now);
      const crackGain = context.createGain();
      crackGain.gain.setValueAtTime(safePeak(0.28), now);
      crackGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.032);
      crackSrc.connect(crackFilter);
      crackFilter.connect(crackGain);
      crackGain.connect(out);
      crackSrc.start(now);
      crackSrc.stop(now + 0.04);
    } else if (weaponId === 'smg') {
      // Fast tight punch tailored for 16 rounds/sec full-auto bursts
      const bodyOsc = context.createOscillator();
      const bodyGain = context.createGain();
      bodyOsc.type = stimmed ? 'sawtooth' : 'triangle';
      bodyOsc.frequency.setValueAtTime(stimmed ? 230 : 195, now);
      bodyOsc.frequency.exponentialRampToValueAtTime(stimmed ? 86 : 72, now + 0.042);
      bodyGain.gain.setValueAtTime(safePeak(0.28), now);
      bodyGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.05);
      bodyOsc.connect(bodyGain);
      bodyGain.connect(out);
      bodyOsc.start(now);
      bodyOsc.stop(now + 0.06);

      const crackSrc = context.createBufferSource();
      crackSrc.buffer = noise;
      const crackFilter = context.createBiquadFilter();
      crackFilter.type = 'bandpass';
      crackFilter.frequency.setValueAtTime(stimmed ? 1750 : 1450, now);
      crackFilter.Q.setValueAtTime(1.1, now);
      const crackGain = context.createGain();
      crackGain.gain.setValueAtTime(safePeak(0.26), now);
      crackGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.03);
      crackSrc.connect(crackFilter);
      crackFilter.connect(crackGain);
      crackGain.connect(out);
      crackSrc.start(now);
      crackSrc.stop(now + 0.038);
    } else if (weaponId === 'sniper') {
      // Deep thunderous 65Hz rail-boom + broad muzzle blast + 0.28s delayed bolt-rack click-clack
      const subOsc = context.createOscillator();
      const subGain = context.createGain();
      subOsc.type = 'sawtooth';
      subOsc.frequency.setValueAtTime(stimmed ? 125 : 105, now);
      subOsc.frequency.exponentialRampToValueAtTime(65, now + 0.055);
      subOsc.frequency.exponentialRampToValueAtTime(34, now + 0.24);
      subGain.gain.setValueAtTime(safePeak(0.55), now);
      subGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.26);
      subOsc.connect(subGain);
      subGain.connect(out);
      subOsc.start(now);
      subOsc.stop(now + 0.28);

      const railOsc = context.createOscillator();
      const railGain = context.createGain();
      railOsc.type = 'sine';
      railOsc.frequency.setValueAtTime(65, now);
      railOsc.frequency.exponentialRampToValueAtTime(32, now + 0.3);
      railGain.gain.setValueAtTime(safePeak(0.5), now);
      railGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.32);
      railOsc.connect(railGain);
      railGain.connect(out);
      railOsc.start(now);
      railOsc.stop(now + 0.34);

      const blastSrc = context.createBufferSource();
      blastSrc.buffer = noise;
      const blastFilter = context.createBiquadFilter();
      blastFilter.type = 'lowpass';
      blastFilter.frequency.setValueAtTime(3200, now);
      blastFilter.frequency.exponentialRampToValueAtTime(480, now + 0.16);
      const blastGain = context.createGain();
      blastGain.gain.setValueAtTime(safePeak(0.45), now);
      blastGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.16);
      blastSrc.connect(blastFilter);
      blastFilter.connect(blastGain);
      blastGain.connect(out);
      blastSrc.start(now);
      blastSrc.stop(now + 0.18);

      // Delayed mechanical bolt-rack click-clack at +0.28s and +0.37s
      const boltClicks = [
        { delay: 0.28, freq: 2100, peak: 0.16 },
        { delay: 0.37, freq: 2900, peak: 0.2 },
      ];
      for (const click of boltClicks) {
        const t0 = now + click.delay;
        const boltSrc = context.createBufferSource();
        boltSrc.buffer = noise;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(click.freq, t0);
        bp.Q.setValueAtTime(3.6, t0);
        const boltGain = context.createGain();
        boltGain.gain.setValueAtTime(safePeak(click.peak), t0);
        boltGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, t0 + 0.032);
        boltSrc.connect(bp);
        bp.connect(boltGain);
        boltGain.connect(out);
        boltSrc.start(t0);
        boltSrc.stop(t0 + 0.04);
      }
    } else {
      // 'ar' (Pulse Rifle): punchy low-mid membrane drop + high-passed muzzle crack
      const bodyOsc = context.createOscillator();
      const bodyGain = context.createGain();
      bodyOsc.type = stimmed ? 'sawtooth' : 'triangle';
      bodyOsc.frequency.setValueAtTime(stimmed ? 195 : 155, now);
      bodyOsc.frequency.exponentialRampToValueAtTime(stimmed ? 62 : 48, now + 0.07);
      bodyGain.gain.setValueAtTime(safePeak(0.42), now);
      bodyGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.085);
      bodyOsc.connect(bodyGain);
      bodyGain.connect(out);
      bodyOsc.start(now);
      bodyOsc.stop(now + 0.095);

      const crackSrc = context.createBufferSource();
      crackSrc.buffer = noise;
      const crackFilter = context.createBiquadFilter();
      crackFilter.type = 'highpass';
      crackFilter.frequency.setValueAtTime(stimmed ? 1650 : 1200, now);
      crackFilter.Q.setValueAtTime(0.9, now);
      const crackGain = context.createGain();
      crackGain.gain.setValueAtTime(safePeak(stimmed ? 0.36 : 0.32), now);
      crackGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.045);
      crackSrc.connect(crackFilter);
      crackFilter.connect(crackGain);
      crackGain.connect(out);
      crackSrc.start(now);
      crackSrc.stop(now + 0.055);
    }

    // Subtle overdrive metallic snap harmonic when Bio-Stim is active
    if (stimmed) {
      const snapOsc = context.createOscillator();
      const snapGain = context.createGain();
      snapOsc.type = 'sine';
      snapOsc.frequency.setValueAtTime(1480, now);
      snapOsc.frequency.exponentialRampToValueAtTime(620, now + 0.032);
      snapGain.gain.setValueAtTime(safePeak(0.14), now);
      snapGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.035);
      snapOsc.connect(snapGain);
      snapGain.connect(out);
      snapOsc.start(now);
      snapOsc.stop(now + 0.04);
    }
  }

  /**
   * Backward-compatible default rifle shot wrapper (`playWeaponShot('ar', stimmed)`).
   */
  function playShot(stimmed: boolean): void {
    playWeaponShot('ar', stimmed, 0);
  }

  /**
   * Iconic Valorant-style metallic double-harmonic headshot "dink":
   * fundamental `1046 Hz` (C6) + octave `2093 Hz` (C7) with `0.18s` exponential decay.
   */
  function playHeadshot(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const partials: Array<{ freq: number; type: OscillatorType; peak: number; dur: number }> = [
      { freq: 1046, type: 'triangle', peak: 0.36, dur: 0.18 },
      { freq: 2093, type: 'sine', peak: 0.28, dur: 0.16 },
    ];

    for (const p of partials) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = p.type;
      osc.frequency.setValueAtTime(p.freq, now);
      gain.gain.setValueAtTime(p.peak, now);
      gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + p.dur);
      osc.connect(gain);
      gain.connect(out);
      osc.start(now);
      osc.stop(now + p.dur + 0.015);
    }
  }

  /**
   * Tight `190 Hz` body impact thud (`55ms`).
   */
  function playBodyHit(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(190, now);
    osc.frequency.exponentialRampToValueAtTime(95, now + 0.055);
    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.055);

    osc.connect(gain);
    gain.connect(out);
    osc.start(now);
    osc.stop(now + 0.065);
  }

  /**
   * Subtle mechanical two-click magazine release + bolt latch transient.
   */
  function playReload(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out, noise } = nodes;
    const now = context.currentTime;

    const clicks = [
      { offset: 0, centerHz: 2400, gainPeak: 0.14 },
      { offset: 0.14, centerHz: 3200, gainPeak: 0.18 },
    ];

    for (const click of clicks) {
      const t0 = now + click.offset;
      const src = context.createBufferSource();
      src.buffer = noise;

      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(click.centerHz, t0);
      filter.Q.setValueAtTime(3.2, t0);

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

  /**
   * Crisp dry metallic magazine click signaling low ammunition (`<= 20%` mag).
   * Combines a tight `3.4 kHz` high-Q noise tick with a `1900 -> 880 Hz` latch ping.
   */
  function playLowAmmoClick(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out, noise } = nodes;
    const now = context.currentTime;

    const clickSrc = context.createBufferSource();
    clickSrc.buffer = noise;
    const bp = context.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(3400, now);
    bp.Q.setValueAtTime(4.2, now);
    const clickGain = context.createGain();
    clickGain.gain.setValueAtTime(0.16, now);
    clickGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.022);
    clickSrc.connect(bp);
    bp.connect(clickGain);
    clickGain.connect(out);
    clickSrc.start(now);
    clickSrc.stop(now + 0.03);

    const pingOsc = context.createOscillator();
    const pingGain = context.createGain();
    pingOsc.type = 'triangle';
    pingOsc.frequency.setValueAtTime(1900, now);
    pingOsc.frequency.exponentialRampToValueAtTime(880, now + 0.024);
    pingGain.gain.setValueAtTime(0.11, now);
    pingGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.026);
    pingOsc.connect(pingGain);
    pingGain.connect(out);
    pingOsc.start(now);
    pingOsc.stop(now + 0.032);
  }

  /**
   * Futuristic two-voice lock-in confirmation chord (detuned fifth + octave shimmer).
   */
  function playUiLockIn(): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const voices: Array<{ fStart: number; fEnd: number; delay: number; dur: number; type: OscillatorType; peak: number }> = [
      { fStart: 440, fEnd: 523.25, delay: 0, dur: 0.18, type: 'triangle', peak: 0.18 },
      { fStart: 659.25, fEnd: 783.99, delay: 0.045, dur: 0.24, type: 'sine', peak: 0.2 },
      { fStart: 1046.5, fEnd: 1046.5, delay: 0.075, dur: 0.26, type: 'sine', peak: 0.12 },
    ];

    for (const v of voices) {
      const t0 = now + v.delay;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = v.type;
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
    const { context, out, noise } = nodes;
    const now = context.currentTime;

    switch (event) {
      case 'dash': {
        const src = context.createBufferSource();
        src.buffer = noise;

        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(1.6, now);
        bp.frequency.setValueAtTime(300, now);
        bp.frequency.exponentialRampToValueAtTime(1800, now + 0.08);
        bp.frequency.exponentialRampToValueAtTime(400, now + 0.22);

        const gain = context.createGain();
        gain.gain.setValueAtTime(0.02, now);
        gain.gain.linearRampToValueAtTime(0.42, now + 0.04);
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
        src.buffer = noise;

        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(2.0, now);
        bp.frequency.setValueAtTime(260, now);
        bp.frequency.exponentialRampToValueAtTime(520, now + 0.08);

        const gain = context.createGain();
        gain.gain.setValueAtTime(0.24, now);
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
        thumpGain.gain.setValueAtTime(0.38, now);
        thumpGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.24);
        thumpOsc.connect(thumpGain);
        thumpGain.connect(out);
        thumpOsc.start(now);
        thumpOsc.stop(now + 0.26);

        const crackleSrc = context.createBufferSource();
        crackleSrc.buffer = noise;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(1.4, now);
        bp.frequency.setValueAtTime(1400, now);
        bp.frequency.exponentialRampToValueAtTime(750, now + 0.35);

        const crackleGain = context.createGain();
        crackleGain.gain.setValueAtTime(0.32, now);
        crackleGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.35);

        crackleSrc.connect(bp);
        bp.connect(crackleGain);
        crackleGain.connect(out);
        crackleSrc.start(now);
        crackleSrc.stop(now + 0.37);
        break;
      }

      case 'smoke_bloom': {
        const subOsc = context.createOscillator();
        const subGain = context.createGain();
        subOsc.type = 'sine';
        subOsc.frequency.setValueAtTime(130, now);
        subOsc.frequency.exponentialRampToValueAtTime(52, now + 0.42);
        subGain.gain.setValueAtTime(0.4, now);
        subGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.42);
        subOsc.connect(subGain);
        subGain.connect(out);
        subOsc.start(now);
        subOsc.stop(now + 0.44);

        const airSrc = context.createBufferSource();
        airSrc.buffer = noise;
        const lp = context.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(1200, now);
        lp.frequency.exponentialRampToValueAtTime(420, now + 0.42);

        const airGain = context.createGain();
        airGain.gain.setValueAtTime(0.02, now);
        airGain.gain.linearRampToValueAtTime(0.22, now + 0.08);
        airGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.42);

        airSrc.connect(lp);
        lp.connect(airGain);
        airGain.connect(out);
        airSrc.start(now);
        airSrc.stop(now + 0.44);
        break;
      }

      case 'slow_shatter': {
        const chimes = [1320, 1760, 2350];
        for (let i = 0; i < chimes.length; i++) {
          const osc = context.createOscillator();
          const gain = context.createGain();
          const t0 = now + i * 0.014;
          osc.type = 'sine';
          osc.frequency.setValueAtTime(chimes[i], t0);
          gain.gain.setValueAtTime(0.18, t0);
          gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.3);
          osc.connect(gain);
          gain.connect(out);
          osc.start(t0);
          osc.stop(now + 0.32);
        }

        const iceSrc = context.createBufferSource();
        iceSrc.buffer = noise;
        const hp = context.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.setValueAtTime(2600, now);
        const iceGain = context.createGain();
        iceGain.gain.setValueAtTime(0.24, now);
        iceGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.14);
        iceSrc.connect(hp);
        hp.connect(iceGain);
        iceGain.connect(out);
        iceSrc.start(now);
        iceSrc.stop(now + 0.16);
        break;
      }

      case 'flash_warn': {
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(900, now);
        osc.frequency.exponentialRampToValueAtTime(2200, now + 0.18);
        gain.gain.setValueAtTime(0.02, now);
        gain.gain.linearRampToValueAtTime(0.2, now + 0.12);
        gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.18);
        osc.connect(gain);
        gain.connect(out);
        osc.start(now);
        osc.stop(now + 0.19);
        break;
      }

      case 'flash_pop': {
        const snapSrc = context.createBufferSource();
        snapSrc.buffer = noise;
        const hp = context.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.setValueAtTime(1800, now);
        const snapGain = context.createGain();
        snapGain.gain.setValueAtTime(0.38, now);
        snapGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.06);
        snapSrc.connect(hp);
        hp.connect(snapGain);
        snapGain.connect(out);
        snapSrc.start(now);
        snapSrc.stop(now + 0.07);

        const ringOsc = context.createOscillator();
        const ringGain = context.createGain();
        ringOsc.type = 'sine';
        ringOsc.frequency.setValueAtTime(2800, now);
        ringGain.gain.setValueAtTime(0.11, now);
        ringGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.35);
        ringOsc.connect(ringGain);
        ringGain.connect(out);
        ringOsc.start(now);
        ringOsc.stop(now + 0.37);
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
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(n.freq, t0);
          gain.gain.setValueAtTime(0.2, t0);
          gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.28);
          osc.connect(gain);
          gain.connect(out);
          osc.start(t0);
          osc.stop(now + 0.3);
        }
        break;
      }

      case 'void_cast': {
        // Umbra phase-orb cast: hollow descending phase sweep + dark bandpass whoosh
        const phaseOsc = context.createOscillator();
        const phaseGain = context.createGain();
        phaseOsc.type = 'sine';
        phaseOsc.frequency.setValueAtTime(420, now);
        phaseOsc.frequency.exponentialRampToValueAtTime(140, now + 0.22);
        phaseGain.gain.setValueAtTime(0.01, now);
        phaseGain.gain.linearRampToValueAtTime(0.24, now + 0.03);
        phaseGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.24);
        phaseOsc.connect(phaseGain);
        phaseGain.connect(out);
        phaseOsc.start(now);
        phaseOsc.stop(now + 0.26);

        const whooshSrc = context.createBufferSource();
        whooshSrc.buffer = noise;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(2.8, now);
        bp.frequency.setValueAtTime(920, now);
        bp.frequency.exponentialRampToValueAtTime(280, now + 0.2);
        const whooshGain = context.createGain();
        whooshGain.gain.setValueAtTime(0.18, now);
        whooshGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.21);
        whooshSrc.connect(bp);
        bp.connect(whooshGain);
        whooshGain.connect(out);
        whooshSrc.start(now);
        whooshSrc.stop(now + 0.23);
        break;
      }

      case 'void_bloom': {
        // Umbra void shroud bloom: deep resonant sub-drop + eerie detuned fifth shimmer
        const subOsc = context.createOscillator();
        const subGain = context.createGain();
        subOsc.type = 'sine';
        subOsc.frequency.setValueAtTime(155, now);
        subOsc.frequency.exponentialRampToValueAtTime(46, now + 0.45);
        subGain.gain.setValueAtTime(0.38, now);
        subGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.46);
        subOsc.connect(subGain);
        subGain.connect(out);
        subOsc.start(now);
        subOsc.stop(now + 0.48);

        for (const freq of [311.13, 466.16]) {
          const chimeOsc = context.createOscillator();
          const chimeGain = context.createGain();
          chimeOsc.type = 'triangle';
          chimeOsc.frequency.setValueAtTime(freq, now);
          chimeOsc.frequency.exponentialRampToValueAtTime(freq * 0.94, now + 0.42);
          chimeGain.gain.setValueAtTime(0.01, now);
          chimeGain.gain.linearRampToValueAtTime(0.12, now + 0.06);
          chimeGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.44);
          chimeOsc.connect(chimeGain);
          chimeGain.connect(out);
          chimeOsc.start(now);
          chimeOsc.stop(now + 0.46);
        }
        break;
      }

      case 'vortex_pull': {
        // Umbra Singularity: inward gravity vacuum sweep (rising low-pass suction + sub thrum)
        const vacSrc = context.createBufferSource();
        vacSrc.buffer = noise;
        const lp = context.createBiquadFilter();
        lp.type = 'bandpass';
        lp.Q.setValueAtTime(2.2, now);
        lp.frequency.setValueAtTime(180, now);
        lp.frequency.exponentialRampToValueAtTime(980, now + 0.28);
        lp.frequency.exponentialRampToValueAtTime(120, now + 0.46);
        const vacGain = context.createGain();
        vacGain.gain.setValueAtTime(0.02, now);
        vacGain.gain.linearRampToValueAtTime(0.3, now + 0.22);
        vacGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.46);
        vacSrc.connect(lp);
        lp.connect(vacGain);
        vacGain.connect(out);
        vacSrc.start(now);
        vacSrc.stop(now + 0.48);

        const gravOsc = context.createOscillator();
        const gravGain = context.createGain();
        gravOsc.type = 'sawtooth';
        gravOsc.frequency.setValueAtTime(110, now);
        gravOsc.frequency.exponentialRampToValueAtTime(48, now + 0.42);
        gravGain.gain.setValueAtTime(0.22, now);
        gravGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.44);
        gravOsc.connect(gravGain);
        gravGain.connect(out);
        gravOsc.start(now);
        gravOsc.stop(now + 0.46);
        break;
      }

      case 'overdrive_on': {
        // Volt Overdrive: rising electric harmonic surge + crisp arc snap
        const surgeOsc = context.createOscillator();
        const surgeGain = context.createGain();
        surgeOsc.type = 'sawtooth';
        surgeOsc.frequency.setValueAtTime(240, now);
        surgeOsc.frequency.exponentialRampToValueAtTime(880, now + 0.18);
        surgeGain.gain.setValueAtTime(0.01, now);
        surgeGain.gain.linearRampToValueAtTime(0.22, now + 0.04);
        surgeGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.24);
        surgeOsc.connect(surgeGain);
        surgeGain.connect(out);
        surgeOsc.start(now);
        surgeOsc.stop(now + 0.26);

        const sparkSrc = context.createBufferSource();
        sparkSrc.buffer = noise;
        const hp = context.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.setValueAtTime(2400, now);
        const sparkGain = context.createGain();
        sparkGain.gain.setValueAtTime(0.2, now);
        sparkGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.12);
        sparkSrc.connect(hp);
        hp.connect(sparkGain);
        sparkGain.connect(out);
        sparkSrc.start(now);
        sparkSrc.stop(now + 0.14);
        break;
      }

      case 'power_slide': {
        // Volt Power-Slide: kinetic floor skid noise + descending electric coil whine
        const skidSrc = context.createBufferSource();
        skidSrc.buffer = noise;
        const bp = context.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(1.5, now);
        bp.frequency.setValueAtTime(1900, now);
        bp.frequency.exponentialRampToValueAtTime(520, now + 0.34);
        const skidGain = context.createGain();
        skidGain.gain.setValueAtTime(0.02, now);
        skidGain.gain.linearRampToValueAtTime(0.36, now + 0.03);
        skidGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.36);
        skidSrc.connect(bp);
        bp.connect(skidGain);
        skidGain.connect(out);
        skidSrc.start(now);
        skidSrc.stop(now + 0.38);

        const coilOsc = context.createOscillator();
        const coilGain = context.createGain();
        coilOsc.type = 'triangle';
        coilOsc.frequency.setValueAtTime(640, now);
        coilOsc.frequency.exponentialRampToValueAtTime(190, now + 0.3);
        coilGain.gain.setValueAtTime(0.16, now);
        coilGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.32);
        coilOsc.connect(coilGain);
        coilGain.connect(out);
        coilOsc.start(now);
        coilOsc.stop(now + 0.34);
        break;
      }

      case 'relay_bounce': {
        // Volt Relay Bolt ricochet: bright electric chirp + metallic bounce ping
        const chirpOsc = context.createOscillator();
        const chirpGain = context.createGain();
        chirpOsc.type = 'sine';
        chirpOsc.frequency.setValueAtTime(1250, now);
        chirpOsc.frequency.exponentialRampToValueAtTime(2400, now + 0.055);
        chirpGain.gain.setValueAtTime(0.22, now);
        chirpGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.09);
        chirpOsc.connect(chirpGain);
        chirpGain.connect(out);
        chirpOsc.start(now);
        chirpOsc.stop(now + 0.1);
        break;
      }

      case 'relay_zap': {
        // Volt Relay Shock detonation: sharp electric arc snap + buzzing discharge
        const arcSrc = context.createBufferSource();
        arcSrc.buffer = noise;
        const hp = context.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.setValueAtTime(1600, now);
        const arcGain = context.createGain();
        arcGain.gain.setValueAtTime(0.36, now);
        arcGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.16);
        arcSrc.connect(hp);
        hp.connect(arcGain);
        arcGain.connect(out);
        arcSrc.start(now);
        arcSrc.stop(now + 0.18);

        const zapOsc = context.createOscillator();
        const zapGain = context.createGain();
        zapOsc.type = 'sawtooth';
        zapOsc.frequency.setValueAtTime(520, now);
        zapOsc.frequency.exponentialRampToValueAtTime(95, now + 0.22);
        zapGain.gain.setValueAtTime(0.28, now);
        zapGain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, now + 0.24);
        zapOsc.connect(zapGain);
        zapGain.connect(out);
        zapOsc.start(now);
        zapOsc.stop(now + 0.26);
        break;
      }
    }
  }

  /**
   * Clean musical synth stingers signaling round transitions (`buy`, `fight`, `win`, `lose`).
   */
  function playRoundCue(cue: 'buy' | 'fight' | 'win' | 'lose'): void {
    const nodes = getReadyNodes();
    if (!nodes) return;
    const { context, out } = nodes;
    const now = context.currentTime;

    const scheduleNotes = (
      notes: Array<{ freq: number; delay: number; dur: number; type: OscillatorType; peak: number }>,
    ): void => {
      for (const n of notes) {
        const t0 = now + n.delay;
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = n.type;
        osc.frequency.setValueAtTime(n.freq, t0);
        gain.gain.setValueAtTime(0.005, t0);
        gain.gain.linearRampToValueAtTime(n.peak, t0 + 0.015);
        gain.gain.exponentialRampToValueAtTime(GAIN_EPSILON, t0 + n.dur);
        osc.connect(gain);
        gain.connect(out);
        osc.start(t0);
        osc.stop(t0 + n.dur + 0.02);
      }
    };

    switch (cue) {
      case 'buy':
        // Calm neutral two-note tactical prep chime (E4 -> B4)
        scheduleNotes([
          { freq: 329.63, delay: 0, dur: 0.28, type: 'sine', peak: 0.16 },
          { freq: 493.88, delay: 0.09, dur: 0.35, type: 'triangle', peak: 0.14 },
        ]);
        break;

      case 'fight':
        // Crisp energetic barrier-drop stinger (C5 -> G5 -> C6)
        scheduleNotes([
          { freq: 523.25, delay: 0, dur: 0.14, type: 'triangle', peak: 0.2 },
          { freq: 783.99, delay: 0.07, dur: 0.16, type: 'triangle', peak: 0.22 },
          { freq: 1046.5, delay: 0.14, dur: 0.32, type: 'sine', peak: 0.24 },
        ]);
        break;

      case 'win':
        // Uplifting major triad arpeggio (C5 - E5 - G5 - C6)
        scheduleNotes([
          { freq: 523.25, delay: 0, dur: 0.22, type: 'triangle', peak: 0.18 },
          { freq: 659.25, delay: 0.07, dur: 0.24, type: 'triangle', peak: 0.19 },
          { freq: 783.99, delay: 0.14, dur: 0.28, type: 'triangle', peak: 0.2 },
          { freq: 1046.5, delay: 0.21, dur: 0.45, type: 'sine', peak: 0.24 },
        ]);
        break;

      case 'lose':
        // Somber descending minor cadence (G4 - F4 - Eb4 - C4)
        scheduleNotes([
          { freq: 392.0, delay: 0, dur: 0.22, type: 'triangle', peak: 0.18 },
          { freq: 349.23, delay: 0.11, dur: 0.24, type: 'triangle', peak: 0.17 },
          { freq: 311.13, delay: 0.22, dur: 0.28, type: 'sine', peak: 0.18 },
          { freq: 261.63, delay: 0.33, dur: 0.48, type: 'sine', peak: 0.2 },
        ]);
        break;
    }
  }

  return {
    unlock,
    playShot,
    playWeaponShot,
    playHeadshot,
    playBodyHit,
    playReload,
    playLowAmmoClick,
    playUiLockIn,
    playAbility,
    playRoundCue,
  };
}
