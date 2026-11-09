import { getSkin, type SkinId } from '../render/skins';
import type { AiDifficulty } from '../game/ai-config';

export interface Settings {
  soundEnabled: boolean;
  bgmEnabled: boolean;
  difficulty: AiDifficulty;
  volume: number;
  skin: SkinId;
  soundFollowsSkin: boolean;
  iosForceSound: boolean;
}

const KEY = 'dafeiyugomo.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  bgmEnabled: true,
  difficulty: 'normal',
  volume: 0.7,
  skin: 'wood',
  soundFollowsSkin: false,
  iosForceSound: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const skin = parsed.skin && getSkin(parsed.skin).id === parsed.skin ? parsed.skin : 'wood';
    const difficulty: AiDifficulty =
      parsed.difficulty === 'easy' || parsed.difficulty === 'hard'
        ? parsed.difficulty
        : DEFAULT_SETTINGS.difficulty;
    return {
      soundEnabled:
        typeof parsed.soundEnabled === 'boolean'
          ? parsed.soundEnabled
          : DEFAULT_SETTINGS.soundEnabled,
      bgmEnabled:
        typeof parsed.bgmEnabled === 'boolean'
          ? parsed.bgmEnabled
          : DEFAULT_SETTINGS.bgmEnabled,
      difficulty,
      volume:
        typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)
          ? Math.max(0, Math.min(1, parsed.volume))
          : DEFAULT_SETTINGS.volume,
      skin,
      soundFollowsSkin:
        typeof parsed.soundFollowsSkin === 'boolean'
          ? parsed.soundFollowsSkin
          : DEFAULT_SETTINGS.soundFollowsSkin,
      iosForceSound:
        typeof parsed.iosForceSound === 'boolean'
          ? parsed.iosForceSound
          : DEFAULT_SETTINGS.iosForceSound,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式下 localStorage 可能不可写，忽略即可。
  }
}
