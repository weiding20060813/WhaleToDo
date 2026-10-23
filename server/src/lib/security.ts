// 安全基础：错误码、密码哈希、不透明令牌
// 说明：Node 24 可直接运行本文件（类型剥离），无需构建；依赖第三方包的部分留待后续接入。
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

/* ---------------- 统一错误码（与《接口与数据契约草案》一致） ---------------- */
export const ERROR_CODES = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
  INSUFFICIENT_POINTS: 402,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  UPSTREAM_UNAVAILABLE: 503,
  REQUEST_PENDING: 202,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = details;
  }

  toBody(requestId: string) {
    return {
      request_id: requestId,
      error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) },
    };
  }
}

/* ---------------- 密码哈希 ---------------- */
// 现状：scrypt（Node 内置，OWASP 可接受）；契约要求 Argon2id，待 npm 可用后替换 argon2 包。
// 参数：N=2^15, r=8, p=1, salt 16B, keylen 32B；编码格式带参数，便于日后升级重算。
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, saltLen: 16, maxmem: 64 * 1024 * 1024 } as const;

export function hashPassword(password: string): string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new ApiError('VALIDATION_ERROR', '密码长度需在 8~200 字符之间');
  }
  const salt = randomBytes(SCRYPT.saltLen);
  const key = scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(keyB64, 'base64url');
    const actual = scryptSync(String(password).normalize('NFKC'), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;   // 存储格式异常时按"验证失败"处理，绝不抛出细节
  }
}

/* ---------------- 不透明令牌 ---------------- */
// 契约：服务端只存令牌摘要（不存明文），刷新时旧令牌立即作废，重放触发整串撤销。
export const ACCESS_TTL_MS = 15 * 60 * 1000;          // 15 分钟
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessHash: string;
  refreshHash: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');   // 256 bit
}

export function hashToken(token: string): string {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export function issueTokens(now: number = Date.now()): IssuedTokens {
  const accessToken = generateToken();
  const refreshToken = generateToken();
  return {
    accessToken,
    refreshToken,
    accessHash: hashToken(accessToken),
    refreshHash: hashToken(refreshToken),
    accessExpiresAt: now + ACCESS_TTL_MS,
    refreshExpiresAt: now + REFRESH_TTL_MS,
  };
}

export function isExpired(expiresAt: number, now: number = Date.now()): boolean {
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

/** 校验访问令牌摘要：返回是否仍有效（真实实现还要查库确认未撤销） */
export function matchTokenDigest(rawToken: string, storedDigest: string): boolean {
  const a = Buffer.from(hashToken(rawToken), 'utf8');
  const b = Buffer.from(String(storedDigest), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
