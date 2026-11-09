import './styles/main.css';
import { AiClient, type ReadyInfo } from './ai/client';
import { AudioEngine } from './audio/engine';
import { BgmPlayer } from './audio/bgm';
import { loadSettings, saveSettings, type Settings } from './app/settings';
import { BoardView, type BoardViewState } from './render/board-view';
import { getSkin, SKIN_LIST, type Skin } from './render/skins';
import {
  AI_CONFIG,
  DIFFICULTY_SIMS,
  OPPONENT_NOISE,
  OPPONENT_TEMPERATURE,
  SAMPLE_TOP_K,
  type AiDifficulty,
} from './game/ai-config';
import {
  boardKey,
  checkWin,
  createBoard,
  getWinLine,
  isBoardFull,
  isValidMove,
  placeStone,
  shortCoord,
} from './game/board';
import { buildHintView } from './game/explain';
import { chooseOpeningResponse } from './game/opening';
import { WHALE_LINES } from './content/whale-lines';
import { HintCache } from './game/hint-cache';
import { mascotSvg, type MascotState } from './ui/mascot';
import type { Player, SearchResult } from './game/types';
import { BLACK, WHITE } from './game/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少页面元素 #${id}`);
  return element as T;
};

type Mode = 'pvp' | 'pvai';
type GameStatus = 'playing' | 'won' | 'draw';
type AiState = 'idle' | 'loading' | 'ready' | 'error';

const DIFFICULTY_OPTIONS: Array<{ id: AiDifficulty; label: string }> = [
  { id: 'easy', label: '简单' },
  { id: 'normal', label: '普通' },
  { id: 'hard', label: '困难' },
];

interface GameState {
  mode: Mode;
  board: Uint8Array;
  current: Player;
  history: Array<{ player: Player; move: number }>;
  humanColor: Player;
  status: GameStatus;
  winner: Player | null;
  lastMove: number | null;
  winLine: number[];
  hint: SearchResult | null;
  hintLoading: boolean;
  thinking: boolean;
}

const homeScreen = $('home-screen');
const gameScreen = $('game-screen');
const homeMascot = $('home-mascot');
const mascotAvatar = $('mascot-avatar');
const modalRoot = $('modal-root');
const toastEl = $('toast');
const hintText = $('hint-text');
const hintChips = $('hint-chips');
const gameStatus = $('game-status');
const gameMode = $('game-mode');
const hintButton = $<HTMLButtonElement>('btn-hint');
const undoButton = $<HTMLButtonElement>('btn-undo');
const restartButton = $<HTMLButtonElement>('btn-restart');
const soundButton = $<HTMLButtonElement>('game-sound');
const homeBgmButton = $<HTMLButtonElement>('home-bgm');
const gameBgmButton = $<HTMLButtonElement>('game-bgm');
const boardLoading = $('board-loading');

const settings: Settings = loadSettings();
const audio = new AudioEngine();
audio.configure({
  enabled: settings.soundEnabled,
  volume: settings.volume,
  iosForce: settings.iosForceSound,
  skin: settings.soundFollowsSkin ? settings.skin : 'wood',
});

const assetBase = new URL(import.meta.env.BASE_URL, location.origin).href;
const wasmBase = `${assetBase}ort/`;
const modelUrl = `${assetBase}models/model-v2.onnx`;

const bgm = new BgmPlayer(`${assetBase}audio/bgm/Let Me Go.mp3`);
bgm.configure(settings.bgmEnabled);

const hintCache = new HintCache(32);
let aiClient: AiClient | null = null;
let aiReadyPromise: Promise<void> | null = null;
let readyInfo: ReadyInfo | null = null;
let aiStatus: AiState = 'idle';
let gameToken = 0;
let hintToken = 0;
let resultTimer = 0;
let toastTimer = 0;
let currentMascot: MascotState = 'idle';
let cacheHits = 0;
let lastSearch = { kind: '-', sims: 0, ms: 0 };

function createGameState(mode: Mode, humanColor: Player): GameState {
  return {
    mode,
    board: createBoard(),
    current: BLACK,
    history: [],
    humanColor,
    status: 'playing',
    winner: null,
    lastMove: null,
    winLine: [],
    hint: null,
    hintLoading: false,
    thinking: false,
  };
}

let state = createGameState('pvp', BLACK);

const boardView = new BoardView(
  $<HTMLCanvasElement>('board-canvas'),
  $('board-wrap'),
  {
    onPlace: (move) => {
      if (!canHumanPlace()) {
        audio.play('invalid');
        return;
      }
      place(move);
    },
    getSkin: () => getSkin(settings.skin),
    onDebug: () => updateDebug(),
  },
);

/* ===== 基础 UI ===== */

function setMascot(next: MascotState): void {
  if (next === currentMascot) return;
  currentMascot = next;
  mascotAvatar.dataset.state = next;
}

const mascotHomeUrl = new URL('images/whale-home.jpg', document.baseURI).href;
const mascotAvatarUrl = new URL('images/whale-avatar.jpg', document.baseURI).href;

function makeMascotImage(url: string, className: string): HTMLImageElement {
  const image = document.createElement('img');
  image.src = url;
  image.alt = '蓝色大肥鱼';
  image.className = `mascot-img ${className}`;
  image.draggable = false;
  image.decoding = 'async';
  return image;
}

function installMascots(): void {
  homeMascot.replaceChildren(makeMascotImage(mascotHomeUrl, 'mascot-home-img'));
  mascotAvatar.replaceChildren(makeMascotImage(mascotAvatarUrl, 'mascot-avatar-img'));
  mascotAvatar.dataset.state = 'idle';

  const homeImage = homeMascot.querySelector('img');
  homeImage?.addEventListener(
    'error',
    () => {
      homeMascot.innerHTML = mascotSvg('idle');
    },
    { once: true },
  );

  const avatarImage = mascotAvatar.querySelector('img');
  avatarImage?.addEventListener(
    'error',
    () => {
      mascotAvatar.innerHTML = mascotSvg('idle');
    },
    { once: true },
  );
}

function setHintChips(chips: Array<{ label: string }>): void {
  hintChips.innerHTML = '';
  for (const chip of chips) {
    const span = document.createElement('span');
    span.textContent = chip.label;
    hintChips.appendChild(span);
  }
}

function showToast(message: string, duration = 2800): void {
  window.clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  toastTimer = window.setTimeout(() => {
    toastEl.classList.add('hidden');
  }, duration);
}

function openModal(innerHtml: string): void {
  modalRoot.innerHTML = `<div class="modal-backdrop">${innerHtml}</div>`;
  const backdrop = modalRoot.firstElementChild as HTMLElement | null;
  backdrop?.addEventListener('click', (event) => {
    if (event.target === backdrop) closeModal();
  });
  const focusable = modalRoot.querySelector<HTMLElement>('button, input, [tabindex]');
  focusable?.focus();
}

function closeModal(): void {
  modalRoot.innerHTML = '';
}

function canHumanPlace(): boolean {
  if (state.status !== 'playing') return false;
  if (state.thinking) return false;
  if (state.mode === 'pvai') return state.current === state.humanColor;
  return true;
}

function buildBoardState(): BoardViewState {
  return {
    board: state.board,
    lastMove: state.lastMove,
    hint: state.hint
      ? {
          move: state.hint.move,
          top: state.hint.top.map((item) => ({ move: item.move, value: item.value })),
        }
      : null,
    winLine: state.winLine,
    interactive: canHumanPlace(),
  };
}

function refreshBoard(): void {
  boardView.setState(buildBoardState());
}

function refreshStatus(): void {
  let text = '';
  let className = 'status-pill';

  if (state.status === 'won') {
    if (state.mode === 'pvp') {
      text = state.winner === BLACK ? '黑方胜' : '白方胜';
    } else {
      text = state.winner === state.humanColor ? '你赢了' : '大肥鱼赢了';
    }
    className += ' won';
  } else if (state.status === 'draw') {
    text = '平局';
    className += ' won';
  } else if (aiStatus === 'loading' && state.mode === 'pvai' && state.current !== state.humanColor) {
    text = '大肥鱼正在加载…';
    className += ' thinking';
  } else if (aiStatus === 'error' && state.mode === 'pvai' && state.current !== state.humanColor) {
    text = 'AI 引擎出错了';
    className += ' error';
  } else if (state.thinking || state.hintLoading) {
    text = '大肥鱼正在思考…';
    className += ' thinking';
  } else if (state.mode === 'pvp') {
    text = state.current === BLACK ? '黑方落子' : '白方落子';
  } else if (state.current === state.humanColor) {
    if (aiStatus === 'loading') {
      text = '轮到你落子 · AI 热身中';
      className += ' thinking';
    } else if (aiStatus === 'error') {
      text = '轮到你落子 · AI 加载失败';
      className += ' error';
    } else {
      text = '轮到你落子';
    }
  } else {
    text = '大肥鱼落子';
  }

  gameStatus.textContent = text;
  gameStatus.className = className;

  if (state.mode === 'pvai') {
    gameMode.textContent = `人 vs 机 · 你执${state.humanColor === BLACK ? '黑' : '白'}`;
  } else {
    gameMode.textContent = '人 vs 人';
  }
}

function refreshHintPanel(): void {
  if (state.hint) {
    const view = buildHintView(state.board, state.current, state.hint);
    if (view) {
      hintText.textContent = view.text;
      setHintChips(view.chips);
      return;
    }
  }

  if (state.hintLoading) {
    hintText.textContent = WHALE_LINES.thinking;
    setHintChips([]);
    return;
  }

  setHintChips([]);

  if (state.status === 'won') {
    hintText.textContent =
      state.mode === 'pvai' && state.winner !== state.humanColor
        ? WHALE_LINES.lose
        : WHALE_LINES.win;
  } else if (state.status === 'draw') {
    hintText.textContent = WHALE_LINES.draw;
  } else if (state.mode === 'pvp') {
    hintText.textContent = WHALE_LINES.pvp;
  } else if (aiStatus === 'loading') {
    hintText.textContent = WHALE_LINES.loading;
  } else if (aiStatus === 'error') {
    hintText.textContent = WHALE_LINES.loadError;
  } else if (state.thinking) {
    hintText.textContent = WHALE_LINES.myTurn;
  } else {
    hintText.textContent = WHALE_LINES.idle;
  }
}

function refreshControls(): void {
  soundButton.textContent = settings.soundEnabled ? '音效开' : '音效关';
  soundButton.setAttribute('aria-pressed', String(settings.soundEnabled));

  for (const button of [homeBgmButton, gameBgmButton]) {
    button.textContent = settings.bgmEnabled ? '音乐开' : '音乐关';
    button.setAttribute('aria-pressed', String(settings.bgmEnabled));
  }

  hintButton.classList.toggle('hidden', state.mode !== 'pvai');
  hintButton.textContent = state.hintLoading
    ? '取消提示'
    : state.hint
      ? '收起提示'
      : aiStatus === 'loading'
        ? 'AI 热身中'
        : '提示';
  hintButton.disabled =
    state.mode !== 'pvai' ||
    state.status !== 'playing' ||
    state.thinking ||
    (aiStatus === 'loading' && !state.hintLoading) ||
    (state.current !== state.humanColor && !state.hintLoading);

  undoButton.disabled = state.history.length === 0;
  restartButton.disabled = false;
}

function refreshAll(): void {
  refreshBoard();
  refreshStatus();
  refreshHintPanel();
  refreshControls();
  refreshAiLoadingOverlay();
  updateAiWarmup();
  setMascot(desiredMascot());
  updateDebug();
}

/** 只在“轮到 AI 且模型还没加载完”时，给棋盘盖一层轻遮罩。 */
function refreshAiLoadingOverlay(): void {
  const show =
    state.mode === 'pvai' &&
    state.status === 'playing' &&
    aiStatus === 'loading' &&
    state.current !== state.humanColor;
  boardLoading.classList.toggle('hidden', !show);
}

/** 颜色弹窗里的预热状态；弹窗没打开时直接跳过。 */
function updateAiWarmup(): void {
  const el = document.getElementById('ai-warmup');
  if (!el) return;
  el.dataset.state = aiStatus;
  if (aiStatus === 'loading') {
    el.innerHTML =
      '<span class="spinner" aria-hidden="true"></span><span>AI 正在热身…</span>';
  } else if (aiStatus === 'ready') {
    el.innerHTML =
      '<span class="warmup-icon" aria-hidden="true">✓</span><span>AI 已就绪</span>';
  } else if (aiStatus === 'error') {
    el.innerHTML =
      '<span class="warmup-icon" aria-hidden="true">!</span><span>AI 加载失败，进入对局时会重试</span>';
  } else {
    el.innerHTML =
      '<span class="warmup-icon" aria-hidden="true">·</span><span>AI 准备中…</span>';
  }
}

function desiredMascot(): MascotState {
  if (state.status === 'won') {
    if (state.mode === 'pvai') return state.winner === state.humanColor ? 'happy' : 'worried';
    return 'happy';
  }
  if (state.hintLoading || state.thinking) return 'thinking';
  if (state.hint) return 'happy';
  return 'idle';
}

function applySkin(): void {
  const skin: Skin = getSkin(settings.skin);
  document.documentElement.style.setProperty('--accent', skin.accent);
  document.documentElement.style.setProperty('--accent-soft', skin.accentSoft);
  boardView.setSkin();
  audio.setSkin(settings.soundFollowsSkin ? settings.skin : 'wood');
}

/* ===== AI ===== */

function ensureAi(): Promise<void> {
  if (readyInfo) {
    if (aiStatus !== 'ready') {
      aiStatus = 'ready';
      refreshAll();
    }
    return Promise.resolve();
  }
  if (aiReadyPromise) {
    if (aiStatus !== 'loading') {
      aiStatus = 'loading';
      refreshAll();
    }
    return aiReadyPromise;
  }
  if (!aiClient) aiClient = new AiClient(wasmBase, modelUrl);

  aiStatus = 'loading';
  refreshAll();

  aiReadyPromise = aiClient
    .ensureReady()
    .then((info) => {
      readyInfo = info;
      aiStatus = 'ready';
      updateDebug();
    })
    .catch((error: unknown) => {
      aiStatus = 'error';
      aiClient?.dispose();
      aiClient = null;
      throw error;
    })
    .finally(() => {
      aiReadyPromise = null;
      refreshAll();
    });

  return aiReadyPromise;
}

async function botMove(): Promise<void> {
  if (state.mode !== 'pvai' || state.status !== 'playing') return;
  if (state.current === state.humanColor || state.thinking) return;

  const token = gameToken;

  // 玩家先手时，AI 白棋第一手只做一次 policy 前向，不跑 MCTS。
  if (state.history.length === 1 && state.current === WHITE) {
    const humanMove = state.history[0].move;
    const started = performance.now();
    state.thinking = true;
    setMascot('thinking');
    refreshAll();
    try {
      await ensureAi();
      if (token !== gameToken || state.status !== 'playing') return;
      const client = aiClient;
      if (!client) throw new Error('AI 引擎不可用');
      const evaluation = await client.evaluate(new Uint8Array(state.board), WHITE);
      if (token !== gameToken || state.status !== 'playing') return;
      const move = chooseOpeningResponse(state.board, humanMove, evaluation.policy);
      if (move >= 0) {
        lastSearch = {
          kind: '开局',
          sims: 0,
          ms: Math.round(performance.now() - started),
        };
        state.thinking = false;
        place(move, true);
        return;
      }
    } catch (error) {
      if (token !== gameToken) return;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('取消')) {
        // 模型不可用时退回纯手写公式，保证第一手仍能落子。
        const move = chooseOpeningResponse(state.board, humanMove);
        if (move >= 0) {
          lastSearch = {
            kind: '开局',
            sims: 0,
            ms: Math.round(performance.now() - started),
          };
          state.thinking = false;
          place(move, true);
          return;
        }
      }
    } finally {
      if (token === gameToken) {
        state.thinking = false;
        refreshAll();
      }
    }
  }

  state.thinking = true;
  setMascot('thinking');
  refreshAll();

  const started = performance.now();
  try {
    await ensureAi();
    if (token !== gameToken || state.status !== 'playing') return;
    const client = aiClient;
    if (!client) throw new Error('AI 引擎不可用');
    const player = state.current;
    const snapshot = new Uint8Array(state.board);
    const result = await client.search(snapshot, player, {
      sims: DIFFICULTY_SIMS[settings.difficulty],
      topk: 0,
      temperature: OPPONENT_TEMPERATURE[settings.difficulty],
      sampleTopK: SAMPLE_TOP_K,
      rootNoise: OPPONENT_NOISE[settings.difficulty],
    });
    lastSearch = {
      kind: '对手',
      sims: result.sims,
      ms: Math.round(performance.now() - started),
    };
    if (token !== gameToken || state.status !== 'playing' || state.current !== player) return;
    if (result.move < 0) {
      state.status = 'draw';
      state.winLine = [];
      refreshAll();
      audio.play('draw');
      scheduleResult();
      return;
    }
    state.thinking = false;
    place(result.move, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('取消')) {
      aiStatus = 'error';
      showToast(`AI 思考失败：${message}`);
    }
  } finally {
    if (token === gameToken) {
      state.thinking = false;
      refreshAll();
    }
  }
}

async function requestHint(): Promise<void> {
  if (state.mode !== 'pvai' || state.status !== 'playing') return;
  if (state.current !== state.humanColor) {
    showToast('轮到你的时候才能提示');
    return;
  }

  if (state.hintLoading) {
    cancelHint();
    return;
  }
  if (state.hint) {
    clearHint();
    return;
  }

  const key = `${AI_CONFIG.modelVersion}|${AI_CONFIG.radius}|${AI_CONFIG.hintSims}|${state.current}|${boardKey(state.board, state.current)}`;
  const cached = hintCache.get(key);
  if (cached) {
    cacheHits++;
    hintToken++;
    state.hint = cached;
    state.hintLoading = false;
    setMascot('happy');
    refreshAll();
    audio.play('hint');
    return;
  }

  const token = ++hintToken;
  state.hintLoading = true;
  state.hint = null;
  setMascot('thinking');
  refreshAll();

  const started = performance.now();
  try {
    await ensureAi();
    if (token !== hintToken || state.status !== 'playing') return;
    const client = aiClient;
    if (!client) throw new Error('AI 引擎不可用');
    const player = state.current;
    const snapshot = new Uint8Array(state.board);

    const result = await client.search(snapshot, player, {
      sims: AI_CONFIG.hintSims,
      topk: AI_CONFIG.hintTopK,
    });

    lastSearch = {
      kind: '提示',
      sims: result.sims,
      ms: Math.round(performance.now() - started),
    };

    if (token !== hintToken || result.cancelled) return;
    hintCache.set(key, result);
    state.hint = result;
    state.hintLoading = false;
    setMascot('happy');
    refreshAll();
    audio.play('hint');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('取消')) {
      showToast(`提示失败：${message}`);
    }
  } finally {
    if (token === hintToken) {
      state.hintLoading = false;
      refreshAll();
    }
  }
}

function cancelHint(): void {
  hintToken++;
  aiClient?.cancelAll();
  state.hintLoading = false;
  state.hint = null;
  setMascot('idle');
  refreshAll();
}

function clearHint(): void {
  hintToken++;
  aiClient?.cancelAll();
  state.hint = null;
  state.hintLoading = false;
  refreshAll();
}

/* ===== 对局 ===== */

function place(move: number, byAi = false): void {
  if (state.status !== 'playing') return;
  if (!byAi && !canHumanPlace()) {
    audio.play('invalid');
    return;
  }
  if (!isValidMove(state.board, move)) {
    audio.play('invalid');
    return;
  }

  const player = state.current;
  state.board = placeStone(state.board, move, player);
  state.history.push({ player, move });
  state.lastMove = move;
  state.hint = null;
  state.hintLoading = false;
  hintToken++;
  if (!byAi) aiClient?.cancelAll();

  const win = checkWin(state.board, move);
  if (win !== null) {
    state.status = 'won';
    state.winner = win;
    state.winLine = getWinLine(state.board, move);
    audio.play(
      state.mode === 'pvai' && win !== state.humanColor ? 'lose' : 'win',
    );
    scheduleResult();
  } else if (isBoardFull(state.board)) {
    state.status = 'draw';
    state.winner = null;
    state.winLine = [];
    audio.play('draw');
    scheduleResult();
  } else {
    state.current = player === BLACK ? WHITE : BLACK;
  }

  boardView.animateMove(move);
  refreshAll();
  audio.play('place');

  if (
    state.status === 'playing' &&
    state.mode === 'pvai' &&
    state.current !== state.humanColor &&
    !byAi
  ) {
    void botMove();
  }
}

function scheduleResult(): void {
  window.clearTimeout(resultTimer);
  resultTimer = window.setTimeout(() => {
    if (state.status !== 'playing') showResultModal();
  }, 380);
}

function showResultModal(): void {
  let title = '平局';
  let subtitle = '棋盘满了，再来一局分个胜负？';

  if (state.status === 'won') {
    if (state.mode === 'pvp') {
      title = state.winner === BLACK ? '黑方胜！' : '白方胜！';
      subtitle = '这一局下得不错。';
    } else if (state.winner === state.humanColor) {
      title = '你赢了！';
      subtitle = '大肥鱼认输，再来一局？';
    } else {
      title = '大肥鱼赢了';
      subtitle = '这局被它算到了，再来一局？';
    }
  }

  openModal(`
    <div class="modal">
      <h2 class="result-title">${title}</h2>
      <p class="result-sub">${subtitle}</p>
      <div class="result-actions">
        <button class="btn btn-primary" data-action="restart" type="button">再来一局</button>
        <button class="btn btn-ghost" data-action="home" type="button">返回主菜单</button>
      </div>
    </div>
  `);

  modalRoot.querySelector('[data-action="restart"]')?.addEventListener('click', () => {
    closeModal();
    restartGame();
  });
  modalRoot.querySelector('[data-action="home"]')?.addEventListener('click', () => {
    closeModal();
    goHome();
  });
}

function undo(): void {
  if (state.history.length === 0) return;
  closeModal();
  gameToken++;
  hintToken++;
  aiClient?.cancelAll();
  state.thinking = false;
  state.hint = null;
  state.hintLoading = false;
  state.status = 'playing';
  state.winner = null;
  state.winLine = [];
  window.clearTimeout(resultTimer);

  const steps = state.mode === 'pvai' ? Math.min(2, state.history.length) : 1;
  for (let i = 0; i < steps; i++) {
    const last = state.history.pop();
    if (!last) break;
    state.board[last.move] = 0;
    state.current = last.player;
  }
  state.lastMove = state.history.length
    ? state.history[state.history.length - 1].move
    : null;

  if (state.mode === 'pvai' && state.current !== state.humanColor) {
    if (state.history.length === 0 && state.humanColor === WHITE) {
      place(7 * 15 + 7, true);
    } else {
      void botMove();
    }
  }

  refreshAll();
  audio.play('ui');
}

function restartGame(): void {
  startGame(state.mode, state.humanColor);
}

function startGame(mode: Mode, humanColor: Player): void {
  closeModal();
  gameToken++;
  hintToken++;
  aiClient?.cancelAll();
  state = createGameState(mode, humanColor);
  showScreen('game');
  applySkin();
  refreshAll();
  audio.play('start');

  if (mode === 'pvai') {
    void ensureAi().catch(() => {
      showToast('AI 引擎加载失败，请检查网络后重试');
    });
    if (humanColor === WHITE) {
      place(7 * 15 + 7, true);
    }
  }
}

function goHome(): void {
  closeModal();
  gameToken++;
  hintToken++;
  aiClient?.cancelAll();
  state.thinking = false;
  state.hintLoading = false;
  showScreen('home');
}

function showScreen(screen: 'home' | 'game'): void {
  homeScreen.classList.toggle('hidden', screen !== 'home');
  gameScreen.classList.toggle('hidden', screen !== 'game');
  if (screen === 'game') {
    requestAnimationFrame(() => boardView.resize());
  }
}

/* ===== 弹窗 ===== */

function openColorChoice(): void {
  // 第一次点「人 vs 机」就开始预加载；颜色弹窗不等待模型就绪。
  void ensureAi().catch(() => {
    // 错误会显示在弹窗状态行；进入对局时 ensureAi 会再重试。
  });

  openModal(`
    <div class="modal">
      <h2>你执哪一方？</h2>
      <p>执黑先手；执白后手，大肥鱼会先下天元。</p>
      <div class="color-actions">
        <button class="btn btn-primary" data-color="1" type="button">执黑（先手）</button>
        <button class="btn btn-secondary" data-color="2" type="button">执白（后手）</button>
      </div>
      <p id="ai-warmup" class="ai-warmup" role="status" aria-live="polite"></p>
      <div class="modal-close-row">
        <button class="btn btn-ghost" data-action="close" type="button">取消</button>
      </div>
    </div>
  `);
  updateAiWarmup();

  modalRoot.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((button) => {
    button.addEventListener('click', () => {
      const color = Number(button.dataset.color) === BLACK ? BLACK : WHITE;
      closeModal();
      startGame('pvai', color);
    });
  });
  modalRoot.querySelector('[data-action="close"]')?.addEventListener('click', closeModal);
}

function openSettings(): void {
  const skinCards = SKIN_LIST.map((skin) => {
    const selected = skin.id === settings.skin ? ' selected' : '';
    return `
      <button class="skin-card${selected}" data-skin="${skin.id}" type="button">
        <div class="skin-preview" style="background:linear-gradient(135deg,${skin.boardTop},${skin.boardBottom})">
          <i style="background:${skin.black};border:1px solid ${skin.blackRim}"></i>
          <i style="background:${skin.white};border:1px solid ${skin.whiteRim}"></i>
          <i style="background:${skin.black};border:1px solid ${skin.blackRim}"></i>
        </div>
        <strong>${skin.name}</strong>
        <small>${skin.description}</small>
      </button>`;
  }).join('');

  const difficultyButtons = DIFFICULTY_OPTIONS.map(
    ({ id, label }) => `
      <button class="difficulty-btn" data-difficulty="${id}" aria-pressed="${settings.difficulty === id}" type="button">${label}</button>`,
  ).join('');

  openModal(`
    <div class="modal">
      <h2>设置</h2>
      <p>音效、皮肤与 iOS 播放策略。</p>

      <div class="field">
        <div class="field-label">
          <strong>音效总开关</strong>
          <small>关闭后所有事件音效静音。</small>
        </div>
        <button class="switch" id="set-sound" aria-pressed="${settings.soundEnabled}" type="button"></button>
      </div>

      <div class="field">
        <div class="field-label">
          <strong>音量</strong>
          <small>${Math.round(settings.volume * 100)}%</small>
        </div>
        <input id="set-volume" type="range" min="0" max="100" value="${Math.round(settings.volume * 100)}" />
      </div>

      <div class="field">
        <div class="field-label">
          <strong>AI 难度</strong>
          <small>简单 / 普通 / 困难，影响大肥鱼落子强度。</small>
        </div>
        <div class="difficulty-group" role="group" aria-label="AI 难度">
          ${difficultyButtons}
        </div>
      </div>

      <div class="field">
        <div class="field-label">
          <strong>音效跟随皮肤</strong>
          <small>默认关闭；开启后换皮肤会换落子音色。</small>
        </div>
        <button class="switch" id="set-follow" aria-pressed="${settings.soundFollowsSkin}" type="button"></button>
      </div>

      <div class="field">
        <div class="field-label">
          <strong>iOS 静音开关下仍播放</strong>
          <small>会接管系统音频，可能暂停你正在播放的音乐。</small>
        </div>
        <button class="switch" id="set-ios" aria-pressed="${settings.iosForceSound}" type="button"></button>
      </div>

      <h3 class="section-title">棋子皮肤</h3>
      <div class="skin-grid">${skinCards}</div>

      <div class="modal-close-row">
        <button class="btn btn-ghost" data-action="close" type="button">关闭</button>
      </div>
    </div>
  `);

  const toggle = (id: string, key: 'soundEnabled' | 'soundFollowsSkin' | 'iosForceSound') => {
    const button = modalRoot.querySelector<HTMLButtonElement>(`#${id}`);
    button?.addEventListener('click', () => {
      settings[key] = !settings[key];
      button.setAttribute('aria-pressed', String(settings[key]));
      saveSettings(settings);
      if (key === 'soundEnabled') {
        audio.setEnabled(settings.soundEnabled);
        if (settings.soundEnabled) audio.play('ui');
      } else if (key === 'soundFollowsSkin') {
        audio.setSkin(settings.soundFollowsSkin ? settings.skin : 'wood');
        audio.play('ui');
      } else {
        audio.setIosForce(settings.iosForceSound);
        audio.play('ui');
      }
      refreshControls();
    });
  };

  toggle('set-sound', 'soundEnabled');
  toggle('set-follow', 'soundFollowsSkin');
  toggle('set-ios', 'iosForceSound');

  const volume = modalRoot.querySelector<HTMLInputElement>('#set-volume');
  volume?.addEventListener('input', () => {
    settings.volume = Number(volume.value) / 100;
    saveSettings(settings);
    audio.setVolume(settings.volume);
    const small = volume.parentElement?.querySelector('small');
    if (small) small.textContent = `${Math.round(settings.volume * 100)}%`;
  });

  modalRoot.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((button) => {
    button.addEventListener('click', () => {
      const level = button.dataset.difficulty as AiDifficulty | undefined;
      if (!level) return;
      settings.difficulty = level;
      saveSettings(settings);
      modalRoot.querySelectorAll('.difficulty-btn').forEach((item) => {
        item.setAttribute('aria-pressed', String(item === button));
      });
    });
  });

  modalRoot.querySelectorAll<HTMLButtonElement>('[data-skin]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.skin;
      if (!id) return;
      settings.skin = getSkin(id).id;
      saveSettings(settings);
      modalRoot
        .querySelectorAll('.skin-card')
        .forEach((card) => card.classList.toggle('selected', card === button));
      applySkin();
      refreshBoard();
      audio.play('ui');
    });
  });

  modalRoot.querySelector('[data-action="close"]')?.addEventListener('click', closeModal);
}

function openAbout(): void {
  openModal(`
    <div class="modal">
      <h2>关于 / 署名</h2>
      <p>
        头像素材来自 DeepSeek 相关二创社区（“蓝色大肥鱼 / 鲸鱼娘”同人图），如有侵权请联系删除。
        背景音乐使用 B 站《Let me go 大肥鱼和用户深情对唱》（UP 主 @星落落_oi，BV13SYr6dEiQ），版权归原作者所有，如有侵权请联系删除。
      </p>

      <div class="about-section">
        <h3>技术与素材</h3>
        <ul>
          <li>桌面版 v2 模型与代码：MIT，Copyright (c) 2026 dayanzaiHappy</li>
          <li>棋盘、棋子、图标由 Canvas/SVG 生成，音效由 Web Audio 合成</li>
        </ul>
      </div>

      <p>“蓝色大肥鱼”是 DeepSeek 鲸鱼娘的社区昵称，本项目与 DeepSeek 官方无关。</p>

      <div class="modal-close-row">
        <button class="btn btn-ghost" data-action="close" type="button">关闭</button>
      </div>
    </div>
  `);
  modalRoot.querySelector('[data-action="close"]')?.addEventListener('click', closeModal);
}

/* ===== 音效与事件 ===== */

function toggleSound(): void {
  settings.soundEnabled = !settings.soundEnabled;
  saveSettings(settings);
  audio.setEnabled(settings.soundEnabled);
  if (settings.soundEnabled) audio.play('ui');
  refreshControls();
}

function toggleBgm(): void {
  settings.bgmEnabled = !settings.bgmEnabled;
  saveSettings(settings);
  bgm.setEnabled(settings.bgmEnabled);
  if (settings.bgmEnabled) void bgm.unlock();
  refreshControls();
  updateDebug();
}

function updateDebug(): void {
  if (!debugEl) return;
  debugEl.textContent = [
    'DaFeiYuGomo debug',
    `AI: ${aiStatus}${readyInfo ? ` (${readyInfo.backend}, ${readyInfo.threads} 线程)` : ''}`,
    readyInfo ? `load ${readyInfo.loadMs}ms · eval ${readyInfo.evalMs}ms · model ${(readyInfo.modelBytes / 1048576).toFixed(1)}MB` : 'model: -',
    `last: ${lastSearch.kind} · ${lastSearch.sims} sims · ${lastSearch.ms}ms`,
    `cache hits: ${cacheHits}`,
    `size: ${state.board.length} cells`,
    `mode=${state.mode} history=${state.history.length} current=${state.current} hint=${state.hint ? shortCoord(state.hint.move) : '-'} loading=${state.hintLoading}`,
    audio.debugInfo(),
    bgm.debugInfo(),
    boardView.debugInfo(),
  ].join('\n');
}

let debugEl: HTMLPreElement | null = null;
if (new URLSearchParams(location.search).has('debug')) {
  debugEl = document.createElement('pre');
  debugEl.className = 'debug-panel';
  document.body.appendChild(debugEl);
  window.setInterval(updateDebug, 1000);
}

homeMascot.innerHTML = '';
mascotAvatar.innerHTML = '';
installMascots();
applySkin();
refreshAll();

const unlockAudio = () => {
  void audio.unlock();
  void bgm.unlock();
};
document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
document.addEventListener('keydown', unlockAudio, { once: true, capture: true });

document.addEventListener('click', (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest('button')) {
    audio.play('ui');
  }
  if (settings.bgmEnabled) void bgm.unlock();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    audio.suspend();
    bgm.suspend();
  } else {
    bgm.resumeIfEnabled();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeModal();
    return;
  }
  if (gameScreen.classList.contains('hidden')) return;
  if (event.target instanceof HTMLInputElement) return;

  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'z') {
    event.preventDefault();
    undo();
  } else if (!event.ctrlKey && !event.metaKey && key === 'h') {
    event.preventDefault();
    void requestHint();
  }
});

$('start-pvp').addEventListener('click', () => startGame('pvp', BLACK));
$('start-pvai').addEventListener('click', openColorChoice);
$('home-settings').addEventListener('click', openSettings);
$('home-about').addEventListener('click', openAbout);
$('game-settings').addEventListener('click', openSettings);
$('game-back').addEventListener('click', goHome);
soundButton.addEventListener('click', toggleSound);
homeBgmButton.addEventListener('click', toggleBgm);
gameBgmButton.addEventListener('click', toggleBgm);
hintButton.addEventListener('click', () => {
  if (state.hintLoading) {
    cancelHint();
  } else if (state.hint) {
    clearHint();
  } else {
    void requestHint();
  }
});
undoButton.addEventListener('click', undo);
restartButton.addEventListener('click', restartGame);
