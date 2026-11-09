export type SkinId = 'wood' | 'jade' | 'obsidian' | 'neon';

export interface Skin {
  id: SkinId;
  name: string;
  description: string;
  boardTop: string;
  boardBottom: string;
  boardEdge: string;
  grid: string;
  star: string;
  black: string;
  blackHi: string;
  blackRim: string;
  white: string;
  whiteHi: string;
  whiteRim: string;
  lastMove: string;
  hintBest: string;
  hintCandidate: string;
  hintText: string;
  accent: string;
  accentSoft: string;
  glow: boolean;
  soundTheme: SkinId;
}

export const SKINS: Record<SkinId, Skin> = {
  wood: {
    id: 'wood',
    name: '经典木纹',
    description: '和桌面版一样的暖木棋盘，黑白棋子最耐看。',
    boardTop: '#e3bf72',
    boardBottom: '#c99a45',
    boardEdge: '#8a5f24',
    grid: '#3c2814',
    star: '#3c2814',
    black: '#161616',
    blackHi: '#5a5a5a',
    blackRim: '#000000',
    white: '#fbfbfb',
    whiteHi: '#ffffff',
    whiteRim: '#b9b9b9',
    lastMove: '#e04545',
    hintBest: '#147dff',
    hintCandidate: '#ffb020',
    hintText: '#1b140b',
    accent: '#d9a441',
    accentSoft: 'rgba(217, 164, 65, 0.18)',
    glow: false,
    soundTheme: 'wood',
  },
  jade: {
    id: 'jade',
    name: '青玉',
    description: '青玉棋盘配暖白棋子，安静、清爽。',
    boardTop: '#d7e8db',
    boardBottom: '#a9c9b4',
    boardEdge: '#4f6f5c',
    grid: '#2f4a3a',
    star: '#2f4a3a',
    black: '#1b2a22',
    blackHi: '#5d7a68',
    blackRim: '#0c1611',
    white: '#f8fbf8',
    whiteHi: '#ffffff',
    whiteRim: '#a8c0ad',
    lastMove: '#c2413d',
    hintBest: '#0f6f7a',
    hintCandidate: '#c8892a',
    hintText: '#173328',
    accent: '#4f8f73',
    accentSoft: 'rgba(79, 143, 115, 0.18)',
    glow: false,
    soundTheme: 'jade',
  },
  obsidian: {
    id: 'obsidian',
    name: '黑曜',
    description: '深色棋盘配冷光，夜里下棋不刺眼。',
    boardTop: '#242a38',
    boardBottom: '#151922',
    boardEdge: '#080b10',
    grid: '#5a6478',
    star: '#8b95a8',
    black: '#05070a',
    blackHi: '#3b4657',
    blackRim: '#6f7f9b',
    white: '#e8eefc',
    whiteHi: '#ffffff',
    whiteRim: '#93a4c4',
    lastMove: '#ff6b6b',
    hintBest: '#59c6ff',
    hintCandidate: '#ffc861',
    hintText: '#e8eefc',
    accent: '#6d8bc9',
    accentSoft: 'rgba(109, 139, 201, 0.18)',
    glow: true,
    soundTheme: 'obsidian',
  },
  neon: {
    id: 'neon',
    name: '霓虹',
    description: '深蓝夜光棋盘，棋子带一点电子光晕。',
    boardTop: '#12224a',
    boardBottom: '#081126',
    boardEdge: '#040812',
    grid: '#2b4a7a',
    star: '#6fe4ff',
    black: '#06121f',
    blackHi: '#1f6a8a',
    blackRim: '#66e0ff',
    white: '#e9fbff',
    whiteHi: '#ffffff',
    whiteRim: '#ff8fd8',
    lastMove: '#ff5d8f',
    hintBest: '#67f7ff',
    hintCandidate: '#ff9f43',
    hintText: '#dff8ff',
    accent: '#33d6ff',
    accentSoft: 'rgba(51, 214, 255, 0.16)',
    glow: true,
    soundTheme: 'neon',
  },
};

export const SKIN_LIST: Skin[] = [SKINS.wood, SKINS.jade, SKINS.obsidian, SKINS.neon];

export function getSkin(id: string | null | undefined): Skin {
  if (id && id in SKINS) return SKINS[id as SkinId];
  return SKINS.wood;
}
