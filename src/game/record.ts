import type { AiDifficulty } from './ai-config';
import type { CoachVerdict } from './coach';
import type { MoveGrade, ReviewedMove } from './review';
import { sha256Hex } from './sha256';
import { SIZE, type Player, type SearchTop } from './types';

/**
 * 对局记录：JSONL，一行一个对象。
 *
 * 选它而不是 SGF：每手要带 p/v/Top-3/评级，这些塞不进 SGF 的可移植字段，
 * 硬塞进注释会变成没人认识的私有方言。JSONL 每行独立，追加、逐行校验都简单。
 *
 * hash 只做完整性校验，不做防伪：客户端藏不住签名密钥，改完记录重算 hash 是免费的。
 * 要证明「这局真的下过」，需要服务端签名或用户私钥，不在这一版。
 */

export const RECORD_SCHEMA_VERSION = 1;

export interface RecordHeaderInput {
  appVersion: string;
  engineVersion: string;
  modelVersion: string;
  /** ONNX 字节的 SHA-256；加载失败或未提供时为 null。 */
  modelHash: string | null;
  /** 复盘预算，形如 `82/20/2/5`；说明这份评级是在哪一档下算的。 */
  reviewProfile?: string;
  humanColor: Player;
  difficulty: AiDifficulty;
  result: string;
  createdAt: string;
}

export interface RecordHeader extends RecordHeaderInput {
  type: 'header';
  schemaVersion: number;
  boardSize: number;
  rules: 'freestyle';
}

export interface RecordMove {
  type: 'move';
  ply: number;
  player: Player;
  move: number;
  human: boolean;
  quality: 'fast' | 'deep';
  moverBefore: number | null;
  moverAfter: number | null;
  humanBefore: number | null;
  humanAfter: number | null;
  loss: number | null;
  grade: MoveGrade | null;
  tags: CoachVerdict[];
  bestMove: number | null;
  top: SearchTop[] | null;
  /** 开局段：不评级、不打标签、没有最佳着；只在为 true 时写入。 */
  opening?: boolean;
  fast?: { value: number };
}

export interface RecordHash {
  type: 'hash';
  algorithm: 'sha256';
  value: string;
}

export interface BuiltRecord {
  text: string;
  hash: string;
}

/** 四位小数足够区分一手棋的估值差异，又能让记录不因浮点尾巴每次不同。 */
function roundValue(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 1e4) / 1e4;
}

/**
 * 规范化 JSON：对象键排序、数组保持顺序、丢弃 undefined。
 * hash 只认这个形式，所以文件里可以按可读顺序写，校验时重新规范化即可。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    return text === undefined ? 'null' : text;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',');
  return `{${body}}`;
}

export function buildHeader(input: RecordHeaderInput): RecordHeader {
  return {
    type: 'header',
    schemaVersion: RECORD_SCHEMA_VERSION,
    appVersion: input.appVersion,
    engineVersion: input.engineVersion,
    modelVersion: input.modelVersion,
    modelHash: input.modelHash,
    ...(input.reviewProfile ? { reviewProfile: input.reviewProfile } : {}),
    boardSize: SIZE,
    rules: 'freestyle',
    humanColor: input.humanColor,
    difficulty: input.difficulty,
    result: input.result,
    createdAt: input.createdAt,
  };
}

export function buildMoveRecord(move: ReviewedMove): RecordMove {
  // quality 看 status，不看 top：开局段没有 top，但 moverBefore/After 仍是深评值。
  const quality: RecordMove['quality'] =
    move.status === 'done' || move.status === 'deep' ? 'deep' : 'fast';
  const record: RecordMove = {
    type: 'move',
    ply: move.ply,
    player: move.player,
    move: move.move,
    human: move.human,
    quality,
    moverBefore: roundValue(move.moverBefore),
    moverAfter: roundValue(move.moverAfter),
    humanBefore: roundValue(move.humanBefore),
    humanAfter: roundValue(move.humanAfter),
    loss: roundValue(move.loss),
    grade: move.grade,
    tags: move.tags,
    bestMove: move.bestMove,
    top: move.top,
  };
  if (move.opening) record.opening = true;
  // 快速值单独一层：深评覆盖 mover* 之后，网络原始输出仍然留在这里
  if (move.fastValue !== null) record.fast = { value: roundValue(move.fastValue) ?? 0 };
  return record;
}

export function hashRecord(header: RecordHeader, moves: readonly RecordMove[]): string {
  return sha256Hex(canonicalJson({ header, moves }));
}

export function buildRecord(
  header: RecordHeaderInput,
  moves: readonly ReviewedMove[],
): BuiltRecord {
  const headerRecord = buildHeader(header);
  const moveRecords = moves.map(buildMoveRecord);
  const hash = hashRecord(headerRecord, moveRecords);
  const lines = [
    JSON.stringify(headerRecord),
    ...moveRecords.map((move) => JSON.stringify(move)),
    JSON.stringify({ type: 'hash', algorithm: 'sha256', value: hash } satisfies RecordHash),
  ];
  return { text: `${lines.join('\n')}\n`, hash };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlayer = (value: unknown): value is Player => value === 1 || value === 2;

const isGrade = (value: unknown): value is MoveGrade =>
  value === 'best' ||
  value === 'good' ||
  value === 'inaccuracy' ||
  value === 'mistake' ||
  value === 'blunder';

const VERDICTS: ReadonlySet<string> = new Set<CoachVerdict>([
  'missedWin',
  'missedBlockFive',
  'missedBlockOpenThree',
  'goodBlock',
  'goodOpenFour',
]);

const isVerdict = (value: unknown): value is CoachVerdict =>
  typeof value === 'string' && VERDICTS.has(value);

const isNullableNumber = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));

function fail(index: number, reason: string): never {
  throw new Error(`第 ${index + 1} 行：${reason}`);
}

function assertHeader(value: unknown): RecordHeader {
  if (!isObject(value)) throw new Error('首行不是对象');
  if (value.type !== 'header') throw new Error('首行不是 header');
  if (value.schemaVersion !== RECORD_SCHEMA_VERSION) {
    throw new Error(`不支持的 schemaVersion：${String(value.schemaVersion)}`);
  }
  if (value.boardSize !== SIZE) throw new Error(`棋盘尺寸不是 ${SIZE}`);
  if (value.rules !== 'freestyle') throw new Error('规则字段不是 freestyle');
  if (!isPlayer(value.humanColor)) throw new Error('humanColor 非法');
  if (typeof value.difficulty !== 'string') throw new Error('difficulty 缺失');
  if (typeof value.appVersion !== 'string') throw new Error('appVersion 缺失');
  if (typeof value.engineVersion !== 'string') throw new Error('engineVersion 缺失');
  if (typeof value.modelVersion !== 'string') throw new Error('modelVersion 缺失');
  if (value.modelHash !== null && typeof value.modelHash !== 'string') {
    throw new Error('modelHash 必须为字符串或 null');
  }
  if (value.reviewProfile !== undefined && typeof value.reviewProfile !== 'string') {
    throw new Error('reviewProfile 必须为字符串');
  }
  if (typeof value.result !== 'string') throw new Error('result 缺失');
  if (typeof value.createdAt !== 'string') throw new Error('createdAt 缺失');
  return value as unknown as RecordHeader;
}

function assertMove(value: unknown, index: number): RecordMove {
  if (!isObject(value)) fail(index, '不是对象');
  if (value.type !== 'move') fail(index, '不是 move');
  if (typeof value.ply !== 'number' || !Number.isInteger(value.ply) || value.ply < 1) {
    fail(index, 'ply 非法');
  }
  if (!isPlayer(value.player)) fail(index, 'player 非法');
  if (typeof value.move !== 'number' || !Number.isInteger(value.move)) fail(index, 'move 非法');
  if (typeof value.human !== 'boolean') fail(index, 'human 缺失');
  if (value.quality !== 'fast' && value.quality !== 'deep') fail(index, 'quality 非法');
  for (const key of ['moverBefore', 'moverAfter', 'humanBefore', 'humanAfter', 'loss'] as const) {
    if (!isNullableNumber(value[key])) fail(index, `${key} 非法`);
  }
  if (value.grade !== null && !isGrade(value.grade)) fail(index, 'grade 非法');
  if (!Array.isArray(value.tags) || !value.tags.every(isVerdict)) fail(index, 'tags 非法');
  if (!isNullableNumber(value.bestMove)) fail(index, 'bestMove 非法');
  if (value.top !== null && !Array.isArray(value.top)) fail(index, 'top 非法');
  if (value.opening !== undefined && typeof value.opening !== 'boolean') {
    fail(index, 'opening 非法');
  }
  if (value.fast !== undefined) {
    if (!isObject(value.fast) || !isNullableNumber(value.fast.value) || value.fast.value === null) {
      fail(index, 'fast.value 非法');
    }
  }
  return value as unknown as RecordMove;
}

export interface ParsedRecord {
  header: RecordHeader;
  moves: RecordMove[];
}

/**
 * 解析并校验一份记录。导入功能不在这一版，但导出与测试共用同一套规则：
 * 缺字段要立刻报错，不能静默加载半份记录。
 */
export function parseRecord(text: string): ParsedRecord {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error('记录不完整：至少需要 header 与 hash');

  const parsed: unknown[] = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`第 ${index + 1} 行不是合法 JSON`);
    }
  });

  const header = assertHeader(parsed[0]);
  const hashLine = parsed[parsed.length - 1];
  if (!isObject(hashLine) || hashLine.type !== 'hash' || hashLine.algorithm !== 'sha256') {
    throw new Error('末行不是 sha256 hash');
  }

  const moves = parsed.slice(1, -1).map((line, index) => assertMove(line, index + 1));
  const expected = hashRecord(header, moves);
  if (hashLine.value !== expected) {
    throw new Error('记录被修改或不完整：recordHash 不匹配');
  }
  return { header, moves };
}
