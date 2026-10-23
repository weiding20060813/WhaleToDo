import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.ts';
import { createMemoryStore, MemoryRepository } from '../src/repo/memory.ts';
import { loadConfig } from '../src/config.ts';
import { claimDailyReward, paginateLedger, DEFAULT_REWARD_POINTS } from '../src/domain/rewards.ts';
import type { LedgerRow } from '../src/domain/rewards.ts';
import { ApiError } from '../src/lib/security.ts';

const testEnv = {
  NODE_ENV: 'test',
  BUSINESS_TIMEZONE: 'Asia/Shanghai',
  PAYMENT_PROVIDER: 'mock',
  MOCK_WEBHOOK_TOKEN: 'local-test-token',
} as NodeJS.ProcessEnv;

let app: FastifyInstance;
let repo: MemoryRepository;

beforeEach(async () => {
  if (app) await app.close();
  repo = new MemoryRepository(createMemoryStore(), () => Date.now());
  app = buildApp({ config: loadConfig(testEnv), repo });
});

type InjectOptions = import('light-my-request').InjectOptions;
const inject = (opts: InjectOptions) => app.inject(opts);

async function newUserToken(username: string): Promise<string> {
  await inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username, password: 'S3cret-passw0rd' } });
  const res = await inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'S3cret-passw0rd' } });
  return res.json().data.access_token;
}

describe('签到纯函数', () => {
  test('首次领取发放默认积分', () => {
    const r = claimDailyReward({
      alreadyClaimed: false, businessDate: '2026-10-23',
      wallet: { available: 0, reserved: 0 }, eventId: 'u1:2026-10-23:sign_in',
    });
    assert.equal(r.pointsAwarded, DEFAULT_REWARD_POINTS);
    assert.deepEqual(r.wallet, { available: DEFAULT_REWARD_POINTS, reserved: 0 });
    assert.equal(r.event.type, 'award');
  });

  test('已领取 → CONFLICT，不再发奖', () => {
    assert.throws(
      () => claimDailyReward({
        alreadyClaimed: true, businessDate: '2026-10-23',
        wallet: { available: 30, reserved: 0 }, eventId: 'u1:2026-10-23:sign_in',
      }),
      (e: unknown) => e instanceof ApiError && e.code === 'CONFLICT' && e.status === 409,
    );
  });

  test('奖励分数可配置且至少为 1', () => {
    const r = claimDailyReward({
      alreadyClaimed: false, businessDate: '2026-10-23', rewardPoints: 0,
      wallet: { available: 0, reserved: 0 }, eventId: 'e',
    });
    assert.equal(r.pointsAwarded, 1);
  });

  test('游标分页：next_cursor 到底后为 null', () => {
    const rows: LedgerRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`, type: 'award', delta: 1, balanceAfter: i + 1, reservedAfter: 0,
      requestId: null, reason: null, createdAt: i,
    }));
    const p1 = paginateLedger(rows, 2);
    assert.deepEqual(p1.items.map((r) => r.id), ['r0', 'r1']);
    assert.equal(p1.next_cursor, 2);
    const p3 = paginateLedger(rows, 2, 4);
    assert.deepEqual(p3.items.map((r) => r.id), ['r4']);
    assert.equal(p3.next_cursor, null);
  });
});

describe('签到接口', () => {
  test('未登录 → 401', async () => {
    const res = await inject({ method: 'GET', url: '/api/v1/rewards/daily' });
    assert.equal(res.statusCode, 401);
  });

  test('查询状态：未领取、给出业务日与奖励值', async () => {
    const token = await newUserToken('sign1');
    const res = await inject({ method: 'GET', url: '/api/v1/rewards/daily', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 200);
    const d = res.json().data;
    assert.match(d.business_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(d.claimed, false);
    assert.equal(d.reward.reward_type, 'sign_in');
  });

  test('领取成功：积分入账、钱包与流水同步', async () => {
    const token = await newUserToken('sign2');
    const claim = await inject({
      method: 'POST', url: '/api/v1/rewards/daily/claim', headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(claim.statusCode, 201);
    const d = claim.json().data;
    assert.equal(d.points_awarded, DEFAULT_REWARD_POINTS);
    assert.equal(d.wallet.available, DEFAULT_REWARD_POINTS);

    const wallet = await inject({ method: 'GET', url: '/api/v1/wallet', headers: { authorization: `Bearer ${token}` } });
    assert.equal(wallet.json().data.available, DEFAULT_REWARD_POINTS);

    const ledger = await inject({ method: 'GET', url: '/api/v1/wallet/ledger', headers: { authorization: `Bearer ${token}` } });
    const items = ledger.json().data.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'award');
    assert.equal(items[0].delta, DEFAULT_REWARD_POINTS);
    assert.equal(items[0].balance_after, DEFAULT_REWARD_POINTS);
  });

  test('同日重复领取 → 409，余额不变', async () => {
    const token = await newUserToken('sign3');
    const h = { authorization: `Bearer ${token}` };
    await inject({ method: 'POST', url: '/api/v1/rewards/daily/claim', headers: h });
    const second = await inject({ method: 'POST', url: '/api/v1/rewards/daily/claim', headers: h });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error.code, 'CONFLICT');

    const wallet = await inject({ method: 'GET', url: '/api/v1/wallet', headers: h });
    assert.equal(wallet.json().data.available, DEFAULT_REWARD_POINTS);
  });

  test('同一 Idempotency-Key 重放 → 返回首次结果，不重复发放', async () => {
    const token = await newUserToken('sign4');
    const h = { authorization: `Bearer ${token}`, 'idempotency-key': 'claim-1' };
    const first = await inject({ method: 'POST', url: '/api/v1/rewards/daily/claim', headers: h });
    const second = await inject({ method: 'POST', url: '/api/v1/rewards/daily/claim', headers: h });
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json().data, first.json().data);

    const wallet = await inject({ method: 'GET', url: '/api/v1/wallet', headers: { authorization: `Bearer ${token}` } });
    assert.equal(wallet.json().data.available, DEFAULT_REWARD_POINTS);
  });

  test('两个用户各自独立领取', async () => {
    const t1 = await newUserToken('sign5');
    const t2 = await newUserToken('sign6');
    const a = await inject({ method: 'POST', url: '/api/v1/rewards/daily/claim', headers: { authorization: `Bearer ${t1}` } });
    const b = await inject({ method: 'POST', url: '/api/v1/rewards/daily/claim', headers: { authorization: `Bearer ${t2}` } });
    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 201);
    const w1 = await inject({ method: 'GET', url: '/api/v1/wallet', headers: { authorization: `Bearer ${t1}` } });
    const w2 = await inject({ method: 'GET', url: '/api/v1/wallet', headers: { authorization: `Bearer ${t2}` } });
    assert.equal(w1.json().data.available, DEFAULT_REWARD_POINTS);
    assert.equal(w2.json().data.available, DEFAULT_REWARD_POINTS);
  });
});
