import type { Player, RootNoise, SearchProgress, SearchResult } from '../game/types';

export interface ReadyInfo {
  backend: string;
  threads: number;
  loadMs: number;
  evalMs: number;
  modelBytes: number;
  /** ONNX 字节的 SHA-256，形如 `sha256:...`；写进对局记录用于说明模型来源。 */
  modelHash: string;
}

export interface EvaluationResult {
  policy: Float32Array;
  value: number;
}

interface PendingRequest {
  resolve: (result: SearchResult) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: SearchProgress) => void;
}

interface PendingEvaluation {
  resolve: (result: EvaluationResult) => void;
  reject: (error: Error) => void;
}

export interface SearchRequest {
  sims: number;
  topk: number;
  temperature?: number;
  sampleTopK?: number;
  rootNoise?: RootNoise | null;
  lastMove?: number;
  rootLimit?: number;
  forcedPlies?: number;
  vcfDepth?: number;
  onProgress?: (progress: SearchProgress) => void;
}

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
        fail(new Error(event.message || 'AI Worker 启动失败'));
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
        if (message.type === 'progress' && message.id) {
          const request = this.pending.get(message.id);
          request?.onProgress?.(message.progress as SearchProgress);
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

  async search(
    board: Uint8Array,
    player: Player,
    request: SearchRequest,
  ): Promise<SearchResult> {
    await this.ensureReady();
    const worker = this.worker;
    if (!worker) throw new Error('AI Worker 不可用');

    const id = `s${++this.sequence}`;
    const copy = new Uint8Array(board);
    return new Promise<SearchResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: request.onProgress });
      worker.postMessage(
        {
          type: 'search',
          id,
          board: copy,
          player,
          sims: request.sims,
          topk: request.topk,
          temperature: request.temperature,
          sampleTopK: request.sampleTopK,
          rootNoise: request.rootNoise,
          lastMove: request.lastMove,
          rootLimit: request.rootLimit,
          forcedPlies: request.forcedPlies,
          vcfDepth: request.vcfDepth,
        },
        [copy.buffer],
      );
    });
  }

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

  cancel(id: string): void {
    this.worker?.postMessage({ type: 'cancel', id });
  }

  cancelAll(): void {
    for (const [id, request] of this.pending) {
      this.worker?.postMessage({ type: 'cancel', id });
      request.reject(new Error('搜索已取消'));
    }
    this.pending.clear();

    for (const [id, request] of this.pendingEval) {
      this.worker?.postMessage({ type: 'cancel', id });
      request.reject(new Error('评估已取消'));
    }
    this.pendingEval.clear();
  }

  dispose(): void {
    this.cancelAll();
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}
