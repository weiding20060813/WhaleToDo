// 积分账本：纯函数，无数据库依赖，便于单测与复用
// 契约要点（评审已确认）：
//   · type 枚举 award / reserve / settle / release / adjust
//   · available 与 reserved 分开，均不得为负
//   · request_id 只做关联（普通索引），事件幂等键是独立的 event_id
//   · 同一事件重试只返回原结果，不得重复记账
import { ApiError } from '../lib/security.ts';

export type LedgerType = 'award' | 'reserve' | 'settle' | 'release' | 'adjust';

export interface Wallet {
  available: number;
  reserved: number;
}

export interface LedgerEvent {
  /** 事件幂等键：同一 eventId 只允许记账一次 */
  eventId: string;
  type: LedgerType;
  /** 正数表示增加，adjust 允许负数 */
  points: number;
  /** 关联请求（如 AI 请求 ID），可为空，不做唯一约束 */
  requestId?: string;
  reason?: string;
}

export interface AppliedEvent {
  eventId: string;
  type: LedgerType;
  delta: number;
  balanceAfter: number;
  reservedAfter: number;
}

export interface ApplyResult {
  wallet: Wallet;
  applied: AppliedEvent[];
  skipped: string[];   // 已处理过（幂等跳过）的 eventId
}

function assertPoints(points: number, type: LedgerType): void {
  if (!Number.isInteger(points)) {
    throw new ApiError('VALIDATION_ERROR', `points 必须是整数（${type}）`);
  }
  if (type === 'adjust') {
    if (points === 0) throw new ApiError('VALIDATION_ERROR', 'adjust 的 points 不能为 0');
    return;
  }
  if (points <= 0) throw new ApiError('VALIDATION_ERROR', `${type} 的 points 必须为正整数`);
}

/** 单事件记账；不修改入参，返回新钱包 */
export function applyEvent(wallet: Wallet, event: LedgerEvent): { wallet: Wallet; applied: AppliedEvent } {
  assertPoints(event.points, event.type);
  if (!event.eventId) throw new ApiError('VALIDATION_ERROR', '缺少 eventId');

  let { available, reserved } = wallet;
  switch (event.type) {
    case 'award':
      available += event.points;
      break;
    case 'adjust':
      available += event.points;
      break;
    case 'reserve':
      if (available < event.points) {
        throw new ApiError('INSUFFICIENT_POINTS', '可用积分不足', { available, need: event.points });
      }
      available -= event.points;
      reserved += event.points;
      break;
    case 'settle':
      if (reserved < event.points) {
        throw new ApiError('CONFLICT', '预占积分不足，无法结算', { reserved, need: event.points });
      }
      reserved -= event.points;
      break;
    case 'release':
      if (reserved < event.points) {
        throw new ApiError('CONFLICT', '预占积分不足，无法释放', { reserved, need: event.points });
      }
      reserved -= event.points;
      available += event.points;
      break;
    default: {
      const never: never = event.type;
      throw new ApiError('VALIDATION_ERROR', `未知账本类型：${String(never)}`);
    }
  }

  if (available < 0) throw new ApiError('VALIDATION_ERROR', '可用积分不能为负', { available });
  if (reserved < 0) throw new ApiError('VALIDATION_ERROR', '预占积分不能为负', { reserved });

  return {
    wallet: { available, reserved },
    applied: {
      eventId: event.eventId,
      type: event.type,
      delta: event.points,
      balanceAfter: available,
      reservedAfter: reserved,
    },
  };
}

/**
 * 批量记账：按顺序应用，重复 eventId 自动跳过（幂等）。
 * 任一步失败则整体抛出——调用方应在数据库事务中执行，保证不部分落库。
 */
export function applyEvents(wallet: Wallet, events: LedgerEvent[]): ApplyResult {
  const seen = new Set<string>();
  const applied: AppliedEvent[] = [];
  const skipped: string[] = [];
  let current: Wallet = { ...wallet };

  for (const ev of events) {
    if (seen.has(ev.eventId)) {
      skipped.push(ev.eventId);
      continue;
    }
    const res = applyEvent(current, ev);
    current = res.wallet;
    applied.push(res.applied);
    seen.add(ev.eventId);
  }
  return { wallet: current, applied, skipped };
}

/** 余额快照的展示格式（GET /wallet）：只读，不能替代服务端原子校验 */
export function walletView(wallet: Wallet): { available: number; reserved: number; total: number } {
  return { available: wallet.available, reserved: wallet.reserved, total: wallet.available + wallet.reserved };
}
