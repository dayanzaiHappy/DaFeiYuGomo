/// <reference lib="webworker" />

import type { InferenceSession } from 'onnxruntime-web';
import { AI_CONFIG } from '../game/ai-config';
import { runSearch } from '../game/mcts';
import { sha256Hex } from '../game/sha256';
import type { Evaluator, Player, RootNoise, SearchProgress, SearchResult } from '../game/types';
import { N_CELLS } from '../game/types';

declare const self: DedicatedWorkerGlobalScope;

type OrtModule = typeof import('onnxruntime-web/wasm');

type InitMessage = {
  type: 'init';
  wasmBase: string;
  modelUrl: string;
};

type SearchMessage = {
  type: 'search';
  id: string;
  board: Uint8Array;
  player: Player;
  sims: number;
  topk: number;
  temperature?: number;
  sampleTopK?: number;
  rootNoise?: RootNoise | null;
  lastMove?: number;
  rootLimit?: number;
  forcedPlies?: number;
  vcfDepth?: number;
};

type CancelMessage = {
  type: 'cancel';
  id: string;
};

type EvaluateMessage = {
  type: 'evaluate';
  id: string;
  board: Uint8Array;
  player: Player;
};

type MainMessage = InitMessage | SearchMessage | CancelMessage | EvaluateMessage;

type ReadyMessage = {
  type: 'ready';
  backend: string;
  threads: number;
  loadMs: number;
  evalMs: number;
  modelBytes: number;
  /** ONNX 字节的 SHA-256；记录对局时写进 header，证明复盘对应哪个模型。 */
  modelHash: string;
};

type WorkerMessage =
  | ReadyMessage
  | { type: 'init-error'; message: string }
  | { type: 'progress'; id: string; progress: SearchProgress }
  | { type: 'result'; id: string; result: SearchResult }
  | { type: 'eval-result'; id: string; policy: Float32Array; value: number }
  | { type: 'error'; id?: string; message: string };

const post = (message: WorkerMessage) => self.postMessage(message);

let ort: OrtModule | null = null;

class OrtEvaluator implements Evaluator {
  constructor(private readonly session: InferenceSession) {}

  async evaluate(board: Uint8Array, player: Player): Promise<{ policy: Float32Array; value: number }> {
    if (!ort) throw new Error('ONNX Runtime 尚未初始化');
    const planes = new Float32Array(2 * N_CELLS);
    const opponent = player === 1 ? 2 : 1;
    for (let i = 0; i < N_CELLS; i++) {
      planes[i] = board[i] === player ? 1 : 0;
      planes[N_CELLS + i] = board[i] === opponent ? 1 : 0;
    }
    const input = new ort.Tensor('float32', planes, [1, 2, 15, 15]);
    const outputs = await this.session.run({ planes: input });
    const policy = outputs.policy?.data as Float32Array | undefined;
    const valueData = outputs.value?.data as Float32Array | undefined;
    if (!policy || policy.length !== N_CELLS || !valueData || valueData.length !== 1) {
      throw new Error('模型输出形状不正确');
    }
    const value = valueData[0];
    if (!Number.isFinite(value)) throw new Error('模型输出 value 非有限值');
    for (let i = 0; i < policy.length; i++) {
      if (!Number.isFinite(policy[i])) throw new Error('模型输出 policy 非有限值');
    }
    return { policy, value };
  }
}

let evaluator: Evaluator | null = null;
let readyInfo: ReadyMessage | null = null;
let initPromise: Promise<ReadyMessage> | null = null;
let active: { id: string; cancelled: boolean } | null = null;
let pending: SearchMessage | null = null;

function numThreads(): number {
  // GitHub Pages 无法提供 COOP/COEP，ORT 多线程不可用；固定单线程最稳。
  return 1;
}

function configureOrt(module: OrtModule, wasmBase: string, threads: number): void {
  module.env.wasm.numThreads = threads;
  module.env.wasm.simd = true;
  module.env.wasm.proxy = false;
  module.env.wasm.wasmPaths = wasmBase;
  const env = module.env as typeof module.env & {
    webgpu?: { powerPreference?: string };
  };
  if (env.webgpu) env.webgpu.powerPreference = 'high-performance';
}

async function loadModel(modelUrl: string): Promise<Uint8Array> {
  const response = await fetch(modelUrl, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`模型下载失败: ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

async function createSession(
  module: OrtModule,
  modelData: Uint8Array,
  backend: 'webgpu' | 'wasm',
): Promise<InferenceSession> {
  return module.InferenceSession.create(modelData, {
    executionProviders: [backend],
    graphOptimizationLevel: 'all',
  });
}

interface Candidate {
  session: InferenceSession;
  module: OrtModule;
  backend: 'webgpu' | 'wasm';
  evalMs: number;
}

async function benchmarkCandidate(
  module: OrtModule,
  backend: 'webgpu' | 'wasm',
  modelData: Uint8Array,
  empty: Uint8Array,
  wasmBase: string,
  threads: number,
): Promise<Candidate> {
  configureOrt(module, wasmBase, threads);
  ort = module;
  const session = await createSession(module, modelData, backend);
  const probe = new OrtEvaluator(session);
  await probe.evaluate(empty, 1);
  await probe.evaluate(empty, 1);
  const started = performance.now();
  const rounds = 5;
  for (let i = 0; i < rounds; i++) {
    await probe.evaluate(empty, 1);
  }
  return {
    session,
    module,
    backend,
    evalMs: (performance.now() - started) / rounds,
  };
}

async function init(message: InitMessage): Promise<ReadyMessage> {
  if (readyInfo) return readyInfo;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const started = performance.now();
    const threads = numThreads();
    const modelData = await loadModel(message.modelUrl);
    const empty = new Uint8Array(N_CELLS);

    let best: Candidate | null = null;
    const gpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator;

    if (gpuAvailable) {
      try {
        const gpuModule = (await import('onnxruntime-web/webgpu')) as unknown as OrtModule;
        best = await benchmarkCandidate(
          gpuModule,
          'webgpu',
          modelData,
          empty,
          message.wasmBase,
          threads,
        );
      } catch (error) {
        console.warn('WebGPU 初始化失败，回退 WASM', error);
      }
    }

    try {
      const wasmModule = (await import('onnxruntime-web/wasm')) as unknown as OrtModule;
      const wasmCandidate = await benchmarkCandidate(
        wasmModule,
        'wasm',
        modelData,
        empty,
        message.wasmBase,
        threads,
      );
      if (!best || wasmCandidate.evalMs < best.evalMs) {
        if (best) void best.session.release();
        best = wasmCandidate;
      } else {
        void wasmCandidate.session.release();
      }
    } catch (error) {
      if (!best) throw error;
      console.warn('WASM 候选初始化失败，保留 WebGPU', error);
    }

    if (!best) throw new Error('没有可用的推理后端');

    ort = best.module;
    evaluator = new OrtEvaluator(best.session);
    readyInfo = {
      type: 'ready',
      backend: best.backend,
      threads,
      loadMs: Math.round(performance.now() - started),
      evalMs: Math.round(best.evalMs * 100) / 100,
      modelBytes: modelData.byteLength,
      // 模型字节已经在手里，顺手算一次；记录里靠它说明「这份复盘对应哪个模型」
      modelHash: `sha256:${sha256Hex(modelData)}`,
    };
    return readyInfo;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

async function startSearch(message: SearchMessage): Promise<void> {
  if (!evaluator) {
    post({ type: 'error', id: message.id, message: 'AI 引擎尚未加载' });
    return;
  }

  const token = { id: message.id, cancelled: false };
  active = token;

  try {
    const result = await runSearch(message.board, message.player, evaluator, {
      sims: message.sims,
      topk: message.topk,
      temperature: message.temperature,
      sampleTopK: message.sampleTopK,
      rootNoise: message.rootNoise,
      lastMove: message.lastMove,
      rootLimit: message.rootLimit,
      forcedPlies: message.forcedPlies,
      vcfDepth: message.vcfDepth,
      progressEvery: AI_CONFIG.progressEvery,
      onProgress: (progress) => {
        if (!token.cancelled) {
          post({ type: 'progress', id: message.id, progress });
        }
      },
      shouldCancel: () => token.cancelled,
    });
    post({ type: 'result', id: message.id, result });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    post({ type: 'error', id: message.id, message: text });
  } finally {
    if (active === token) active = null;
    if (pending) {
      const next = pending;
      pending = null;
      void startSearch(next);
    }
  }
}

async function evaluateBoard(message: EvaluateMessage): Promise<void> {
  if (!evaluator) {
    post({ type: 'error', id: message.id, message: 'AI 引擎尚未加载' });
    return;
  }

  try {
    const result = await evaluator.evaluate(message.board, message.player);
    post({
      type: 'eval-result',
      id: message.id,
      policy: result.policy,
      value: result.value,
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    post({ type: 'error', id: message.id, message: text });
  }
}

self.onmessage = async (event: MessageEvent<MainMessage>) => {
  const message = event.data;

  if (message.type === 'init') {
    try {
      const ready = await init(message);
      post(ready);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      post({ type: 'init-error', message: text });
    }
    return;
  }

  if (message.type === 'cancel') {
    if (active?.id === message.id) active.cancelled = true;
    if (pending?.id === message.id) pending = null;
    return;
  }

  if (message.type === 'evaluate') {
    void evaluateBoard(message);
    return;
  }

  if (message.type === 'search') {
    if (active) {
      active.cancelled = true;
      pending = message;
      return;
    }
    void startSearch(message);
  }
};
