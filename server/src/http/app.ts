// Fastify 应用：统一响应包、请求 ID、错误映射、幂等键与账户路由。
// 端点全部挂在 /api/v1 下（与 Nginx 约定的 api.whaletodo.top:8443/api/v1 一致）。
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from '../lib/security.ts';
import { MemoryRepository } from '../repo/memory.ts';
import type { ServerConfig } from '../config.ts';
import { businessDate } from '../config.ts';
import { claimDailyReward, paginateLedger, DEFAULT_REWARD_POINTS } from '../domain/rewards.ts';
import type { LedgerRow } from '../domain/rewards.ts';
import { buildOrder, applyPaymentResult, assertMockWebhookAllowed } from '../domain/billing.ts';
import type { Order, Product, Entitlement } from '../domain/billing.ts';
import { applyMutation, batchStatus, pullChanges, parsePushBody } from '../domain/sync.ts';
import type { SyncObject, SyncMutationResult } from '../domain/sync.ts';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    userId?: string;
    sessionId?: string;
  }
}

export interface AppDeps {
  config: ServerConfig;
  repo: MemoryRepository;
  logger?: boolean;
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;

function ok(requestId: string, data: unknown) {
  return { request_id: requestId, data };
}

/**
 * 幂等指纹：HMAC-SHA256（进程内随机密钥）。
 * 只存摘要，**不存原始请求体**——否则注册密码会以明文留在幂等缓存里。
 */
const IDEMPOTENCY_FINGERPRINT_KEY = randomBytes(32);
/** 订单对外视图（不暴露幂等键等内部字段） */
function orderView(o: Order) {
  return {
    order_id: o.id, product_id: o.productId, amount_minor: o.amountMinor,
    currency: o.currency, status: o.status, environment: o.environment,
    created_at: o.createdAt, paid_at: o.paidAt,
  };
}

function fingerprintOf(body: unknown): string {
  return createHmac('sha256', IDEMPOTENCY_FINGERPRINT_KEY)
    .update(JSON.stringify(body ?? null))
    .digest('hex');
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, repo } = deps;
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: config.trustProxy,
    genReqId: () => randomUUID(),
  });

  /* ---------- 请求 ID 与统一错误 ---------- */
  app.decorateRequest('requestId', '');
  app.addHook('onRequest', async (req: FastifyRequest) => {
    req.requestId = String(req.id ?? randomUUID());
    req.raw.headers['x-request-id'] = req.requestId;
  });

  app.setErrorHandler((err, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send(err.toBody(req.requestId));
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status === 400) {
      return reply.code(400).send(new ApiError('VALIDATION_ERROR', err instanceof Error ? err.message : '请求无效').toBody(req.requestId));
    }
    req.log.error({ err }, 'unhandled');
    return reply.code(500).send(new ApiError('INTERNAL', '服务器内部错误').toBody(req.requestId));
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send(new ApiError('VALIDATION_ERROR', `未知端点：${req.method} ${req.url}`).toBody(req.requestId)));

  /* ---------- 鉴权 ---------- */
  async function requireAuth(req: FastifyRequest): Promise<void> {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/.exec(header);
    if (!m) throw new ApiError('UNAUTHENTICATED', '缺少访问令牌');
    const session = repo.findActiveSessionByAccess(m[1]!.trim());
    if (!session) throw new ApiError('UNAUTHENTICATED', '访问令牌无效、已撤销或已过期');
    req.userId = session.userId;
    req.sessionId = session.id;
  }

  /* ---------- 健康检查（无鉴权） ---------- */
  app.get('/api/v1/health/live', async (req) => ok(req.requestId, { status: 'ok' }));

  app.get('/api/v1/health/ready', async (req) => ok(req.requestId, {
    status: 'ok',
    database: 'memory',                 // 接入 Prisma 后改为真实探测
    payment_provider: config.paymentProvider,
    business_timezone: config.businessTimezone,
  }));

  /* ---------- 注册 ---------- */
  app.post('/api/v1/auth/register', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string; display_name?: string };
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    if (!USERNAME_RE.test(username)) {
      throw new ApiError('VALIDATION_ERROR', '用户名需为 3~32 位字母、数字或下划线');
    }
    if (password.length < 8 || password.length > 200) {
      throw new ApiError('VALIDATION_ERROR', '密码长度需在 8~200 字符之间');
    }

    // 幂等：同 key 同体重放返回原结果；同 key 不同体返回 CONFLICT
    const idemKey = String(req.headers['idempotency-key'] ?? '').trim();
    const scopeKey = idemKey ? `register:${idemKey}` : '';
    if (scopeKey) {
      const hit = repo.getIdempotent(scopeKey);
      if (hit) {
        if (hit.fingerprint !== fingerprintOf({ username, password, display_name: body.display_name ?? null })) {
          throw new ApiError('CONFLICT', '相同 Idempotency-Key 的请求体不一致');
        }
        return reply.code(201).send(hit.response);
      }
    }

    if (repo.findUserByUsername(username)) {
      throw new ApiError('CONFLICT', '用户名已被占用');
    }
    const user = repo.createUser(username, password, body.display_name);
    const response = ok(req.requestId, {
      user: { id: user.id, username: user.username, display_name: user.displayName },
    });
    if (scopeKey) repo.saveIdempotent(scopeKey, fingerprintOf({ username, password, display_name: body.display_name ?? null }), response);
    return reply.code(201).send(response);
  });

  /* ---------- 登录 ---------- */
  app.post('/api/v1/auth/login', async (req) => {
    const body = (req.body ?? {}) as { username?: string; password?: string };
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    if (!username || !password) throw new ApiError('VALIDATION_ERROR', '用户名与密码不能为空');

    const user = repo.authenticate(username, password);
    // 账号不存在与密码错误返回同一个错误，避免枚举账号
    if (!user) throw new ApiError('UNAUTHENTICATED', '用户名或密码错误');

    const { tokens } = repo.createSession(user.id);
    return ok(req.requestId, {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor((tokens.accessExpiresAt - Date.now()) / 1000),
      refresh_expires_in: Math.floor((tokens.refreshExpiresAt - Date.now()) / 1000),
      user: { id: user.id, username: user.username, display_name: user.displayName },
    });
  });

  /* ---------- 刷新（轮换 + 重放整串撤销） ---------- */
  app.post('/api/v1/auth/refresh', async (req) => {
    const body = (req.body ?? {}) as { refresh_token?: string };
    const token = String(body.refresh_token ?? '').trim();
    if (!token) throw new ApiError('VALIDATION_ERROR', 'refresh_token 不能为空');

    const session = repo.findSessionByRefresh(token);
    if (!session) throw new ApiError('UNAUTHENTICATED', '刷新令牌无效');

    if (session.revokedAt !== null) {
      // 已轮换过的 refresh 被再次使用 → 判定为泄漏，整串撤销
      repo.revokeFamily(session.familyId);
      throw new ApiError('UNAUTHENTICATED', '刷新令牌已失效，请重新登录');
    }
    if (session.refreshExpiresAt <= Date.now()) {
      repo.revokeSession(session.id);
      throw new ApiError('UNAUTHENTICATED', '刷新令牌已过期，请重新登录');
    }

    repo.revokeSession(session.id);
    const { tokens } = repo.createSession(session.userId, session.familyId);
    return ok(req.requestId, {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor((tokens.accessExpiresAt - Date.now()) / 1000),
    });
  });

  /* ---------- 退出 ---------- */
  app.post('/api/v1/auth/logout', async (req, reply) => {
    await requireAuth(req);
    repo.revokeSession(req.sessionId!);
    return reply.code(204).send();
  });

  /* ---------- 个人资料 ---------- */
  app.get('/api/v1/me', async (req) => {
    await requireAuth(req);
    const user = repo.findUserById(req.userId!);
    if (!user) throw new ApiError('UNAUTHENTICATED', '账号不存在');
    return ok(req.requestId, {
      user: { id: user.id, username: user.username, display_name: user.displayName, created_at: new Date(user.createdAt).toISOString() },
    });
  });

  /* ---------- 权益（VIP 权益未冻结，只返回身份与到期时间占位） ---------- */
  app.get('/api/v1/me/entitlements', async (req) => {
    await requireAuth(req);
    const wallet = repo.walletOf(req.userId!);
    return ok(req.requestId, {
      vip: { active: false, expires_at: null },      // 具体权益待定，不默认无限调用
      balance: { available: wallet.available, reserved: wallet.reserved },
      daily_quota: { claimed_today: false, points: 0, reward_points: 0 },
    });
  });

  /* ---------- 签到与积分（内存实现；接 Prisma 后换成事务 + 唯一约束） ---------- */
  // key = `${userId}:${businessDate}:${rewardType}`；数据库落地后由唯一键保证
  const claims = new Map<string, number>();
  const ledgerRows: LedgerRow[] = [];

  app.get('/api/v1/rewards/daily', async (req) => {
    await requireAuth(req);
    const date = businessDate(new Date(), config.businessTimezone);
    const claimed = claims.has(`${req.userId}:${date}:sign_in`);
    const wallet = repo.walletOf(req.userId!);
    return ok(req.requestId, {
      business_date: date,
      claimed,
      reward: { reward_type: 'sign_in', points: DEFAULT_REWARD_POINTS },
      balance: { available: wallet.available, reserved: wallet.reserved },
    });
  });

  app.post('/api/v1/rewards/daily/claim', async (req, reply) => {
    await requireAuth(req);
    const date = businessDate(new Date(), config.businessTimezone);
    const claimKey = `${req.userId}:${date}:sign_in`;
    const wallet = repo.walletOf(req.userId!);
    const idemKey = String(req.headers['idempotency-key'] ?? '').trim();

    // 幂等：同 key 重放直接返回首次结果（客户端重试不会重复领奖）
    if (idemKey) {
      const hit = repo.getIdempotent(`claim:${req.userId}:${idemKey}`);
      if (hit) return reply.code(200).send(hit.response);
    }

    const result = claimDailyReward({
      alreadyClaimed: claims.has(claimKey),
      businessDate: date,
      rewardPoints: DEFAULT_REWARD_POINTS,
      wallet,
      eventId: claimKey,
      requestId: req.requestId,
    });

    claims.set(claimKey, result.pointsAwarded);
    repo.setWallet(req.userId!, result.wallet);
    ledgerRows.unshift({
      id: randomUUID(),
      type: 'award',
      delta: result.pointsAwarded,
      balanceAfter: result.wallet.available,
      reservedAfter: result.wallet.reserved,
      requestId: req.requestId,
      reason: result.event.reason ?? null,
      createdAt: Date.now(),
    });

    const response = ok(req.requestId, {
      business_date: date,
      points_awarded: result.pointsAwarded,
      wallet: { available: result.wallet.available, reserved: result.wallet.reserved },
    });
    if (idemKey) repo.saveIdempotent(`claim:${req.userId}:${idemKey}`, fingerprintOf({ date }), response);
    return reply.code(201).send(response);
  });

  app.get('/api/v1/wallet', async (req) => {
    await requireAuth(req);
    const w = repo.walletOf(req.userId!);
    return ok(req.requestId, { available: w.available, reserved: w.reserved, total: w.available + w.reserved });
  });

  app.get('/api/v1/wallet/ledger', async (req) => {
    await requireAuth(req);
    const q = (req.query ?? {}) as { limit?: string; cursor?: string };
    const page = paginateLedger(ledgerRows, Number(q.limit ?? 50), Number(q.cursor ?? 0));
    return ok(req.requestId, {
      items: page.items.map((r) => ({
        id: r.id, type: r.type, delta: r.delta,
        balance_after: r.balanceAfter, reserved_after: r.reservedAfter,
        request_id: r.requestId, reason: r.reason, created_at: r.createdAt,
      })),
      next_cursor: page.next_cursor,
    });
  });

/* ---------- 商品、订单与模拟支付（内存实现；接 Prisma 后换事务） ---------- */
  const products = new Map<string, Product>([
    ['vip_30d', { productId: 'vip_30d', title: 'VIP 30 天', priceMinor: 1200, currency: 'CNY', vipDays: 30, points: 0, active: true }],
    ['points_300', { productId: 'points_300', title: '积分 300', priceMinor: 600, currency: 'CNY', vipDays: 0, points: 300, active: true }],
  ]);
  const orders = new Map<string, Order>();
  const orderIdem = new Map<string, string>();          // `${userId}:${key}` -> orderId
  const paidEvents = new Set<string>();                  // `${provider}:${eventId}`
  const entitlementsOf = new Map<string, Entitlement[]>(); // userId -> entitlements

  app.get('/api/v1/products', async (req) => {
    await requireAuth(req);
    return ok(req.requestId, {
      items: [...products.values()].filter((p) => p.active).map((p) => ({
        product_id: p.productId, title: p.title,
        price_minor: p.priceMinor, currency: p.currency,
        vip_days: p.vipDays, points: p.points,
      })),
    });
  });

  app.post('/api/v1/orders', async (req, reply) => {
    await requireAuth(req);
    const body = (req.body ?? {}) as { product_id?: string };
    const product = products.get(String(body.product_id ?? ''));
    if (!product) throw new ApiError('VALIDATION_ERROR', '未知商品');

    const idemKey = String(req.headers['idempotency-key'] ?? '').trim();
    if (!idemKey) throw new ApiError('VALIDATION_ERROR', '缺少 Idempotency-Key');
    const scoped = `${req.userId}:${idemKey}`;

    const existed = orderIdem.get(scoped);
    if (existed) {
      const prev = orders.get(existed)!;
      return reply.code(200).send(ok(req.requestId, orderView(prev)));
    }

    const order = buildOrder({
      id: randomUUID(), userId: req.userId!, product, idempotencyKey: idemKey,
      environment: config.paymentProvider === 'mock' ? 'mock' : 'production',
      now: Date.now(),
    });
    orders.set(order.id, order);
    orderIdem.set(scoped, order.id);
    return reply.code(201).send(ok(req.requestId, orderView(order)));
  });

  app.get('/api/v1/orders/:id', async (req) => {
    await requireAuth(req);
    const { id } = req.params as { id: string };
    const order = orders.get(id);
    // 越权与不存在返回同一错误，避免枚举订单号
    if (!order || order.userId !== req.userId) throw new ApiError('FORBIDDEN', '订单不存在或无权访问');
    return ok(req.requestId, orderView(order));
  });

  app.post('/api/v1/payments/mock/webhook', async (req, reply) => {
    assertMockWebhookAllowed(config.paymentProvider, String(req.headers['x-mock-token'] ?? ''), config.mockWebhookToken);
    const body = (req.body ?? {}) as {
      event_id?: string; order_id?: string; status?: string; amount_minor?: number; currency?: string;
    };
    const eventId = String(body.event_id ?? '');
    const orderId = String(body.order_id ?? '');
    const status = String(body.status ?? '') as 'succeeded' | 'failed' | 'refunded';
    if (!eventId || !orderId) throw new ApiError('VALIDATION_ERROR', '缺少 event_id 或 order_id');
    if (!['succeeded', 'failed', 'refunded'].includes(status)) throw new ApiError('VALIDATION_ERROR', '非法支付状态');

    const dedupeKey = `mock:${eventId}`;
    const order = orders.get(orderId);
    if (!order) throw new ApiError('VALIDATION_ERROR', '订单不存在');

    if (paidEvents.has(dedupeKey)) {
      return reply.code(200).send(ok(req.requestId, { order_id: order.id, status: order.status, duplicated: true }));
    }

    const product = products.get(order.productId)!;
    const applied = applyPaymentResult(order, {
      eventId, status,
      amountMinor: Number(body.amount_minor ?? order.amountMinor),
      currency: String(body.currency ?? order.currency),
    }, product, Date.now());

    paidEvents.add(dedupeKey);
    orders.set(applied.order.id, applied.order);
    if (applied.entitlement) {
      const list = entitlementsOf.get(applied.order.userId) ?? [];
      list.push(applied.entitlement);
      entitlementsOf.set(applied.order.userId, list);
    }
    return reply.code(200).send(ok(req.requestId, {
      order_id: applied.order.id, status: applied.order.status,
      entitlement: applied.entitlement ? { kind: applied.entitlement.kind, expires_at: applied.entitlement.expiresAt } : null,
      duplicated: false,
    }));
  });

/* ---------- 同步（内存实现；接 Prisma 后按 sync_batches/sync_mutations 落库） ---------- */
  const syncObjects = new Map<string, SyncObject>();          // `${type}:${id}`
  const syncLog: Array<{ seq: number; object_type: string; object_id: string; version: number; deleted: boolean; payload: unknown }> = [];
  const syncReceipts = new Map<string, unknown>();            // `${userId}:${batchId}` -> receipt
  let syncSeq = 0;

  app.post('/api/v1/sync/push', async (req, reply) => {
    await requireAuth(req);
    const { batchId, deviceId, mutations } = parsePushBody(req.body);

    // 批次幂等：同一 batch_id 重放直接返回首次回执
    const receiptKey = `${req.userId}:${batchId}`;
    const existed = syncReceipts.get(receiptKey);
    if (existed) return reply.code(200).send(existed);

    const now = Date.now();
    const results: SyncMutationResult[] = [];
    for (const m of mutations) {
      const key = `${m.objectType}:${m.objectId}`;
      const current = syncObjects.get(key) ?? null;
      const outcome = applyMutation(current, m, syncSeq + 1, now);
      if (outcome.object) {
        syncSeq += 1;
        syncObjects.set(key, outcome.object);
        syncLog.push({
          seq: outcome.object.seq, object_type: outcome.object.type, object_id: outcome.object.id,
          version: outcome.object.version, deleted: outcome.object.deleted, payload: outcome.object.payload,
        });
      }
      results.push(outcome.result);
    }

    const receipt = ok(req.requestId, {
      batch_id: batchId, device_id: deviceId, status: batchStatus(results),
      items: results, server_cursor: syncSeq,
    });
    syncReceipts.set(receiptKey, receipt);
    return reply.code(200).send(receipt);
  });

  app.get('/api/v1/sync/pull', async (req) => {
    await requireAuth(req);
    const q = (req.query ?? {}) as { cursor?: string; limit?: string };
    const cursor = Number(q.cursor ?? 0);
    if (!Number.isFinite(cursor) || cursor < 0) throw new ApiError('VALIDATION_ERROR', 'cursor 非法');
    const page = pullChanges(syncLog, cursor, Number(q.limit ?? 100));
    return ok(req.requestId, {
      changes: page.items.map((c) => ({
        object_type: c.object_type, object_id: c.object_id,
        version: c.version, deleted: c.deleted, payload: c.payload,
      })),
      next_cursor: page.next_cursor,
      has_more: page.has_more,
    });
  });

  app.get('/api/v1/meta', async (req) => ok(req.requestId, {
    api_version: 'v1',
    base_url: config.publicBaseUrl,
    payment_provider: config.paymentProvider,
    note: '后端尚未部署到公网，此端点仅用于本地联调与客户端基址自检',
  }));

  return app;
}
