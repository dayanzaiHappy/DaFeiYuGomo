const BGM_VOLUME = 0.3;

/**
 * 背景音乐播放器。
 * 浏览器要求先有用户手势才能播放，所以第一次 pointerdown / keydown 时再调用 unlock()。
 */
export class BgmPlayer {
  private readonly audio: HTMLAudioElement;
  private enabled = true;
  private unlocked = false;
  private lastError = '';

  constructor(src: string) {
    this.audio = new Audio(src);
    this.audio.loop = true;
    this.audio.preload = 'none';
    this.audio.volume = BGM_VOLUME;
  }

  configure(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.audio.pause();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.audio.pause();
      return;
    }
    if (this.unlocked) void this.play();
  }

  async unlock(): Promise<void> {
    this.unlocked = true;
    if (this.enabled) await this.play();
  }

  suspend(): void {
    this.audio.pause();
  }

  resumeIfEnabled(): void {
    if (this.enabled) void this.play();
  }

  debugInfo(): string {
    const error = this.audio.error;
    return `bgm=${this.audio.paused ? 'paused' : 'playing'} enabled=${this.enabled} ready=${
      this.audio.readyState
    } net=${this.audio.networkState} t=${this.audio.currentTime.toFixed(1)}${
      error ? ` mediaErr=${error.code}` : ''
    }${this.lastError ? ` playErr=${this.lastError}` : ''}`;
  }

  private async play(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.audio.play();
      this.lastError = '';
    } catch (error) {
      this.lastError = error instanceof Error ? error.name : String(error);
    }
  }
}
