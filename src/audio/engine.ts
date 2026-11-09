import type { SkinId } from '../render/skins';

export type SoundEvent =
  | 'place'
  | 'win'
  | 'lose'
  | 'draw'
  | 'hint'
  | 'invalid'
  | 'ui'
  | 'start';

interface AudioSessionLike {
  type: string;
}

type AudioWindow = Window & {
  audioSession?: AudioSessionLike;
};

const THEME_SHIFT: Record<SkinId, number> = {
  wood: 1,
  jade: 1.05,
  obsidian: 0.94,
  neon: 1.12,
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private enabled = true;
  private volume = 0.7;
  private iosForce = false;
  private skin: SkinId = 'wood';
  private unlocked = false;

  configure(options: {
    enabled: boolean;
    volume: number;
    iosForce: boolean;
    skin: SkinId;
  }): void {
    this.enabled = options.enabled;
    this.volume = options.volume;
    this.iosForce = options.iosForce;
    this.skin = options.skin;
    if (this.master) {
      this.master.gain.value = this.enabled ? this.volume * 0.5 : 0;
    }
    this.applyAudioSession();
  }

  setSkin(skin: SkinId): void {
    this.skin = skin;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.master) {
      const now = this.ctx?.currentTime ?? 0;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(enabled ? this.volume * 0.5 : 0, now, 0.015);
    }
    if (enabled) void this.unlock();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(
        this.enabled ? this.volume * 0.5 : 0,
        this.ctx.currentTime,
        0.015,
      );
    }
  }

  setIosForce(force: boolean): void {
    this.iosForce = force;
    this.applyAudioSession();
  }

  debugInfo(): string {
    return `audio=${this.ctx?.state ?? 'none'} unlocked=${this.unlocked} enabled=${this.enabled}`;
  }

  async unlock(): Promise<void> {
    if (!this.enabled) return;
    const Ctor =
      globalThis.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    let ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') {
      ctx = new Ctor();
      this.ctx = ctx;
      const master = ctx.createGain();
      this.master = master;
      master.gain.value = this.volume * 0.5;
      master.connect(ctx.destination);
      this.unlocked = false;
    }

    this.applyAudioSession();

    if (ctx.state !== 'running' && ctx.state !== 'closed') {
      try {
        await ctx.resume();
      } catch {
        return;
      }
    }

    if (!this.unlocked) {
      try {
        const buffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
        this.unlocked = true;
      } catch {
        this.unlocked = false;
      }
    }
  }

  async resumeFromGesture(): Promise<void> {
    if (!this.enabled) return;
    await this.unlock();
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') {
      void this.ctx.suspend();
    }
  }

  play(event: SoundEvent): void {
    if (!this.enabled) return;
    if (!this.ctx || !this.master) {
      void this.unlock();
      return;
    }
    if (this.ctx.state !== 'running') {
      void this.ctx.resume();
    }

    const t = this.ctx.currentTime + 0.012;
    const shift = THEME_SHIFT[this.skin] ?? 1;

    switch (event) {
      case 'place':
        this.noise(t, 0.055, 0.16, 620);
        this.tone(t, 150 * shift, 0.08, 0.26, 'sine', 92 * shift);
        break;
      case 'win':
        [523.25, 659.25, 783.99, 1046.5].forEach((freq, index) => {
          this.tone(t + index * 0.1, freq * shift, 0.24, 0.17, 'triangle');
        });
        this.tone(t + 0.34, 1567.98 * shift, 0.3, 0.08, 'sine');
        break;
      case 'lose':
        [392, 349.23, 293.66].forEach((freq, index) => {
          this.tone(t + index * 0.13, freq * shift, 0.3, 0.16, 'sine', freq * 0.92);
        });
        break;
      case 'draw':
        this.tone(t, 440 * shift, 0.22, 0.13, 'sine');
        this.tone(t + 0.16, 440 * shift, 0.24, 0.1, 'sine');
        break;
      case 'hint':
        this.tone(t, 520 * shift, 0.09, 0.12, 'sine', 860 * shift);
        this.tone(t + 0.07, 1046.5 * shift, 0.15, 0.07, 'sine');
        break;
      case 'invalid':
        this.tone(t, 120, 0.09, 0.1, 'square', 96);
        break;
      case 'ui':
        this.tone(t, 680 * shift, 0.035, 0.045, 'sine');
        break;
      case 'start':
        this.tone(t, 392 * shift, 0.12, 0.1, 'triangle');
        this.tone(t + 0.1, 523.25 * shift, 0.18, 0.1, 'triangle');
        break;
    }
  }

  private applyAudioSession(): void {
    const win = window as AudioWindow;
    if (!win.audioSession) return;
    try {
      win.audioSession.type = this.iosForce ? 'playback' : 'ambient';
    } catch {
      // 某些浏览器只读或不支持该字段，忽略即可。
    }
  }

  private tone(
    start: number,
    freq: number,
    duration: number,
    gain: number,
    type: OscillatorType,
    freqEnd?: number,
  ): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const envelope = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, freq), start);
    if (freqEnd) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), start + duration);
    }
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(envelope);
    envelope.connect(this.master);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  }

  private noise(start: number, duration: number, gain: number, highpass: number): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    if (!this.noiseBuffer) {
      const length = Math.floor(ctx.sampleRate * 0.12);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buffer;
    }
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = highpass;
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.master);
    source.start(start);
    source.stop(start + duration + 0.02);
  }
}
