import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.ts';
import { createMemoryStore, MemoryRepository } from '../src/repo/memory.ts';
import { loadConfig } from '../src/config.ts';
import { buildOrder, applyPaymentResult, assertMockWebhookAllowed } from '../src/domain/billing.ts';
import type { Product } from '../src/domain/billing.ts';
import { ApiError } from '../src/lib/security.ts';

const testEnv = {
  NODE_ENV: 'test',
  BUSINESS_TIMEZONE: 'Asia/Shanghai',
  PAYMENT_PROVIDER: 'mock',
  MOCK_WEBHOOK_TOKEN: 'local-test-token',
} as NodeJS.ProcessEnv;

const product: Product = {
  productId: 'vip_30d', title: 'VIP 30 天', priceMinor: 1200,
  currency: 'CNY', vipDays: 30, points: 0, active: true,
};

let app: FastifyInstance;
let repo: MemoryRepository;

beforeEach(async () => {
  if (app) await app.close();
  repo = new MemoryRepository(createMemoryStore(), () => Date.now());
  app = buildApp({ config: loadConfig(testEnv), repo });
});

type InjectOptions = import('light-my-request').InjectOptions;
const inject = (opts: InjectOptions) => app.inject(opts);

async function token(name: string): Promise<string> {
  await inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: name, password: 'S3cret-passw0rd' } });
  const r = await inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: name, password: 'S3cret-passw0rd' } });
  return r.json().data.access_token;
}

describe('订单纯函数', () => {
  test('金额与币种来自商品，不接受客户端传入', () => {
    const o = buildOrder({
      id: 'o1', userId: 'u1', product, idempotencyKey: 'k1', environment: 'mock', now: 1000,
    });
    assert.equal(o.amountMinor, 1200);
    assert.equal(o.currency, 'CNY');
    assert.equal(o.status, 'PENDING');
    assert.equal(o.paidAt, null);
  });

  test('下架商品 → CONFLICT；缺幂等键 → VALIDATION_ERROR', () => {
    assert.throws(
      () => buildOrder({ id: 'o', userId: 'u', product: { ...product, active: false }, idempotencyKey: 'k', environment: 'mock', now: 1 }),
      (e: unknown) => e instanceof ApiError && e.code === 'CONFLICT',
    );
    assert.throws(
      () => buildOrder({ id: 'o', userId: 'u', product, idempotencyKey: '', environment: 'mock', now: 1 }),
      (e: unknown) => e instanceof ApiError && e.code === 'VALIDATION_ERROR',
    );
  });

  test('支付成功 → PAID + VIP 权益；重复事件幂等', () => {
    const o = buildOrder({ id: 'o1', userId: 'u1', product, idempotencyKey: 'k', environment: 'mock', now: 1000 });
    const first = applyPaymentResult(o, { eventId: 'e1', status: 'succeeded', amountMinor: 1200, currency: 'CNY' }, product, 2000);
    assert.equal(first.order.status, 'PAID');
    assert.equal(first.changed, true);
    assert.ok(first.entitlement);
    assert.equal(first.entitlement!.kind, 'vip');
    assert.equal(first.entitlement!.expiresAt, 2000 + 30 * 86400_000);

    const again = applyPaymentResult(first.order, { eventId: 'e1', status: 'succeeded', amountMinor: 1200, currency: 'CNY' }, product, 3000);
    assert.equal(again.changed, false);
    assert.equal(again.entitlement, null);
  });

  test('金额/币种不一致 → VALIDATION_ERROR', () => {
    const o = buildOrder({ id: 'o1', userId: 'u1', product, idempotencyKey: 'k', environment: 'mock', now: 1 });
    assert.throws(
      () => applyPaymentResult(o, { eventId: 'e', status: 'succeeded', amountMinor: 1, currency: 'CNY' }, product, 2),
      (e: unknown) => e instanceof ApiError && e.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => applyPaymentResult(o, { eventId: 'e', status: 'succeeded', amountMinor: 1200, currency: 'USD' }, product, 2),
      (e: unknown) => e instanceof ApiError && e.code === 'VALIDATION_ERROR',
    );
  });

  test('退款：未支付不能退；已支付可退', () => {
    const o = buildOrder({ id: 'o1', userId: 'u1', product, idempotencyKey: 'k', environment: 'mock', now: 1 });
    assert.throws(
      () => applyPaymentResult(o, { eventId: 'e', status: 'refunded', amountMinor: 1200, currency: 'CNY' }, product, 2),
      (e: unknown) => e instanceof ApiError && e.code === 'CONFLICT',
    );
    const paid = applyPaymentResult(o, { eventId: 'e1', status: 'succeeded', amountMinor: 1200, currency: 'CNY' }, product, 2).order;
    const refunded = applyPaymentResult(paid, { eventId: 'e2', status: 'refunded', amountMinor: 1200, currency: 'CNY' }, product, 3);
    assert.equal(refunded.order.status, 'REFUNDED');
  });

  test('模拟回调通道与令牌校验', () => {
    assert.throws(() => assertMockWebhookAllowed('real', 'x', 'x'), (e: unknown) => e instanceof ApiError && e.code === 'FORBIDDEN');
    assert.throws(() => assertMockWebhookAllowed('mock', 'bad', 'good'), (e: unknown) => e instanceof ApiError && e.code === 'FORBIDDEN');
    assert.doesNotThrow(() => assertMockWebhookAllowed('mock', 'good', 'good'));
  });
});

describe('商品与订单接口', () => {
  test('商品列表需要登录；返回服务端定价', async () => {
    const noAuth = await inject({ method: 'GET', url: '/api/v1/products' });
    assert.equal(noAuth.statusCode, 401);

    const t = await token('buy1');
    const res = await inject({ method: 'GET', url: '/api/v1/products', headers: { authorization: `Bearer ${t}` } });
    assert.equal(res.statusCode, 200);
    const items = res.json().data.items;
    assert.equal(items.length, 2);
    assert.equal(items[0].price_minor, 1200);
    assert.equal(items[0].currency, 'CNY');
  });

  test('建单 201，金额由服务端决定；同幂等键返回同一订单', async () => {
    const t = await token('buy2');
    const h = { authorization: `Bearer ${t}`, 'idempotency-key': 'order-1' };
    const first = await inject({ method: 'POST', url: '/api/v1/orders', headers: h, payload: { product_id: 'vip_30d', amount_minor: 1 } });
    assert.equal(first.statusCode, 201);
    const d1 = first.json().data;
    assert.equal(d1.amount_minor, 1200, '客户端传的金额必须被忽略');
    assert.equal(d1.status, 'PENDING');

    const second = await inject({ method: 'POST', url: '/api/v1/orders', headers: h, payload: { product_id: 'vip_30d' } });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().data.order_id, d1.order_id);
  });

  test('缺幂等键 / 未知商品 → 400', async () => {
    const t = await token('buy3');
    const noKey = await inject({ method: 'POST', url: '/api/v1/orders', headers: { authorization: `Bearer ${t}` }, payload: { product_id: 'vip_30d' } });
    assert.equal(noKey.statusCode, 400);
    const bad = await inject({ method: 'POST', url: '/api/v1/orders', headers: { authorization: `Bearer ${t}`, 'idempotency-key': 'k' }, payload: { product_id: 'nope' } });
    assert.equal(bad.statusCode, 400);
  });

  test('订单归属：他人访问 → 403', async () => {
    const ta = await token('buy4');
    const tb = await token('buy5');
    const created = await inject({
      method: 'POST', url: '/api/v1/orders',
      headers: { authorization: `Bearer ${ta}`, 'idempotency-key': 'k1' },
      payload: { product_id: 'vip_30d' },
    });
    const id = created.json().data.order_id;

    const mine = await inject({ method: 'GET', url: `/api/v1/orders/${id}`, headers: { authorization: `Bearer ${ta}` } });
    assert.equal(mine.statusCode, 200);
    const other = await inject({ method: 'GET', url: `/api/v1/orders/${id}`, headers: { authorization: `Bearer ${tb}` } });
    assert.equal(other.statusCode, 403);
  });
});

describe('模拟支付回调', () => {
  async function createOrder(t: string, key = 'pay-1') {
    const r = await inject({
      method: 'POST', url: '/api/v1/orders',
      headers: { authorization: `Bearer ${t}`, 'idempotency-key': key },
      payload: { product_id: 'vip_30d' },
    });
    return r.json().data.order_id as string;
  }

  test('缺少或错误的内部令牌 → 403', async () => {
    const t = await token('pay1');
    const orderId = await createOrder(t);
    const noToken = await inject({ method: 'POST', url: '/api/v1/payments/mock/webhook', payload: { event_id: 'e1', order_id: orderId, status: 'succeeded' } });
    assert.equal(noToken.statusCode, 403);
    const badToken = await inject({ method: 'POST', url: '/api/v1/payments/mock/webhook', headers: { 'x-mock-token': 'bad' }, payload: { event_id: 'e1', order_id: orderId, status: 'succeeded' } });
    assert.equal(badToken.statusCode, 403);
  });

  test('成功回调：订单转 PAID 并发放 VIP 权益；重复事件幂等', async () => {
    const t = await token('pay2');
    const orderId = await createOrder(t, 'pay-2');
    const h = { 'x-mock-token': 'local-test-token' };
    const body = { event_id: 'evt-1', order_id: orderId, status: 'succeeded', amount_minor: 1200, currency: 'CNY' };

    const first = await inject({ method: 'POST', url: '/api/v1/payments/mock/webhook', headers: h, payload: body });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().data.status, 'PAID');
    assert.equal(first.json().data.entitlement.kind, 'vip');

    const again = await inject({ method: 'POST', url: '/api/v1/payments/mock/webhook', headers: h, payload: body });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().data.duplicated, true);

    const order = await inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: { authorization: `Bearer ${t}` } });
    assert.equal(order.json().data.status, 'PAID');
    assert.ok(order.json().data.paid_at > 0);
  });

  test('金额被篡改 → 400，订单保持 PENDING', async () => {
    const t = await token('pay3');
    const orderId = await createOrder(t, 'pay-3');
    const res = await inject({
      method: 'POST', url: '/api/v1/payments/mock/webhook',
      headers: { 'x-mock-token': 'local-test-token' },
      payload: { event_id: 'evt-bad', order_id: orderId, status: 'succeeded', amount_minor: 1, currency: 'CNY' },
    });
    assert.equal(res.statusCode, 400);
    const order = await inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: { authorization: `Bearer ${t}` } });
    assert.equal(order.json().data.status, 'PENDING');
  });
});
