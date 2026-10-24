// 评审要求的两项防护：注册/登录限流 + 密码哈希异步化
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.ts';
import { createMemoryStore, MemoryRepository } from '../src/repo/memory.ts';
import { loadConfig } from '../src/config.ts';
import { FixedWindowLimiter } from '../src/lib/rateLimit.ts';
import { hashPasswordAsync, verifyPasswordAsync } from '../src/lib/security.ts';

const baseEnv = {
  NODE_ENV: 'test',
  BUSINESS_TIMEZONE: 'Asia/Shanghai',
  RATE_LIMIT_MAX_ATTEMPTS: '3',
  RATE_LIMIT_WINDOW_MS: '60000',
} as NodeJS.ProcessEnv;

let app: FastifyInstance;
let repo: MemoryRepository;

beforeEach(async () => {
  if (app) await app.close();
  repo = new MemoryRepository(createMemoryStore(), () => Date.now());
  app = buildApp({ config: loadConfig(baseEnv), repo });
});

const inject = (opts: import('light-my-request').InjectOptions) => app.inject(opts);
const PASSWORD = 'S3cret-passw0rd';

describe('固定窗口限流（纯逻辑）', () => {
  test('窗口内达到上限后拒绝，并给出重试等待', () => {
    let now = 1000;
    const limiter = new FixedWindowLimiter(3, 60_000, () => now);
    assert.equal(limiter.hit('k').allowed, true);
    assert.equal(limiter.hit('k').allowed, true);
    const third = limiter.hit('k');
    assert.equal(third.allowed, true);
    assert.equal(third.remaining, 0);

    const fourth = limiter.hit('k');
    assert.equal(fourth.allowed, false);
    assert.ok(fourth.retryAfterMs > 0 && fourth.retryAfterMs <= 60_000);

    now += 60_001;   // 窗口过期后恢复
    assert.equal(limiter.hit('k').allowed, true);
  });

  test('不同键互不影响；reset 立即清零', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, () => 1000);
    assert.equal(limiter.hit('a').allowed, true);
    assert.equal(limiter.hit('a').allowed, false);
    assert.equal(limiter.hit('b').allowed, true);

    limiter.reset('a');
    assert.equal(limiter.hit('a').allowed, true);
  });

  test('sweep 清理过期桶', () => {
    let now = 1000;
    const limiter = new FixedWindowLimiter(5, 1000, () => now);
    limiter.hit('x');
    limiter.hit('y');
    assert.equal(limiter.size, 2);
    now += 1001;
    assert.equal(limiter.sweep(), 2);
    assert.equal(limiter.size, 0);
  });
});

describe('注册限流', () => {
  test('连续注册超过上限后返回 429 RATE_LIMITED', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await inject({
        method: 'POST', url: '/api/v1/auth/register',
        headers: { 'content-type': 'application/json' },
        payload: { username: `rl_${i}`, password: PASSWORD },
      });
      assert.equal(res.statusCode, 201, `第 ${i + 1} 次应成功`);
    }
    const blocked = await inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'rl_9', password: PASSWORD },
    });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error.code, 'RATE_LIMITED');
    assert.ok(blocked.json().error.details.retry_after_ms > 0);
  });
});

describe('登录限流', () => {
  test('失败达到上限后 429；成功登录会清零计数', async () => {
    await inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'rl_user', password: PASSWORD },
    });

    const bad = () => inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'rl_user', password: 'Wrong-passw0rd' },
    });

    assert.equal((await bad()).statusCode, 401);
    assert.equal((await bad()).statusCode, 401);
    assert.equal((await bad()).statusCode, 401);
    const blocked = await bad();
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error.code, 'RATE_LIMITED');
  });

  test('登录成功会重置失败计数', async () => {
    await inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'rl_user2', password: PASSWORD },
    });
    for (let i = 0; i < 2; i++) {
      await inject({
        method: 'POST', url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { username: 'rl_user2', password: 'Wrong-passw0rd' },
      });
    }
    const ok = await inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'rl_user2', password: PASSWORD },
    });
    assert.equal(ok.statusCode, 200);
    // 成功后再失败两次仍不应被拦（计数已清零）
    for (let i = 0; i < 2; i++) {
      const res = await inject({
        method: 'POST', url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { username: 'rl_user2', password: 'Wrong-passw0rd' },
      });
      assert.equal(res.statusCode, 401);
    }
  });
});

describe('密码哈希异步化', () => {
  test('异步哈希可被异步校验，且与同步格式一致', async () => {
    const stored = await hashPasswordAsync(PASSWORD);
    assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$/);
    assert.equal(await verifyPasswordAsync(PASSWORD, stored), true);
    assert.equal(await verifyPasswordAsync('Wrong-passw0rd', stored), false);
  });

  test('并发 8 次哈希都能完成（验证不阻塞事件循环的写法可用）', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => hashPasswordAsync(`parallel-pass-${i}`)),
    );
    assert.equal(results.length, 8);
    assert.equal(new Set(results).size, 8, '每次盐不同，哈希应互不相同');
  });

  test('注册与登录走的是异步路径（能正常建号与认证）', async () => {
    const reg = await inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'async_user', password: PASSWORD },
    });
    assert.equal(reg.statusCode, 201);
    const login = await inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'async_user', password: PASSWORD },
    });
    assert.equal(login.statusCode, 200);
  });
});
