import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, applyEvents, walletView } from '../src/domain/ledger.ts';
import type { LedgerEvent, Wallet } from '../src/domain/ledger.ts';
import { ApiError } from '../src/lib/security.ts';

const empty: Wallet = { available: 0, reserved: 0 };
const ev = (over: Partial<LedgerEvent> = {}): LedgerEvent => ({
  eventId: 'e1', type: 'award', points: 10, ...over,
});

describe('账本：单事件', () => {
  test('签到发奖：available 增加，reserved 不变', () => {
    const r = applyEvent(empty, ev({ type: 'award', points: 20 }));
    assert.deepEqual(r.wallet, { available: 20, reserved: 0 });
    assert.equal(r.applied.balanceAfter, 20);
    assert.equal(r.applied.reservedAfter, 0);
  });

  test('预占：available 减少、reserved 等量增加（总量不变）', () => {
    const r = applyEvent({ available: 30, reserved: 0 }, ev({ type: 'reserve', points: 12 }));
    assert.deepEqual(r.wallet, { available: 18, reserved: 12 });
    assert.equal(r.wallet.available + r.wallet.reserved, 30);
  });

  test('预占超过余额 → INSUFFICIENT_POINTS', () => {
    assert.throws(
      () => applyEvent({ available: 5, reserved: 0 }, ev({ type: 'reserve', points: 10 })),
      (e: unknown) => e instanceof ApiError && e.code === 'INSUFFICIENT_POINTS' && e.status === 402,
    );
  });

  test('结算：reserved 减少，总量减少（真实消费）', () => {
    const r = applyEvent({ available: 18, reserved: 12 }, ev({ type: 'settle', points: 12 }));
    assert.deepEqual(r.wallet, { available: 18, reserved: 0 });
  });

  test('结算超过预占 → CONFLICT', () => {
    assert.throws(
      () => applyEvent({ available: 0, reserved: 3 }, ev({ type: 'settle', points: 5 })),
      (e: unknown) => e instanceof ApiError && e.code === 'CONFLICT',
    );
  });

  test('释放：预占退回可用（失败/取消场景）', () => {
    const r = applyEvent({ available: 18, reserved: 12 }, ev({ type: 'release', points: 12 }));
    assert.deepEqual(r.wallet, { available: 30, reserved: 0 });
  });

  test('调整允许负数，但不能把可用积分调成负数', () => {
    const down = applyEvent({ available: 10, reserved: 0 }, ev({ type: 'adjust', points: -4 }));
    assert.deepEqual(down.wallet, { available: 6, reserved: 0 });
    assert.throws(
      () => applyEvent({ available: 10, reserved: 0 }, ev({ type: 'adjust', points: -11 })),
      (e: unknown) => e instanceof ApiError && e.code === 'VALIDATION_ERROR',
    );
  });

  test('非法输入被拒：非整数、非正数、缺 eventId、未知类型', () => {
    const cases: LedgerEvent[] = [
      ev({ points: 1.5 }),
      ev({ type: 'award', points: 0 }),
      ev({ type: 'reserve', points: -3 }),
      ev({ type: 'adjust', points: 0 }),
      ev({ eventId: '' }),
      ev({ type: 'unknown' as never }),
    ];
    for (const c of cases) {
      assert.throws(() => applyEvent({ available: 100, reserved: 0 }, c), (e: unknown) => e instanceof ApiError);
    }
  });

  test('不修改入参（纯函数）', () => {
    const wallet: Wallet = { available: 5, reserved: 5 };
    applyEvent(wallet, ev({ type: 'award', points: 1 }));
    assert.deepEqual(wallet, { available: 5, reserved: 5 });
  });
});

describe('账本：批量与幂等', () => {
  test('重复 eventId 被跳过（同一次重试不会重复记账）', () => {
    const r = applyEvents(empty, [
      ev({ eventId: 'a1', type: 'award', points: 20 }),
      ev({ eventId: 'a1', type: 'award', points: 20 }),   // 重放
      ev({ eventId: 'a2', type: 'award', points: 10 }),
    ]);
    assert.deepEqual(r.wallet, { available: 30, reserved: 0 });
    assert.deepEqual(r.skipped, ['a1']);
    assert.equal(r.applied.length, 2);
  });

  test('同一 requestId 下多个事件各自独立幂等', () => {
    const r = applyEvents({ available: 100, reserved: 0 }, [
      ev({ eventId: 'r1', type: 'reserve', points: 30, requestId: 'req-ai-1' }),
      ev({ eventId: 'r2', type: 'settle', points: 30, requestId: 'req-ai-1' }),
    ]);
    assert.deepEqual(r.wallet, { available: 70, reserved: 0 });
  });

  test('中途失败整体抛出，钱包保持原值（对应数据库事务回滚）', () => {
    const wallet: Wallet = { available: 10, reserved: 0 };
    assert.throws(() => applyEvents(wallet, [
      ev({ eventId: 'x1', type: 'award', points: 5 }),
      ev({ eventId: 'x2', type: 'reserve', points: 999 }),
    ]), (e: unknown) => e instanceof ApiError && e.code === 'INSUFFICIENT_POINTS');
    assert.deepEqual(wallet, { available: 10, reserved: 0 });
  });

  test('完整业务流程：签到→预占→结算 / 签到→预占→释放', () => {
    const signIn = applyEvents(empty, [ev({ eventId: 'd1', type: 'award', points: 30 })]);
    assert.deepEqual(signIn.wallet, { available: 30, reserved: 0 });

    const aiOk = applyEvents(signIn.wallet, [
      ev({ eventId: 'a2', type: 'reserve', points: 10, requestId: 'req-2' }),
      ev({ eventId: 'a3', type: 'settle', points: 10, requestId: 'req-2' }),
    ]);
    assert.deepEqual(aiOk.wallet, { available: 20, reserved: 0 });

    const aiFail = applyEvents(aiOk.wallet, [
      ev({ eventId: 'a4', type: 'reserve', points: 10, requestId: 'req-3' }),
      ev({ eventId: 'a5', type: 'release', points: 10, requestId: 'req-3' }),
    ]);
    assert.deepEqual(aiFail.wallet, { available: 20, reserved: 0 });
  });
});

describe('余额展示', () => {
  test('walletView 汇总 total', () => {
    assert.deepEqual(walletView({ available: 7, reserved: 3 }), { available: 7, reserved: 3, total: 10 });
  });
});
