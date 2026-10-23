// 签到与积分：纯函数，便于单测；数据库落地后由仓储负责持久化。
// 契约要点：
//   · 每用户每业务日每奖励类型只能领一次（唯一键在数据库层，这里做业务判定）
//   · 奖励发放与账本事件必须同一事务提交（调用方负责事务）
//   · event_id 是账本幂等键；request_id 只做关联
import { ApiError } from '../lib/security.ts';
import { applyEvent } from './ledger.ts';
import type { LedgerEvent, Wallet } from './ledger.ts';

export const DEFAULT_REWARD_POINTS = 30;

export interface ClaimInput {
  /** 该用户当个业务日是否已领取 */
  alreadyClaimed: boolean;
  /** 业务日字符串 YYYY-MM-DD（服务端按 BUSINESS_TIMEZONE 生成） */
  businessDate: string;
  rewardPoints?: number;
  wallet: Wallet;
  /** 账本幂等键，建议 `${userId}:${businessDate}:${rewardType}` */
  eventId: string;
  requestId?: string;
}

export interface ClaimResult {
  wallet: Wallet;
  pointsAwarded: number;
  event: LedgerEvent;
  businessDate: string;
}

/** 领取每日签到奖励；已领取则抛 CONFLICT（不再发奖，也不会重复记账） */
export function claimDailyReward(input: ClaimInput): ClaimResult {
  if (input.alreadyClaimed) {
    throw new ApiError('CONFLICT', '今日已领取签到奖励', { business_date: input.businessDate });
  }
  const points = Math.max(1, Math.floor(input.rewardPoints ?? DEFAULT_REWARD_POINTS));
  const event: LedgerEvent = {
    eventId: input.eventId,
    type: 'award',
    points,
    requestId: input.requestId,
    reason: `sign-in:${input.businessDate}`,
  };
  const { wallet } = applyEvent(input.wallet, event);
  return { wallet, pointsAwarded: points, event, businessDate: input.businessDate };
}

export interface LedgerRow {
  id: string;
  type: string;
  delta: number;
  balanceAfter: number;
  reservedAfter: number;
  requestId: string | null;
  reason: string | null;
  createdAt: number;
}

/** 游标分页：游标就是上一页最后一条的序号（从 0 开始），实现简单且稳定 */
export function paginateLedger(rows: LedgerRow[], limit: number, cursor?: number) {
  const size = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  const start = Math.max(0, Math.floor(cursor ?? 0));
  const slice = rows.slice(start, start + size);
  const next = start + slice.length < rows.length ? start + slice.length : null;
  return { items: slice, next_cursor: next };
}
