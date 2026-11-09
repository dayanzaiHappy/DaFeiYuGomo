import { colOf, inBounds, rowOf } from '../game/board';
import type { BoardState, Player } from '../game/types';
import { BLACK, EMPTY, SIZE } from '../game/types';
import type { Skin } from './skins';

export interface BoardHint {
  move: number;
  top: Array<{ move: number; value: number }>;
}

export interface BoardViewState {
  board: BoardState;
  lastMove: number | null;
  hint: BoardHint | null;
  winLine: number[];
  interactive: boolean;
}

export interface BoardViewOptions {
  onPlace: (move: number) => void;
  getSkin: () => Skin;
  onDebug?: () => void;
}

const STAR_POINTS = [
  [3, 3],
  [3, 11],
  [7, 7],
  [11, 3],
  [11, 11],
] as const;

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export class BoardView {
  private ctx: CanvasRenderingContext2D;
  private state: BoardViewState = {
    board: new Uint8Array(SIZE * SIZE),
    lastMove: null,
    hint: null,
    winLine: [],
    interactive: false,
  };
  private size = 0;
  private dpr = 1;
  private padding = 0;
  private cell = 0;
  private readonly options: BoardViewOptions;
  private bgCache: HTMLCanvasElement | null = null;
  private bgCacheKey = '';
  private raf = 0;
  private anim: { move: number; start: number } | null = null;
  private cursor = { row: 7, col: 7 };
  private focused = false;
  private lastPointer = '-';
  private lastPointerPlaceAt = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly container: HTMLElement,
    options: BoardViewOptions,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 Canvas 上下文');
    this.ctx = ctx;
    this.options = options;

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('click', this.onClick);
    canvas.addEventListener('keydown', this.onKeyDown);
    canvas.addEventListener('focus', () => {
      this.focused = true;
      this.render();
    });
    canvas.addEventListener('blur', () => {
      this.focused = false;
      this.render();
    });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    const observer = new ResizeObserver(() => this.resize());
    observer.observe(container);
    window.addEventListener('resize', this.resize);
  }

  setState(state: BoardViewState): void {
    this.state = state;
    this.render();
  }

  setSkin(): void {
    this.bgCache = null;
    this.bgCacheKey = '';
    this.render();
  }

  debugInfo(): string {
    return `board=${this.size}px dpr=${this.dpr} interactive=${this.state.interactive} last=${this.lastPointer}`;
  }

  animateMove(move: number): void {
    this.anim = { move, start: performance.now() };
    this.scheduleAnimation();
  }

  resize = (): void => {
    const rect = this.container.getBoundingClientRect();
    const size = Math.max(0, Math.floor(Math.min(rect.width, rect.height)));
    if (size === this.size && this.dpr === Math.min(3, window.devicePixelRatio || 1)) {
      return;
    }
    this.size = size;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    if (size < 40) return;

    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.canvas.width = Math.round(size * this.dpr);
    this.canvas.height = Math.round(size * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.padding = size * 0.055;
    this.cell = (size - this.padding * 2) / (SIZE - 1);
    this.bgCache = null;
    this.bgCacheKey = '';
    this.render();
  };

  render = (): void => {
    if (this.size < 40) return;
    const ctx = this.ctx;
    const size = this.size;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const skin = this.options.getSkin();
    const cache = this.getBackground(skin);
    ctx.drawImage(cache, 0, 0, size, size);

    this.drawGrid(skin);
    this.drawStones(skin);
    this.drawLastMove(skin);
    this.drawHint(skin);
    this.drawWinLine(skin);
    this.drawFocusCursor(skin);
  };

  private getBackground(skin: Skin): HTMLCanvasElement {
    const key = `${skin.id}:${this.size}:${this.dpr}`;
    if (this.bgCache && this.bgCacheKey === key) return this.bgCache;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(this.size * this.dpr);
    canvas.height = Math.round(this.size * this.dpr);
    const g = canvas.getContext('2d');
    if (!g) throw new Error('无法创建棋盘背景缓存');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.paintBackground(g, skin);

    this.bgCache = canvas;
    this.bgCacheKey = key;
    return canvas;
  }

  private paintBackground(ctx: CanvasRenderingContext2D, skin: Skin): void {
    const size = this.size;
    ctx.save();
    roundedRect(ctx, 0, 0, size, size, size * 0.035);
    ctx.clip();

    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, skin.boardTop);
    gradient.addColorStop(1, skin.boardBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const light = ctx.createRadialGradient(
      size * 0.22,
      size * 0.16,
      size * 0.04,
      size * 0.22,
      size * 0.16,
      size * 0.95,
    );
    light.addColorStop(0, 'rgba(255,255,255,0.20)');
    light.addColorStop(0.45, 'rgba(255,255,255,0.04)');
    light.addColorStop(1, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, size, size);

    if (skin.id === 'wood') {
      ctx.globalAlpha = 0.1;
      ctx.strokeStyle = '#5a3a12';
      for (let i = 0; i < 22; i++) {
        ctx.beginPath();
        const y = (i / 21) * size;
        ctx.moveTo(-size * 0.05, y);
        for (let x = 0; x <= size; x += size / 12) {
          const offset = Math.sin((x / size) * Math.PI * 6 + i * 1.7) * size * 0.012;
          ctx.lineTo(x, y + offset);
        }
        ctx.lineWidth = 0.6 + (i % 3) * 0.35;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (skin.id === 'jade') {
      for (let i = 0; i < 8; i++) {
        const cx = size * (0.15 + ((i * 37) % 70) / 100);
        const cy = size * (0.15 + ((i * 53) % 70) / 100);
        const r = size * (0.12 + (i % 4) * 0.03);
        const cloud = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        cloud.addColorStop(0, 'rgba(255,255,255,0.22)');
        cloud.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = cloud;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (skin.id === 'obsidian') {
      ctx.globalAlpha = 0.14;
      ctx.strokeStyle = skin.grid;
      for (let i = -4; i < 16; i++) {
        ctx.beginPath();
        ctx.moveTo((i / 12) * size, 0);
        ctx.lineTo((i / 12) * size + size * 0.5, size);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (skin.id === 'neon') {
      const glow = ctx.createRadialGradient(
        size * 0.5,
        size * 0.45,
        0,
        size * 0.5,
        size * 0.45,
        size * 0.7,
      );
      glow.addColorStop(0, 'rgba(51,214,255,0.18)');
      glow.addColorStop(0.5, 'rgba(89,80,255,0.08)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);
    }

    ctx.restore();

    ctx.save();
    roundedRect(ctx, 0.5, 0.5, size - 1, size - 1, size * 0.035);
    ctx.strokeStyle = skin.boardEdge;
    ctx.lineWidth = Math.max(1, size * 0.004);
    ctx.stroke();
    ctx.restore();
  }

  private drawGrid(skin: Skin): void {
    const ctx = this.ctx;
    const start = this.padding;
    const end = this.size - this.padding;

    ctx.save();
    ctx.strokeStyle = skin.grid;
    ctx.globalAlpha = skin.id === 'neon' ? 0.75 : 0.82;
    ctx.lineWidth = Math.max(1, this.size / 620);
    if (skin.glow) {
      ctx.shadowColor = skin.grid;
      ctx.shadowBlur = this.size * 0.008;
    }
    for (let i = 0; i < SIZE; i++) {
      const p = this.padding + i * this.cell;
      ctx.beginPath();
      ctx.moveTo(start, p);
      ctx.lineTo(end, p);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p, start);
      ctx.lineTo(p, end);
      ctx.stroke();
    }

    ctx.fillStyle = skin.star;
    for (const [row, col] of STAR_POINTS) {
      ctx.beginPath();
      ctx.arc(
        this.padding + col * this.cell,
        this.padding + row * this.cell,
        Math.max(2, this.cell * 0.075),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.restore();
  }

  private drawStones(skin: Skin): void {
    const board = this.state.board;
    for (let move = 0; move < board.length; move++) {
      const player = board[move];
      if (player === EMPTY) continue;
      this.drawStone(skin, move, player as Player, this.stoneScale(move));
    }
  }

  private stoneScale(move: number): number {
    if (!this.anim || this.anim.move !== move) return 1;
    const t = Math.min(1, (performance.now() - this.anim.start) / 160);
    return 0.55 + 0.45 * (1 - Math.pow(1 - t, 3));
  }

  private drawStone(skin: Skin, move: number, player: Player, scale: number): void {
    const ctx = this.ctx;
    const x = this.padding + colOf(move) * this.cell;
    const y = this.padding + rowOf(move) * this.cell;
    const r = this.cell * 0.43 * scale;
    if (r <= 0) return;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.32)';
    ctx.shadowBlur = this.cell * 0.14;
    ctx.shadowOffsetY = this.cell * 0.05;

    const isBlack = player === BLACK;
    const base = isBlack ? skin.black : skin.white;
    const hi = isBlack ? skin.blackHi : skin.whiteHi;
    const rim = isBlack ? skin.blackRim : skin.whiteRim;

    if (skin.glow) {
      ctx.shadowColor = isBlack ? skin.blackRim : skin.whiteRim;
      ctx.shadowBlur = this.cell * 0.2;
    }

    const gradient = ctx.createRadialGradient(
      x - r * 0.38,
      y - r * 0.42,
      r * 0.08,
      x,
      y,
      r * 1.12,
    );
    gradient.addColorStop(0, hi);
    gradient.addColorStop(0.42, base);
    gradient.addColorStop(1, base);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = rim;
    ctx.lineWidth = Math.max(1, this.cell * 0.025);
    ctx.beginPath();
    ctx.arc(x, y, r - ctx.lineWidth * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    if (isBlack) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x - r * 0.34, y - r * 0.38, r * 0.16, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.globalAlpha = 0.65;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x - r * 0.32, y - r * 0.36, r * 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawLastMove(skin: Skin): void {
    const last = this.state.lastMove;
    if (last === null || last < 0) return;
    const x = this.padding + colOf(last) * this.cell;
    const y = this.padding + rowOf(last) * this.cell;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = skin.lastMove;
    ctx.shadowColor = skin.lastMove;
    ctx.shadowBlur = this.cell * 0.16;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2.2, this.cell * 0.1), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawHint(skin: Skin): void {
    const hint = this.state.hint;
    if (!hint) return;
    const ctx = this.ctx;
    const candidates = hint.top;

    // 从末位往前画，保证第 1 名最后绘制、编号与 top 顺序一致。
    for (let i = candidates.length - 1; i >= 0; i--) {
      const item = candidates[i];
      if (!inBounds(rowOf(item.move), colOf(item.move))) continue;
      if (this.state.board[item.move] !== EMPTY) continue;
      const x = this.padding + colOf(item.move) * this.cell;
      const y = this.padding + rowOf(item.move) * this.cell;
      const r = this.cell * 0.4;

      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = skin.hintCandidate;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = skin.hintCandidate;
      ctx.lineWidth = Math.max(1, this.cell * 0.025);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = skin.hintText;
      ctx.font = `700 ${Math.max(9, this.cell * 0.34)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + this.cell * 0.01);
      ctx.restore();
    }

    const best = hint.move;
    if (best < 0) return;
    const x = this.padding + colOf(best) * this.cell;
    const y = this.padding + rowOf(best) * this.cell;
    ctx.save();
    ctx.strokeStyle = skin.hintBest;
    ctx.lineWidth = Math.max(2, this.cell * 0.055);
    ctx.shadowColor = skin.hintBest;
    ctx.shadowBlur = this.cell * 0.18;
    ctx.beginPath();
    ctx.arc(x, y, this.cell * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.arc(x, y, this.cell * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawWinLine(skin: Skin): void {
    const line = this.state.winLine;
    if (line.length < 5) return;
    const ctx = this.ctx;
    const first = line[0];
    const last = line[line.length - 1];
    const x1 = this.padding + colOf(first) * this.cell;
    const y1 = this.padding + rowOf(first) * this.cell;
    const x2 = this.padding + colOf(last) * this.cell;
    const y2 = this.padding + rowOf(last) * this.cell;

    ctx.save();
    ctx.strokeStyle = skin.lastMove;
    ctx.lineWidth = Math.max(3, this.cell * 0.1);
    ctx.lineCap = 'round';
    ctx.shadowColor = skin.lastMove;
    ctx.shadowBlur = this.cell * 0.25;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  private drawFocusCursor(skin: Skin): void {
    if (!this.focused || !this.state.interactive) return;
    const x = this.padding + this.cursor.col * this.cell;
    const y = this.padding + this.cursor.row * this.cell;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = skin.hintBest;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x - this.cell * 0.28, y - this.cell * 0.28, this.cell * 0.56, this.cell * 0.56);
    ctx.restore();
  }

  private scheduleAnimation(): void {
    if (this.raf) return;
    const tick = () => {
      this.render();
      if (this.anim && performance.now() - this.anim.start < 170) {
        this.raf = requestAnimationFrame(tick);
      } else {
        this.anim = null;
        this.raf = 0;
        this.render();
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.lastPointer = `down ${Math.round(event.clientX)},${Math.round(event.clientY)} primary=${event.isPrimary} type=${event.pointerType}`;
    this.options.onDebug?.();
    if (!this.state.interactive) {
      this.lastPointer += ' not-interactive';
      this.options.onDebug?.();
      return;
    }
    if (!event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    this.canvas.focus();
    const move = this.hitTest(event.clientX, event.clientY);
    this.lastPointer += ` hit=${move}`;
    this.options.onDebug?.();
    if (move !== null) {
      this.lastPointerPlaceAt = performance.now();
      this.options.onPlace(move);
    }
  };

  private onClick = (event: MouseEvent): void => {
    this.lastPointer = `click ${Math.round(event.clientX)},${Math.round(event.clientY)}`;
    this.options.onDebug?.();
    if (!this.state.interactive) {
      this.lastPointer += ' not-interactive';
      this.options.onDebug?.();
      return;
    }
    // 已经由 pointerdown 处理过，避免鼠标/触控双触发。
    if (performance.now() - this.lastPointerPlaceAt < 500) return;
    event.preventDefault();
    this.canvas.focus();
    const move = this.hitTest(event.clientX, event.clientY);
    this.lastPointer += ` hit=${move}`;
    this.options.onDebug?.();
    if (move !== null) {
      this.lastPointerPlaceAt = performance.now();
      this.options.onPlace(move);
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    this.lastPointer = `key ${event.key}`;
    if (!this.state.interactive) {
      this.lastPointer += ' not-interactive';
      this.options.onDebug?.();
      return;
    }
    const key = event.key;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(key)) {
      return;
    }
    event.preventDefault();
    if (key === 'ArrowUp') this.cursor.row = Math.max(0, this.cursor.row - 1);
    else if (key === 'ArrowDown') this.cursor.row = Math.min(SIZE - 1, this.cursor.row + 1);
    else if (key === 'ArrowLeft') this.cursor.col = Math.max(0, this.cursor.col - 1);
    else if (key === 'ArrowRight') this.cursor.col = Math.min(SIZE - 1, this.cursor.col + 1);
    else {
      const move = this.cursor.row * SIZE + this.cursor.col;
      if (this.state.board[move] === EMPTY) this.options.onPlace(move);
      return;
    }
    this.render();
  };

  hitTest(clientX: number, clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = ((clientX - rect.left) / rect.width) * this.size;
    const y = ((clientY - rect.top) / rect.height) * this.size;
    const col = Math.round((x - this.padding) / this.cell);
    const row = Math.round((y - this.padding) / this.cell);
    if (!inBounds(row, col)) return null;
    const cx = this.padding + col * this.cell;
    const cy = this.padding + row * this.cell;
    if (Math.hypot(x - cx, y - cy) > this.cell * 0.72) return null;
    return row * SIZE + col;
  }
}
