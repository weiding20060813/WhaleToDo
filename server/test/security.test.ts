import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError, ERROR_CODES, hashPassword, verifyPassword,
  issueTokens, hashToken, matchTokenDigest, isExpired, generateToken,
  ACCESS_TTL_MS, REFRESH_TTL_MS,
} from '../src/lib/security.ts';

describe('错误码', () => {
  test('ApiError 带出契约里的 HTTP 状态', () => {
    assert.equal(new ApiError('UNAUTHENTICATED', 'x').status, 401);
    assert.equal(new ApiError('INSUFFICIENT_POINTS', 'x').status, 402);
    assert.equal(new ApiError('CONFLICT', 'x').status, 409);
    assert.equal(new ApiError('INTERNAL', 'x').status, 500);
    assert.equal(Object.keys(ERROR_CODES).length, 9);
  });

  test('toBody 包成 {request_id, error}', () => {
    const body = new ApiError('VALIDATION_ERROR', '字段缺失', { field: 'username' }).toBody('req-1');
    assert.equal(body.request_id, 'req-1');
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(body.error.details, { field: 'username' });
  });
});

describe('密码哈希', () => {
  test('同一密码两次哈希不同（盐随机）', () => {
    const a = hashPassword('correct horse battery');
    const b = hashPassword('correct horse battery');
    assert.notEqual(a, b);
    assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$/);
  });

  test('正确密码验证通过、错误密码失败', () => {
    const stored = hashPassword('S3cret-passw0rd');
    assert.equal(verifyPassword('S3cret-passw0rd', stored), true);
    assert.equal(verifyPassword('S3cret-passw0rD', stored), false);
    assert.equal(verifyPassword('', stored), false);
  });

  test('存储格式异常时返回 false 而不是抛错', () => {
    assert.equal(verifyPassword('x', 'not-a-hash'), false);
    assert.equal(verifyPassword('x', ''), false);
    assert.equal(verifyPassword('x', 'scrypt$1$2$3$bad$bad'), false);
  });

  test('过短或过长密码被拒（VALIDATION_ERROR）', () => {
    assert.throws(() => hashPassword('short'), (e: unknown) => e instanceof ApiError && e.code === 'VALIDATION_ERROR');
    assert.throws(() => hashPassword('x'.repeat(201)), (e: unknown) => e instanceof ApiError && e.code === 'VALIDATION_ERROR');
  });

  test('Unicode 密码按 NFKC 归一化后仍可验证', () => {
    const stored = hashPassword('密码テスト🎉🎉🎉');
    assert.equal(verifyPassword('密码テスト🎉🎉🎉', stored), true);
  });
});

describe('令牌', () => {
  test('access / refresh 不同且熵足够', () => {
    const t = issueTokens(1000);
    assert.notEqual(t.accessToken, t.refreshToken);
    assert.ok(t.accessToken.length >= 43, '32 字节 base64url 至少 43 字符');
    assert.notEqual(generateToken(), generateToken());
  });

  test('只存摘要，摘要可复算', () => {
    const t = issueTokens(1000);
    assert.equal(t.accessHash, hashToken(t.accessToken));
    assert.equal(t.refreshHash, hashToken(t.refreshToken));
    assert.notEqual(t.accessHash, t.accessToken);        // 存库的是摘要，不是明文
    assert.equal(t.accessHash.length, 64);               // sha256 hex
  });

  test('有效期偏移符合约定（access 15min / refresh 30d）', () => {
    const now = 1_700_000_000_000;
    const t = issueTokens(now);
    assert.equal(t.accessExpiresAt, now + ACCESS_TTL_MS);
    assert.equal(t.refreshExpiresAt, now + REFRESH_TTL_MS);
    assert.ok(t.refreshExpiresAt > t.accessExpiresAt);
  });

  test('isExpired 边界：等于当前时刻即算过期', () => {
    assert.equal(isExpired(1000, 1000), true);
    assert.equal(isExpired(1001, 1000), false);
    assert.equal(isExpired(Number.NaN, 1000), true);
  });

  test('matchTokenDigest 只对原始令牌成立', () => {
    const t = issueTokens(1000);
    assert.equal(matchTokenDigest(t.accessToken, t.accessHash), true);
    assert.equal(matchTokenDigest(t.refreshToken, t.accessHash), false);
    assert.equal(matchTokenDigest(t.accessToken, ''), false);
  });
});
