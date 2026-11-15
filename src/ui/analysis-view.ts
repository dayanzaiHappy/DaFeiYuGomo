import type { AnalysisController, AnalysisMode } from '../app/analysis';
import { shortCoord } from '../game/board';
import { BoardView, type BoardViewState } from '../render/board-view';
import type { Skin } from '../render/skins';
import { BLACK, WHITE, type Player } from '../game/types';

/**
 * 分析屏。
 *
 * 与复盘屏共用版式（棋盘 + 右侧栏），但状态机完全不同：复盘是只读回放，
 * 这里是可写沙盘。所以棋盘用第三块 `BoardView`，并打开 `interactive`——
 * 复盘那块始终是只读的，两块棋盘不会互相干扰。
 *
 * 落子只改控制器，渲染全部由控制器派生；搜索由外部（main）注入，屏内只负责节流。
 */

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少页面元素 #${id}`);
  return node as T;
};

const percent = (value: number): string => `${Math.round(value * 100)}%`;

function formatCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

/** 落子后等一小会儿再搜：连点时只跑最后一版，不为中间态付一次搜索。 */
const AUTO_DELAY = 180;

export interface AnalysisViewOptions {
  getSkin: () => Skin;
  onBack: () => void;
  onRequest: (mode: AnalysisMode) => void;
  /** 落子音效，交给外面的音频引擎。 */
  onPlaced: () => void;
}

export class AnalysisView {
  private readonly screen = el('analysis-screen');
  private readonly backButton = el<HTMLButtonElement>('analysis-back');
  private readonly titleEl = el('analysis-title');
  private readonly statusEl = el('analysis-status');
  private readonly turnEl = el('analysis-turn');
  private readonly metaEl = el('analysis-meta');
  private readonly barEl = el('analysis-eval-bar');
  private readonly blackEl = el('analysis-black');
  private readonly whiteEl = el('analysis-white');
  private readonly topEl = el('analysis-top');
  private readonly threatsEl = el<HTMLTableSectionElement>('analysis-threats');
  private readonly undoButton = el<HTMLButtonElement>('analysis-undo');
  private readonly redoButton = el<HTMLButtonElement>('analysis-redo');
  private readonly flipButton = el<HTMLButtonElement>('analysis-flip');
  private readonly resetButton = el<HTMLButtonElement>('analysis-reset');
  private readonly clearButton = el<HTMLButtonElement>('analysis-clear');
  private readonly deepButton = el<HTMLButtonElement>('analysis-deep');
  private readonly stopButton = el<HTMLButtonElement>('analysis-stop');
  private readonly board: BoardView;

  private controller: AnalysisController | null = null;
  private timer = 0;

  constructor(private readonly options: AnalysisViewOptions) {
    this.board = new BoardView(el<HTMLCanvasElement>('analysis-canvas'), el('analysis-board-wrap'), {
      onPlace: (move) => this.handlePlace(move),
      getSkin: options.getSkin,
    });

    this.backButton.addEventListener('click', () => options.onBack());
    this.undoButton.addEventListener('click', () => this.handleUndo());
    this.redoButton.addEventListener('click', () => this.handleRedo());
    this.flipButton.addEventListener('click', () => this.handleFlip());
    this.resetButton.addEventListener('click', () => this.handleReset());
    this.clearButton.addEventListener('click', () => this.handleClear());
    this.deepButton.addEventListener('click', () => options.onRequest('deep'));
    this.stopButton.addEventListener('click', () => this.handleStop());
    document.addEventListener('keydown', this.onKeyDown);
  }

  open(controller: AnalysisController): void {
    window.clearTimeout(this.timer);
    this.controller = controller;
    this.refresh();
    // 屏幕刚显示时容器尺寸还是 0，等一帧再量
    requestAnimationFrame(() => this.board.resize());
  }

  close(): void {
    window.clearTimeout(this.timer);
    this.controller = null;
  }

  resize(): void {
    this.board.resize();
  }

  /** 立即排一次自动分析（进屏时用，不走防抖）。 */
  analyze(): void {
    window.clearTimeout(this.timer);
    this.options.onRequest('auto');
  }

  refresh(): void {
    const controller = this.controller;
    if (!controller) return;
    this.titleEl.textContent = `分析 · ${controller.plies} 手`;
    this.renderBoard();
    this.renderEval();
    this.renderTop();
    this.renderThreats();
    this.renderStatus();
    this.renderControls();
  }

  private renderBoard(): void {
    const controller = this.controller;
    if (!controller) return;
    const result = controller.result;
    // 前三个候补直接标在棋盘上，号码与右侧列表一致；终局只画五连线
    const hint: BoardViewState['hint'] =
      result && !controller.terminal && result.move >= 0
        ? { move: result.move, top: result.top.slice(0, 3).map((item) => ({ move: item.move, value: item.value })) }
        : null;

    this.board.setState({
      board: controller.board,
      lastMove: controller.lastMove,
      hint,
      winLine: controller.winLine(),
      interactive: !controller.terminal,
    });
  }

  private renderEval(): void {
    const controller = this.controller;
    if (!controller) return;
    this.turnEl.textContent = `${controller.toMove === BLACK ? '黑' : '白'}方`;

    if (controller.winner !== null) {
      this.metaEl.textContent = `${controller.winner === BLACK ? '黑' : '白'}方五连`;
      this.blackEl.textContent = '黑 —';
      this.whiteEl.textContent = '白 —';
      this.barEl.style.width = controller.winner === BLACK ? '100%' : '0%';
      return;
    }
    if (controller.draw) {
      this.metaEl.textContent = '棋盘已满';
      this.blackEl.textContent = '黑 —';
      this.whiteEl.textContent = '白 —';
      this.barEl.style.width = '50%';
      return;
    }

    const result = controller.result;
    if (!result) {
      // 没有结果时把条压在 50%，避免「上一手的分数」被误读成本局面的分数
      this.barEl.style.width = '50%';
      this.blackEl.textContent = '黑 —';
      this.whiteEl.textContent = '白 —';
      this.metaEl.textContent = controller.busy
        ? '分析中…'
        : controller.error
          ? '分析失败'
          : '未分析';
      return;
    }

    // result.value 是行棋方视角，展示统一换成黑方视角，换手时两边才不会互相矛盾
    const blackShare = controller.toMove === BLACK ? result.value : 1 - result.value;
    this.barEl.style.width = percent(blackShare);
    this.blackEl.textContent = `黑 ${percent(blackShare)}`;
    this.whiteEl.textContent = `白 ${percent(1 - blackShare)}`;
    // 根节点 VCF 命中时没进主搜索，节点数与深度都是 0——这是「算到必胜线」，不是出错
    if (result.nodes === 0 && result.move >= 0) {
      this.metaEl.textContent = '算到必胜线';
      return;
    }
    this.metaEl.textContent = `深度 ${result.depth ?? 0} · ${formatCount(result.nodes)} 节点`;
  }

  private renderTop(): void {
    const controller = this.controller;
    if (!controller) return;
    const top = controller.result?.top.slice(0, 3) ?? [];
    if (top.length === 0) {
      this.topEl.innerHTML = '<p class="analysis-empty">还没有候选</p>';
      return;
    }
    this.topEl.innerHTML = top
      .map(
        (item, index) => `<div class="analysis-row">
          <span class="analysis-rank">${index + 1}</span>
          <span class="analysis-coord">${shortCoord(item.move)}</span>
          <span class="analysis-pct">${percent(item.value)}</span>
        </div>`,
      )
      .join('');
  }

  private renderThreats(): void {
    const controller = this.controller;
    if (!controller) return;
    const threats = controller.threats();
    const row = (label: string, player: Player): string => {
      const counts = player === BLACK ? threats.black : threats.white;
      return `<tr>
        <th scope="row"><i class="stone-dot ${player === BLACK ? 'black' : 'white'}"></i>${label}</th>
        <td>${counts.openFour}</td>
        <td>${counts.four}</td>
        <td>${counts.openThree}</td>
        <td>${counts.sleepThree}</td>
      </tr>`;
    };
    this.threatsEl.innerHTML = row('黑', BLACK) + row('白', WHITE);
  }

  private renderStatus(): void {
    const controller = this.controller;
    if (!controller) return;
    if (controller.busy) {
      this.statusEl.className = 'status-pill thinking';
      this.statusEl.textContent = '分析中';
      return;
    }
    this.statusEl.className = 'status-pill';
    if (controller.winner !== null) {
      this.statusEl.textContent = '已结束';
    } else if (controller.error) {
      this.statusEl.textContent = '分析失败';
    } else if (controller.result) {
      this.statusEl.textContent = '已分析';
    } else {
      this.statusEl.textContent = '未分析';
    }
  }

  private renderControls(): void {
    const controller = this.controller;
    this.undoButton.disabled = !controller || controller.plies === 0;
    this.redoButton.disabled = !controller || !controller.canRedo;
    this.flipButton.disabled = !controller || controller.terminal;
    this.resetButton.disabled = !controller;
    this.clearButton.disabled = !controller || controller.plies === 0;
    this.deepButton.disabled = !controller || controller.busy || controller.terminal;
    this.stopButton.classList.toggle('hidden', !controller?.busy);
  }

  private handlePlace(move: number): void {
    const controller = this.controller;
    if (!controller || controller.terminal) return;
    if (!controller.place(move)) return;
    this.options.onPlaced();
    this.board.animateMove(move);
    this.refresh();
    this.schedule();
  }

  private handleUndo(): void {
    const controller = this.controller;
    if (!controller || !controller.undo()) return;
    this.refresh();
    this.schedule();
  }

  private handleRedo(): void {
    const controller = this.controller;
    if (!controller || !controller.redo()) return;
    this.options.onPlaced();
    this.refresh();
    this.schedule();
  }

  private handleFlip(): void {
    const controller = this.controller;
    if (!controller || controller.terminal) return;
    controller.flip();
    this.refresh();
    this.schedule();
  }

  private handleReset(): void {
    const controller = this.controller;
    if (!controller) return;
    controller.reset();
    this.refresh();
    this.schedule();
  }

  private handleClear(): void {
    const controller = this.controller;
    if (!controller) return;
    controller.clear();
    this.refresh();
    this.schedule();
  }

  private handleStop(): void {
    const controller = this.controller;
    if (!controller) return;
    controller.stop();
    this.refresh();
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    const controller = this.controller;
    if (!controller || controller.terminal) return;
    this.timer = window.setTimeout(() => this.options.onRequest('auto'), AUTO_DELAY);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.screen.classList.contains('hidden')) return;
    if (event.target instanceof HTMLInputElement) return;
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
    // 棋盘上的方向键归 BoardView 管，这里只管撤消，避免两套键位抢同一个键
    event.preventDefault();
    if (event.shiftKey) this.handleRedo();
    else this.handleUndo();
  };
}
