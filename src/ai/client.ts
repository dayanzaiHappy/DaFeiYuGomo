import type { AbProfile } from '../game/ai-config';
import type { Player, SearchResult } from '../game/types';

export interface ReadyInfo {
  backend: string;
  threads: number;
  loadMs: number;
  evalMs: number;
  modelBytes: number;
  /** ONNX 字节的 SHA-256，形如 `sha256:...`；写进对局记录用于说明模型来源。 */
  modelHash: string;
  /** 叶子权重的 SHA-256；没加载成功时为 null（此时这一局跑的是手写评估）。 */
  leafHash: string | null;
  /** 实际生效的 λ，权重缺失时为 0。 */
  evalLambda: number;
}

export interface EvaluationResult {
  policy: Float32Array;
  value: number;
}

interface PendingRequest {
  resolve: (result: SearchResult) => void;
  reject: (error: Error) => void;
}

interface PendingEvaluation {
  resolve: (result: EvaluationResult) => void;
  reject: (error: Error) => void;
}

export interface SearchRequest {
  ab: AbProfile;
}

/**
 * Worker 客户端。
 *
 * 搜索是同步的、不可打断的：`cancelAll` 只是把等待中的 Promise 立刻拒掉，
 * Worker 里那一轮仍会跑完，结果因为找不到等待者而被丢弃。
 */
export class AiClient {
  private worker: Worker | null = null;
  private ready: Promise<ReadyInfo> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingEval = new Map<string, PendingEvaluation>();
  private sequence = 0;

  constructor(
    private readonly wasmBase: string,
    private readonly modelUrl: string,
  ) {}

  ensureReady(): Promise<ReadyInfo> {
    if (this.ready) return this.ready;

    this.ready = new Promise<ReadyInfo>((resolve, reject) => {
      let settled = false;
      const worker = new Worker(new URL('./worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker = worker;

      const fail = (error: Error) => {
        this.ready = null;
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      worker.onerror = (event) => {
        // Worker 里未捕获的异常不会再回消息，这里必须把等待者全部拒掉，
        // 否则界面会一直停在「思考中」，连错误提示都出不来
        const error = new Error(event.message || 'AI Worker 启动失败');
        this.rejectPending(error);
        fail(error);
      };

      worker.onmessage = (event: MessageEvent) => {
        const message = event.data as {
          type: string;
          id?: string;
          message?: string;
        } & Record<string, unknown>;

        if (message.type === 'ready') {
          settled = true;
          resolve(message as unknown as ReadyInfo);
          return;
        }
        if (message.type === 'init-error') {
          fail(new Error(message.message || 'AI 引擎加载失败'));
          return;
        }
        if (message.type === 'result' && message.id) {
          const request = this.pending.get(message.id);
          if (request) {
            this.pending.delete(message.id);
            request.resolve(message.result as SearchResult);
          }
          return;
        }
        if (message.type === 'eval-result' && message.id) {
          const request = this.pendingEval.get(message.id);
          if (request) {
            this.pendingEval.delete(message.id);
            request.resolve({
              policy: message.policy as Float32Array,
              value: message.value as number,
            });
          }
          return;
        }
        if (message.type === 'error') {
          const id = message.id;
          if (id) {
            const request = this.pending.get(id);
            if (request) {
              this.pending.delete(id);
              request.reject(new Error(message.message || 'AI 搜索失败'));
              return;
            }
            const evaluation = this.pendingEval.get(id);
            if (evaluation) {
              this.pendingEval.delete(id);
              evaluation.reject(new Error(message.message || 'AI 评估失败'));
            }
          }
        }
      };

      worker.postMessage({
        type: 'init',
        wasmBase: this.wasmBase,
        modelUrl: this.modelUrl,
      });
    });

    return this.ready;
  }

  async search(board: Uint8Array, player: Player, request: SearchRequest): Promise<SearchResult> {
    await this.ensureReady();
    const worker = this.worker;
    if (!worker) throw new Error('AI Worker 不可用');

    const id = `s${++this.sequence}`;
    const copy = new Uint8Array(board);
    return new Promise<SearchResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage(
        {
          type: 'search',
          id,
          board: copy,
          player,
          ab: request.ab,
        },
        [copy.buffer],
      );
    });
  }

  /** 一次网络前向，给开局应手排序用。 */
  async evaluate(board: Uint8Array, player: Player): Promise<EvaluationResult> {
    await this.ensureReady();
    const worker = this.worker;
    if (!worker) throw new Error('AI Worker 不可用');

    const id = `e${++this.sequence}`;
    const copy = new Uint8Array(board);
    return new Promise<EvaluationResult>((resolve, reject) => {
      this.pendingEval.set(id, { resolve, reject });
      worker.postMessage(
        {
          type: 'evaluate',
          id,
          board: copy,
          player,
        },
        [copy.buffer],
      );
    });
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const request of this.pendingEval.values()) request.reject(error);
    this.pendingEval.clear();
  }

  cancelAll(): void {
    for (const request of this.pending.values()) request.reject(new Error('搜索已取消'));
    this.pending.clear();

    for (const request of this.pendingEval.values()) request.reject(new Error('评估已取消'));
    this.pendingEval.clear();
  }

  dispose(): void {
    this.cancelAll();
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}
