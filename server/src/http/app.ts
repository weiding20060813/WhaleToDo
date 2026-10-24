// Fastify 应用：统一响应包、请求 ID、错误映射、幂等键与账户路由。
// 端点全部挂在 /api/v1 下（与 Nginx 约定的 api.whaletodo.top:8443/api/v1 一致）。
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from '../lib/security.ts';
import { FixedWindowLimiter } from '../lib/rateLimit.ts';
import { MemoryRepository } from '../repo/memory.ts';
import type { ServerConfig } from '../config.ts';

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
function fingerprintOf(body: unknown): string {
  return createHmac('sha256', IDEMPOTENCY_FINGERPRINT_KEY)
    .update(JSON.stringify(body ?? null))
    .digest('hex');
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, repo } = deps;

  // 限流：注册按 IP 计次（每次尝试都算）；登录只计失败次数，成功即清零。
  // 单进程内存实现，多实例部署时需换共享存储（见 handoff 说明）。
  const registerLimiter = new FixedWindowLimiter(config.rateLimitMaxAttempts, config.rateLimitWindowMs);
  const loginLimiter = new FixedWindowLimiter(config.rateLimitMaxAttempts, config.rateLimitWindowMs);
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
    const regKey = `ip:${req.ip}`;
    const regLimit = registerLimiter.hit(regKey);
    if (!regLimit.allowed) {
      throw new ApiError('RATE_LIMITED', '注册请求过于频繁，请稍后再试', { retry_after_ms: regLimit.retryAfterMs });
    }
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
    const user = await repo.createUser(username, password, body.display_name);
    const response = ok(req.requestId, {
      user: { id: user.id, username: user.username, display_name: user.displayName },
    });
    if (scopeKey) repo.saveIdempotent(scopeKey, fingerprintOf({ username, password, display_name: body.display_name ?? null }), response);
    return reply.code(201).send(response);
  });

  /* ---------- 登录 ---------- */
  app.post('/api/v1/auth/login', async (req) => {
    const loginKey = `ip:${req.ip}`;
    const body = (req.body ?? {}) as { username?: string; password?: string };
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    if (!username || !password) throw new ApiError('VALIDATION_ERROR', '用户名与密码不能为空');

    const user = await repo.authenticate(username, password);
    // 账号不存在与密码错误返回同一个错误，避免枚举账号
    if (!user) {
      const limit = loginLimiter.hit(loginKey);
      if (!limit.allowed) {
        throw new ApiError('RATE_LIMITED', '登录失败次数过多，请稍后再试', { retry_after_ms: limit.retryAfterMs });
      }
      throw new ApiError('UNAUTHENTICATED', '用户名或密码错误');
    }
    loginLimiter.reset(loginKey);

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

  app.get('/api/v1/meta', async (req) => ok(req.requestId, {
    api_version: 'v1',
    base_url: config.publicBaseUrl,
    payment_provider: config.paymentProvider,
    note: '后端尚未部署到公网，此端点仅用于本地联调与客户端基址自检',
  }));

  return app;
}
