import type { ReviewController } from '../app/review';
import { DIFFICULTY_LABELS } from '../game/ai-config';
import { getWinLine, shortCoord } from '../game/board';
import { COACH_VERDICTS } from '../game/coach';
import {
  correctedBoard,
  scoreOf,
  summarizeReview,
  type MoveGrade,
  type ReviewSummary,
} from '../game/review';
import { WHALE_LINES } from '../content/whale-lines';
import { BoardView, type BoardViewState } from '../render/board-view';
import type { Skin } from '../render/skins';
import { BLACK, type Player } from '../game/types';

/**
 * 复盘屏。
 *
 * 三件事刻意分开：
 * - 棋盘只读，用第二块 BoardView，不碰对局里的那一块；
 * - 曲线是 canvas 自绘，不引图表库；
 * - 回放只是改 `index`，所有渲染都由它派生，避免「棋盘和列表不同步」。
 */

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少页面元素 #${id}`);
  return node as T;
};

const COLORS = {
  human: '#57b6ff',
  rival: '#b79cff',
  curve: 'rgba(120, 200, 255, 0.95)',
  grid: 'rgba(160, 190, 235, 0.14)',
  axis: 'rgba(159, 176, 201, 0.72)',
  cursor: 'rgba(255, 255, 255, 0.16)',
  hover: 'rgba(255, 255, 255, 0.38)',
};

const GRADE_COLORS: Record<MoveGrade, string> = {
  best: '#f0b95a',
  good: '#8fe3b0',
  inaccuracy: '#e8c56a',
  mistake: '#f0a35a',
  blunder: '#ff6b6b',
};

const percent = (value: number | null): string =>
  value === null ? '—' : `${Math.round(value * 100)}%`;

function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `约 ${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `约 ${minutes} 分钟` : `约 ${minutes} 分 ${rest} 秒`;
}

interface RowRefs {
  row: HTMLLIElement;
  badge: HTMLSpanElement;
  tags: HTMLSpanElement;
}

export interface ReviewViewOptions {
  getSkin: () => Skin;
  onBack: () => void;
  onFast: () => void;
  onDeep: () => void;
  onStop: () => void;
  onExport: () => void;
}

export class ReviewView {
  private readonly screen = el('review-screen');
  private readonly backButton = el<HTMLButtonElement>('review-back');
  private readonly titleEl = el('review-title');
  private readonly statusEl = el('review-status');
  private readonly summaryEl = el('review-summary');
  private readonly detailEl = el('review-detail');
  private readonly listEl = el<HTMLOListElement>('review-list');
  private readonly tooltipEl = el('review-tooltip');
  private readonly chartWrap = el('review-chart-wrap');
  private readonly chart = el<HTMLCanvasElement>('review-chart');
  private readonly progressEl = el('review-progress');
  private readonly progressBar = el('review-progress-bar');
  private readonly playButton = el<HTMLButtonElement>('review-play');
  private readonly speedButton = el<HTMLButtonElement>('review-speed');
  private readonly fastButton = el<HTMLButtonElement>('review-fast');
  private readonly deepButton = el<HTMLButtonElement>('review-deep');
  private readonly stopButton = el<HTMLButtonElement>('review-stop');
  private readonly exportButton = el<HTMLButtonElement>('review-export');
  private readonly board: BoardView;

  private controller: ReviewController | null = null;
  private index = 0;
  private hoverIndex: number | null = null;
  private viewSide: 'human' | 'rival' = 'human';
  private playing = false;
  private timer = 0;
  private speed = 1;
  private evalMs = 45;
  private rows: RowRefs[] = [];
  /** 「正确着法」预览：把 from 收回、to 落下；只改渲染，不改 controller。 */
  private correction: { from: number; to: number; player: Player } | null = null;
  private correctionTimer = 0;
  private correcting = false;

  constructor(options: ReviewViewOptions) {
    this.board = new BoardView(el<HTMLCanvasElement>('review-canvas'), el('review-board-wrap'), {
      onPlace: () => {},
      getSkin: options.getSkin,
    });

    this.backButton.addEventListener('click', () => options.onBack());    this.fastButton.addEventListener('click', () => options.onFast());
    this.deepButton.addEventListener('click', () => options.onDeep());
    this.stopButton.addEventListener('click', () => options.onStop());
    this.exportButton.addEventListener('click', () => options.onExport());

    el('review-first').addEventListener('click', () => this.seek(0));
    el('review-prev').addEventListener('click', () => this.step(-1));
    el('review-next').addEventListener('click', () => this.step(1));
    el('review-last').addEventListener('click', () => this.seek(this.controller?.total ?? 0));
    this.playButton.addEventListener('click', () =>
      this.playing ? this.pause() : this.startPlayback(),
    );
    this.speedButton.addEventListener('click', () => this.cycleSpeed());

    el('review-side-toggle')
      .querySelectorAll<HTMLButtonElement>('[data-side]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          this.viewSide = button.dataset.side === 'rival' ? 'rival' : 'human';
          el('review-side-toggle')
            .querySelectorAll<HTMLButtonElement>('[data-side]')
            .forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
          this.drawChart();
        });
      });

    this.chart.addEventListener('pointermove', this.onChartMove);
    this.chart.addEventListener('pointerleave', this.onChartLeave);
    this.chart.addEventListener('pointerdown', this.onChartDown);

    this.detailEl.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('[data-action="correct"]')) this.playCorrection();
      else if (target.closest('[data-action="restore"]')) this.restoreBoard();
    });

    new ResizeObserver(() => this.drawChart()).observe(this.chartWrap);

    document.addEventListener('keydown', this.onKeyDown);
  }

  open(controller: ReviewController, evalMs: number): void {
    this.pause();
    this.controller?.dispose();
    this.clearCorrection();
    this.controller = controller;
    this.evalMs = evalMs > 0 ? evalMs : 45;
    this.index = controller.total;
    this.viewSide = 'human';
    this.hoverIndex = null;
    this.hideTooltip();
    this.backButton.textContent = controller.source === 'imported' ? '返回首页' : '返回对局';
    el('review-side-toggle')
      .querySelectorAll<HTMLButtonElement>('[data-side]')
      .forEach((item) => item.setAttribute('aria-pressed', String(item.dataset.side === 'human')));
    this.buildList();
    this.refresh();
    // 屏幕刚显示时容器尺寸还是 0，等一帧再量
    requestAnimationFrame(() => {
      this.board.resize();
      this.drawChart();
    });
  }

  /** 关屏：停播、释放控制器、清空列表引用。 */
  close(): void {
    this.pause();
    this.clearCorrection();
    this.controller?.dispose();
    this.controller = null;
    this.rows = [];
    this.listEl.innerHTML = '';
    this.hoverIndex = null;
    this.hideTooltip();
  }

  /** 模型就绪后更新单次推理耗时，用于深评 ETA。 */
  setEvalMs(evalMs: number): void {
    if (evalMs > 0) this.evalMs = evalMs;
    if (this.controller) this.renderStatus();
  }

  resize(): void {
    this.board.resize();
    this.drawChart();
  }

  refresh(): void {
    if (!this.controller) return;
    this.renderTitle();
    this.renderSummary();
    this.renderStatus();
    this.refreshControls();
    this.updateRows();
    this.renderDetail();
    this.renderBoard();
    this.drawChart();
  }

  private renderTitle(): void {
    const controller = this.controller;
    if (!controller) return;
    const { humanColor, difficulty, winner } = controller.snapshot;
    const result =
      winner === null ? '平局' : winner === humanColor ? '你赢了' : '对手胜';
    const prefix = controller.source === 'imported' ? '导入复盘' : '复盘';
    this.titleEl.textContent = `${prefix} · 你执${humanColor === BLACK ? '黑' : '白'} · ${DIFFICULTY_LABELS[difficulty]} · ${result}`;
  }

  private renderSummary(): void {
    const controller = this.controller;
    if (!controller) return;
    const you = summarizeReview(controller.moves, true);
    const rival = summarizeReview(controller.moves, false);
    this.summaryEl.innerHTML = [this.sideCard('你', you), this.sideCard('对手', rival)].join('');
  }

  private sideCard(label: string, summary: ReviewSummary): string {
    const score = scoreOf(summary);
    const total = summary.moves + summary.opening;
    const head = `<div class="review-side-head"><span><strong>${label}</strong> ${total} 手</span>${
      score === null ? '' : `<span class="review-side-score">${score}</span>`
    }</div>`;
    const openingNote = summary.opening > 0 ? ` · 开局 ${summary.opening} 手不计` : '';

    if (summary.graded === 0) {
      return `<div class="review-side">${head}<div class="review-side-loss">还没评级${openingNote}</div></div>`;
    }

    const counts = `最佳 ${summary.best} · 尚可 ${summary.good} · 不精确 ${summary.inaccuracy} · 失误 ${summary.mistake} · 败着 ${summary.blunder}`;
    const tags = COACH_VERDICTS.filter((verdict) => summary.tags[verdict] > 0)
      .map((verdict) => `${WHALE_LINES.reviewTags[verdict]} ${summary.tags[verdict]}`)
      .join(' · ');
    return `<div class="review-side">${head}
      <div class="review-side-counts">${counts}</div>
      <div class="review-side-loss">平均损失 ${((summary.meanLoss ?? 0) * 100).toFixed(1)}%${openingNote}</div>
      ${tags ? `<div class="review-side-loss">${tags}</div>` : ''}
    </div>`;
  }

  private renderStatus(): void {
    const controller = this.controller;
    if (!controller) return;
    const total = controller.total;
    const ratio = total > 0 ? controller.done / total : 0;
    this.progressEl.classList.toggle('hidden', !controller.busy);
    this.progressEl.setAttribute('aria-valuenow', String(controller.done));
    this.progressEl.setAttribute('aria-valuemax', String(total));
    this.progressBar.style.width = `${Math.round(ratio * 100)}%`;

    if (controller.source === 'imported') {
      this.progressEl.classList.add('hidden');
      this.statusEl.className = 'status-pill';
      this.statusEl.textContent =
        controller.mode === 'deep' ? '导入 · 深度搜索' : '导入 · 网络估值';
      return;
    }

    if (controller.busy && controller.mode === 'fast') {
      this.statusEl.textContent = `简易 ${controller.done}/${total}`;
      this.statusEl.className = 'status-pill thinking';
      return;
    }
    if (controller.busy) {
      const eta = controller.done >= total ? '' : ` · ${duration(controller.remainingSeconds(this.evalMs))}`;
      this.statusEl.textContent = `深评 ${controller.done}/${total}${eta}`;
      this.statusEl.className = 'status-pill thinking';
      return;
    }
    this.statusEl.className = 'status-pill';
    if (controller.mode === null) {
      this.statusEl.textContent = '未评估';
    } else if (controller.done >= total) {
      this.statusEl.textContent = controller.mode === 'deep' ? '深度搜索' : '网络估值';
    } else {
      this.statusEl.textContent = `已停止 ${controller.done}/${total}`;
    }
  }

  private refreshControls(): void {
    const controller = this.controller;
    const busy = controller?.busy ?? false;
    const imported = controller?.source === 'imported';
    this.fastButton.disabled = busy || !controller || imported;
    this.deepButton.disabled = busy || !controller || imported;
    this.stopButton.classList.toggle('hidden', !busy);
    this.exportButton.disabled = !controller || controller.moves.length === 0 || imported;
    this.playButton.disabled = !controller || controller.total === 0;
  }

  private buildList(): void {
    const controller = this.controller;
    this.listEl.innerHTML = '';
    this.rows = [];
    if (!controller) return;

    for (const move of controller.moves) {
      const row = document.createElement('li');
      row.className = 'review-row';
      row.dataset.index = String(move.ply);

      const ply = document.createElement('span');
      ply.className = 'review-ply';
      ply.textContent = String(move.ply);

      const coord = document.createElement('span');
      coord.className = 'review-coord';
      coord.textContent = shortCoord(move.move);

      const owner = document.createElement('span');
      owner.className = 'review-owner';
      owner.textContent = move.human ? '你' : '对手';

      const badge = document.createElement('span');
      badge.className = 'review-badge';

      const tags = document.createElement('span');
      tags.className = 'review-row-tags';

      row.append(ply, coord, owner, badge, tags);
      row.addEventListener('click', () => this.seek(move.ply));
      this.listEl.appendChild(row);
      this.rows.push({ row, badge, tags });
    }
  }

  private updateRows(): void {
    const controller = this.controller;
    if (!controller) return;
    if (this.rows.length !== controller.moves.length) this.buildList();

    controller.moves.forEach((move, i) => {
      const refs = this.rows[i];
      if (!refs) return;
      if (move.grade) {
        refs.badge.className = `review-badge grade-${move.grade}`;
        refs.badge.textContent = WHALE_LINES.reviewGrades[move.grade];
      } else if (move.opening) {
        refs.badge.className = 'review-badge grade-opening';
        refs.badge.textContent = WHALE_LINES.reviewOpening;
      } else {
        refs.badge.className = 'review-badge';
        refs.badge.textContent = move.status === 'pending' ? '' : '未评级';
      }
      refs.tags.textContent = move.tags.map((verdict) => WHALE_LINES.reviewTags[verdict]).join(' ');
      refs.row.classList.toggle('current', move.ply === this.index);
    });

    const current = this.rows[this.index - 1];
    if (current) {
      const list = this.listEl;
      const top = current.row.offsetTop;
      const bottom = top + current.row.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }
  }

  private renderDetail(): void {
    const controller = this.controller;
    if (!controller) return;
    const index = this.index;

    if (index === 0) {
      const point = controller.points[0];
      const value =
        !point || point.humanValue === null
          ? '还没评估'
          : `${this.viewLabel()}视角估值 ${percent(this.displayHuman(point.humanValue))}`;
      this.detailEl.innerHTML = `<div>开局</div><div class="muted">${value}</div>`;
      return;
    }

    const move = controller.moves[index - 1];
    const point = controller.points[index];
    if (!move || !point) return;

    const who = move.human ? '你' : '对手';
    const showingCorrection = this.correction !== null;
    // 预览时棋盘已经不是原局，100% 容易被读成「正确着法的估值」，标注一下口径
    const value =
      point.humanValue === null
        ? '未评估'
        : `${showingCorrection ? '原局估值' : `${this.viewLabel()}视角估值`} ${percent(
            this.displayHuman(point.humanValue),
          )}`;

    let grade = '';
    if (move.opening) {
      grade = ` · ${WHALE_LINES.reviewOpeningNote}`;
    } else if (move.grade) {
      const loss = move.loss === null ? '' : `（损失 ${Math.round(move.loss * 100)}%）`;
      const prefix = move.human ? '' : '对手';
      grade = ` · ${prefix}${WHALE_LINES.reviewGrades[move.grade]}${loss}`;
    } else if (move.status === 'pending') {
      grade = ' · 未评估';
    }

    const verdict = move.tags
      .map((tag) => WHALE_LINES.reviewVerdicts[tag][move.human ? 'you' : 'rival'])
      .join('；');

    const canCorrect = !move.opening && move.bestMove !== null && move.bestMove !== move.move;
    const bestLine =
      canCorrect && move.bestMove !== null ? ` · 本可下 ${shortCoord(move.bestMove)}` : '';
    const note = [showingCorrection ? '已显示正确着法' : '', verdict].filter(Boolean).join(' · ');
    const action = showingCorrection
      ? `<button class="review-correct" data-action="restore" type="button"${
          this.correcting ? ' disabled' : ''
        }>返回原局</button>`
      : canCorrect
        ? `<button class="review-correct" data-action="correct" type="button"${
            this.correcting ? ' disabled' : ''
          }>正确着法</button>`
        : '';

    this.detailEl.innerHTML = `<div>第 ${move.ply} 手 · ${shortCoord(move.move)} · ${who} · ${value}${grade}${bestLine}</div>${
      note ? `<div class="muted">${note}</div>` : ''
    }${action ? `<div class="review-detail-action">${action}</div>` : ''}`;
  }

  /** 视角切换时，展示值跟着翻。 */
  private displayHuman(humanValue: number): number {
    return this.viewSide === 'human' ? humanValue : 1 - humanValue;
  }

  private viewLabel(): string {
    return this.viewSide === 'human' ? '你的' : '对手的';
  }

  private renderBoard(): void {
    const controller = this.controller;
    if (!controller) return;
    const index = this.index;
    const history = controller.snapshot.history;

    let board = controller.boardAt(index);
    let lastMove = index > 0 ? history[index - 1].move : null;
    let hint: BoardViewState['hint'] = null;
    let winLine: number[] = [];

    if (this.correction) {
      board = correctedBoard(
        board,
        this.correction.from,
        this.correction.to,
        this.correction.player,
      );
      lastMove = this.correction.to;
      winLine = getWinLine(board, lastMove);
    } else {
      // 最佳替代属于「选中这一手」，不是当前局面的下一手；
      // 开局段与简易评估的 bestMove 都是 null，自然不画。
      const selected = index > 0 ? controller.moves[index - 1] : null;
      hint =
        selected && selected.bestMove !== null && selected.bestMove !== selected.move
          ? { move: selected.bestMove, top: [] }
          : null;
      winLine = index >= controller.total && lastMove !== null ? getWinLine(board, lastMove) : [];
    }

    this.board.setState({ board, lastMove, hint, winLine, interactive: false });
  }

  /**
   * 「正确着法」：先把落错的子收回，再把最佳点落下。
   * 只改渲染，controller 的历史与图表不变；切到别的着手时自动恢复。
   */
  private playCorrection(): void {
    const controller = this.controller;
    if (!controller || this.correcting || this.correction || this.index === 0) return;
    const move = controller.moves[this.index - 1];
    if (!move || move.bestMove === null || move.bestMove === move.move) return;

    this.pause();
    this.correcting = true;
    this.renderDetail();
    window.clearTimeout(this.correctionTimer);
    this.board.animateRemove(move.move);

    const played = move.move;
    const bestMove = move.bestMove;
    const player = move.player;
    this.correctionTimer = window.setTimeout(() => {
      this.correction = { from: played, to: bestMove, player };
      this.renderDetail();
      this.renderBoard();
      this.board.animateMove(bestMove);
      this.correcting = false;
    }, 190);
  }

  /** 从预览回到实际对局，动画反过来走一遍。 */
  private restoreBoard(): void {
    const correction = this.correction;
    if (!correction || this.correcting) return;

    this.correcting = true;
    this.renderDetail();
    window.clearTimeout(this.correctionTimer);
    this.board.animateRemove(correction.to);

    this.correctionTimer = window.setTimeout(() => {
      this.correction = null;
      this.renderDetail();
      this.renderBoard();
      this.board.animateMove(correction.from);
      this.correcting = false;
    }, 190);
  }

  private clearCorrection(): void {
    window.clearTimeout(this.correctionTimer);
    this.correctionTimer = 0;
    this.correction = null;
    this.correcting = false;
  }

  /* ===== 曲线 ===== */

  private drawChart(): void {
    const controller = this.controller;
    if (!controller) return;
    const width = Math.max(120, this.chartWrap.clientWidth);
    const height = Math.max(80, this.chartWrap.clientHeight);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (
      this.chart.width !== Math.round(width * dpr) ||
      this.chart.height !== Math.round(height * dpr)
    ) {
      this.chart.width = Math.round(width * dpr);
      this.chart.height = Math.round(height * dpr);
    }

    const ctx = this.chart.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const padLeft = 26;
    const padRight = 10;
    const padTop = 10;
    const padBottom = 14;
    const innerW = width - padLeft - padRight;
    const innerH = height - padTop - padBottom;
    const total = controller.total;
    const xOf = (index: number): number =>
      padLeft + (total === 0 ? innerW / 2 : (index / total) * innerW);
    const yOf = (value: number): number => padTop + (1 - value) * innerH;

    ctx.font = '9px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const value of [1, 0.5, 0]) {
      const y = yOf(value);
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.setLineDash(value === 0.5 ? [3, 4] : []);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.axis;
      ctx.fillText(`${Math.round(value * 100)}`, padLeft - 4, y);
    }

    const valueOf = (index: number): number | null => {
      const point = controller.points[index];
      if (!point) return null;
      const humanValue = point.humanValue;
      if (humanValue === null) return null;
      return this.viewSide === 'human' ? humanValue : 1 - humanValue;
    };

    // 折线：遇到 null 就断开，不要用直线跨过未评估的点
    ctx.strokeStyle = COLORS.curve;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let drawing = false;
    for (let i = 0; i <= total; i++) {
      const value = valueOf(i);
      if (value === null) {
        drawing = false;
        continue;
      }
      const x = xOf(i);
      const y = yOf(value);
      if (drawing) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      drawing = true;
    }
    ctx.stroke();

    const humanColor = controller.snapshot.humanColor;
    for (let i = 0; i <= total; i++) {
      const value = valueOf(i);
      if (value === null) continue;
      const x = xOf(i);
      const y = yOf(value);
      // 点色按「谁走的这手」；0 号点是空盘，按先手方
      const mover: Player =
        i === 0 ? controller.points[0].player : controller.snapshot.history[i - 1].player;
      const grade = i === 0 ? null : controller.moves[i - 1]?.grade ?? null;

      if (grade) {
        ctx.beginPath();
        ctx.strokeStyle = GRADE_COLORS[grade];
        ctx.lineWidth = 2;
        ctx.arc(x, y, 4.6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.fillStyle = mover === humanColor ? COLORS.human : COLORS.rival;
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // 当前手与 hover 各一条竖线；hover 优先，免得两条叠在一起
    const marker = this.hoverIndex ?? this.index;
    const markerValue = valueOf(marker);
    if (markerValue !== null) {
      const x = xOf(marker);
      ctx.strokeStyle = this.hoverIndex === null ? COLORS.cursor : COLORS.hover;
      ctx.lineWidth = 1;
      ctx.setLineDash(this.hoverIndex === null ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, height - padBottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.fillStyle = '#ffffff';
      ctx.arc(x, yOf(markerValue), 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private onChartMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    this.pause();
    this.setHover(this.indexAt(event.clientX));
  };

  private onChartLeave = (): void => {
    this.hoverIndex = null;
    this.hideTooltip();
    this.drawChart();
  };

  private onChartDown = (event: PointerEvent): void => {
    const index = this.indexAt(event.clientX);
    if (index === null) return;
    event.preventDefault();
    if (event.pointerType === 'touch' && this.hoverIndex !== index) {
      // 触摸先预览、再点一次跳转，避免手指一碰棋盘就跳走
      this.setHover(index);
      return;
    }
    this.seek(index);
  };

  private indexAt(clientX: number): number | null {
    const controller = this.controller;
    if (!controller) return null;
    const rect = this.chart.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const width = rect.width;
    const padLeft = 26;
    const padRight = 10;
    const innerW = Math.max(1, width - padLeft - padRight);
    const x = clientX - rect.left;
    if (x < padLeft - 8 || x > width - padRight + 8) return null;
    const ratio = Math.min(1, Math.max(0, (x - padLeft) / innerW));
    return Math.round(ratio * controller.total);
  }

  private setHover(index: number | null): void {
    if (index === this.hoverIndex) {
      this.drawChart();
      return;
    }
    this.hoverIndex = index;
    if (index === null) this.hideTooltip();
    else this.showTooltip(index);
    this.drawChart();
  }

  private showTooltip(index: number): void {
    const controller = this.controller;
    if (!controller) return;
    const lines: string[] = [];
    if (index === 0) {
      lines.push('开局');
    } else {
      const move = controller.moves[index - 1];
      const point = controller.points[index];
      if (!move || !point) return;
      const value =
        point.humanValue === null
          ? '未评估'
          : `估值 ${percent(this.displayHuman(point.humanValue))}`;
      const grade = move.opening
        ? ` · ${WHALE_LINES.reviewOpening}`
        : move.grade
          ? ` · ${WHALE_LINES.reviewGrades[move.grade]}${
              move.loss === null ? '' : `（损失 ${Math.round(move.loss * 100)}%）`
            }`
          : '';
      lines.push(`${move.ply} ${shortCoord(move.move)} · ${move.human ? '你' : '对手'} · ${value}${grade}`);
      if (move.bestMove !== null && move.bestMove !== move.move) {
        lines.push(`本可下 ${shortCoord(move.bestMove)}`);
      }
      if (move.tags.length > 0) {
        lines.push(
          move.tags
            .map((tag) => WHALE_LINES.reviewVerdicts[tag][move.human ? 'you' : 'rival'])
            .join('；'),
        );
      }
    }

    this.tooltipEl.textContent = lines.join('\n');
    this.tooltipEl.classList.remove('hidden');
    this.tooltipEl.style.whiteSpace = 'pre-line';

    const rect = this.chart.getBoundingClientRect();
    const padLeft = 26;
    const padRight = 10;
    const innerW = Math.max(1, rect.width - padLeft - padRight);
    const x = padLeft + (index / Math.max(1, controller.total)) * innerW;
    const left = Math.min(Math.max(4, x - 70), Math.max(4, rect.width - 156));
    this.tooltipEl.style.left = `${left}px`;
    this.tooltipEl.style.top = '6px';
  }

  private hideTooltip(): void {
    this.tooltipEl.classList.add('hidden');
  }

  /* ===== 回放 ===== */

  private seek(index: number): void {
    const total = this.controller?.total ?? 0;
    this.pause();
    this.clearCorrection();
    this.index = Math.max(0, Math.min(total, index));
    this.updateRows();
    this.renderDetail();
    this.renderBoard();
    this.drawChart();
  }

  private step(delta: number): void {
    this.seek(this.index + delta);
  }

  private startPlayback(): void {
    if (!this.controller || this.controller.total === 0) return;
    if (this.correction) {
      this.clearCorrection();
      this.renderDetail();
      this.renderBoard();
    }
    if (this.index >= this.controller.total) {
      this.index = 0;
      this.updateRows();
      this.renderDetail();
      this.renderBoard();
      this.drawChart();
    }
    this.playing = true;
    this.playButton.textContent = '暂停';
    this.scheduleTick();
  }

  private scheduleTick(): void {
    window.clearTimeout(this.timer);
    const delay = this.speed === 0.5 ? 1800 : this.speed === 2 ? 500 : 1000;
    this.timer = window.setTimeout(() => {
      if (!this.playing) return;
      const total = this.controller?.total ?? 0;
      if (this.index >= total) {
        this.pause();
        return;
      }
      this.index += 1;
      this.updateRows();
      this.renderDetail();
      this.renderBoard();
      this.drawChart();
      this.scheduleTick();
    }, delay);
  }

  private pause(): void {
    if (!this.playing) return;
    this.playing = false;
    window.clearTimeout(this.timer);
    this.playButton.textContent = '播放';
  }

  private cycleSpeed(): void {
    this.speed = this.speed === 0.5 ? 1 : this.speed === 1 ? 2 : 0.5;
    this.speedButton.textContent = `${this.speed}x`;
    if (this.playing) this.scheduleTick();
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.screen.classList.contains('hidden')) return;
    if (event.target instanceof HTMLInputElement) return;
    const onButton = event.target instanceof HTMLElement && event.target.closest('button') !== null;

    switch (event.key) {
      case ' ':
        if (onButton) return;
        event.preventDefault();
        if (this.playing) this.pause();
        else this.startPlayback();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this.step(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.step(1);
        break;
      case 'Home':
        event.preventDefault();
        this.seek(0);
        break;
      case 'End':
        event.preventDefault();
        this.seek(this.controller?.total ?? 0);
        break;
      default:
        break;
    }
  };
}
