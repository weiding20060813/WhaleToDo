// 同步：批次回执 + 逐项明细 + expected_version 冲突检测（纯函数）
// 评审结论要点：
//   · 首版对象类型 task / block / checkin / availability；goal/stage 后续扩展
//   · expected_version 是**服务端对象版本**；拉取游标用独立变更序列，不按手机时间
//   · 手动安排的 locked 必须原样保留（服务端不推断，payload 原样回传）
//   · 批次回执与逐项明细分开：batch 记结果，mutations 记每项 applied/conflict/rejected
import { ApiError } from '../lib/security.ts';

export const SYNC_OBJECT_TYPES = ['task', 'block', 'checkin', 'availability'] as const;
export type SyncObjectType = (typeof SYNC_OBJECT_TYPES)[number];
export type SyncOp = 'create' | 'update' | 'delete';
export type SyncResultKind = 'applied' | 'conflict' | 'rejected';

export interface SyncObject {
  type: SyncObjectType;
  id: string;
  version: number;
  deleted: boolean;
  payload: unknown;
  seq: number;
}

export interface SyncMutationInput {
  objectType: string;
  objectId: string;
  op: string;
  expectedVersion?: number | null;
  payload?: unknown;
}

export interface SyncMutationResult {
  object_type: string;
  object_id: string;
  op: string;
  result: SyncResultKind;
  server_version: number | null;
  reason?: string;
}

export interface MutationOutcome {
  result: SyncMutationResult;
  object: SyncObject | null;   // null 表示不变更
}

function isObjectType(t: string): t is SyncObjectType {
  return (SYNC_OBJECT_TYPES as readonly string[]).includes(t);
}

function isOp(op: string): op is SyncOp {
  return op === 'create' || op === 'update' || op === 'delete';
}

/**
 * 应用一条变更：
 *  - create 要求对象不存在（含未删除）；已存在 → conflict
 *  - update/delete 必须带 expectedVersion 且与服务端版本一致，否则 conflict 并回传当前版本
 *  - delete 已删除时按幂等处理（applied，版本不变）
 */
export function applyMutation(
  current: SyncObject | null,
  m: SyncMutationInput,
  nextSeq: number,
  now: number,
): MutationOutcome {
  const base = { object_type: m.objectType, object_id: m.objectId, op: m.op };

  if (!isObjectType(m.objectType)) {
    return { result: { ...base, result: 'rejected', server_version: current?.version ?? null, reason: 'unsupported_object_type' }, object: null };
  }
  if (!isOp(m.op)) {
    return { result: { ...base, result: 'rejected', server_version: current?.version ?? null, reason: 'unsupported_op' }, object: null };
  }
  if (!m.objectId || m.objectId.length > 64) {
    return { result: { ...base, result: 'rejected', server_version: current?.version ?? null, reason: 'invalid_object_id' }, object: null };
  }
  void now;   // 时间由调用方写入 payload 或日志，纯函数不依赖时钟

  if (m.op === 'create') {
    if (current && !current.deleted) {
      return { result: { ...base, result: 'conflict', server_version: current.version, reason: 'already_exists' }, object: null };
    }
    if (m.payload === undefined || m.payload === null) {
      return { result: { ...base, result: 'rejected', server_version: null, reason: 'payload_required' }, object: null };
    }
    return {
      result: { ...base, result: 'applied', server_version: 1 },
      object: { type: m.objectType, id: m.objectId, version: 1, deleted: false, payload: m.payload, seq: nextSeq },
    };
  }

  if (!current || current.deleted) {
    return {
      result: { ...base, result: 'conflict', server_version: current ? current.version : null, reason: 'not_found' },
      object: null,
    };
  }

  const expected = typeof m.expectedVersion === 'number' ? m.expectedVersion : null;
  if (expected === null || expected !== current.version) {
    return {
      result: { ...base, result: 'conflict', server_version: current.version, reason: 'version_mismatch' },
      object: null,
    };
  }

  if (m.op === 'update') {
    if (m.payload === undefined || m.payload === null) {
      return { result: { ...base, result: 'rejected', server_version: current.version, reason: 'payload_required' }, object: null };
    }
    const version = current.version + 1;
    return {
      result: { ...base, result: 'applied', server_version: version },
      object: { ...current, version, payload: m.payload, seq: nextSeq },
    };
  }

  // delete：墓碑，版本 +1
  const version = current.version + 1;
  return {
    result: { ...base, result: 'applied', server_version: version },
    object: { ...current, version, deleted: true, payload: null, seq: nextSeq },
  };
}

/** 批次整体结论：全部 applied → applied；有 applied 也有冲突 → partial；全失败 → rejected */
export function batchStatus(results: SyncMutationResult[]): 'applied' | 'partial' | 'rejected' {
  if (results.length === 0) return 'rejected';
  const applied = results.filter((r) => r.result === 'applied').length;
  if (applied === results.length) return 'applied';
  if (applied === 0) return 'rejected';
  return 'partial';
}

/** 拉取：按变更序号取游标之后的内容 */
export function pullChanges<T extends { seq: number }>(log: T[], cursor: number, limit = 100) {
  const size = Math.max(1, Math.min(200, Math.floor(limit) || 100));
  const from = log.filter((c) => c.seq > cursor).sort((a, b) => a.seq - b.seq);
  const items = from.slice(0, size);
  const nextCursor = items.length ? items[items.length - 1]!.seq : cursor;
  return { items, next_cursor: nextCursor, has_more: from.length > items.length };
}

/** 校验 push 请求体（网关层用，失败直接 400） */
export function parsePushBody(body: unknown): { batchId: string; deviceId: string; mutations: SyncMutationInput[] } {
  const b = (body ?? {}) as { batch_id?: unknown; device_id?: unknown; mutations?: unknown };
  const batchId = String(b.batch_id ?? '').trim();
  const deviceId = String(b.device_id ?? '').trim();
  if (!batchId || batchId.length > 64) throw new ApiError('VALIDATION_ERROR', 'batch_id 缺失或过长');
  if (!deviceId || deviceId.length > 64) throw new ApiError('VALIDATION_ERROR', 'device_id 缺失或过长');
  if (!Array.isArray(b.mutations) || b.mutations.length === 0) throw new ApiError('VALIDATION_ERROR', 'mutations 不能为空');
  if (b.mutations.length > 200) throw new ApiError('VALIDATION_ERROR', '单批最多 200 项');

  const mutations = b.mutations.map((raw, i) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    if (!m.object_type || !m.object_id || !m.op) {
      throw new ApiError('VALIDATION_ERROR', `第 ${i + 1} 项缺少 object_type/object_id/op`);
    }
    return {
      objectType: String(m.object_type),
      objectId: String(m.object_id),
      op: String(m.op),
      expectedVersion: typeof m.expected_version === 'number' ? m.expected_version : null,
      payload: m.payload,
    } satisfies SyncMutationInput;
  });
  return { batchId, deviceId, mutations };
}
