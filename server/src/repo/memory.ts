// 内存仓储：用于本地开发与集成测试（无数据库依赖）。
// Prisma 仓储在下一阶段接入，接口保持一致，便于替换。
import { randomUUID } from 'node:crypto';
import { hashPasswordAsync, verifyPasswordAsync, issueTokens, hashToken } from '../lib/security.ts';
import type { Wallet } from '../domain/ledger.ts';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  displayName: string;
  createdAt: number;
}

export interface Session {
  id: string;
  userId: string;
  accessHash: string;
  refreshHash: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  /** 同一登录链（refresh 轮换后共享），用于重放时整串撤销 */
  familyId: string;
  revokedAt: number | null;
  createdAt: number;
}

export interface MemoryStore {
  users: Map<string, User>;
  usernameIndex: Map<string, string>;
  sessions: Map<string, Session>;
  wallets: Map<string, Wallet>;
  /** 幂等键 -> { 请求指纹, 响应体 } */
  idempotency: Map<string, { fingerprint: string; response: unknown }>;
}

export function createMemoryStore(): MemoryStore {
  return {
    users: new Map(),
    usernameIndex: new Map(),
    sessions: new Map(),
    wallets: new Map(),
    idempotency: new Map(),
  };
}

export class MemoryRepository {
  readonly store: MemoryStore;
  private readonly now: () => number;

  // 注意：Node 的类型剥离不支持构造函数参数属性（constructor(readonly x)），故显式赋值
  constructor(store: MemoryStore = createMemoryStore(), now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  findUserByUsername(username: string): User | null {
    const id = this.store.usernameIndex.get(username.toLowerCase());
    return id ? this.store.users.get(id) ?? null : null;
  }

  findUserById(id: string): User | null {
    return this.store.users.get(id) ?? null;
  }

  async createUser(username: string, password: string, displayName?: string): Promise<User> {
    const user: User = {
      id: randomUUID(),
      username,
      passwordHash: await hashPasswordAsync(password),
      displayName: (displayName ?? username).slice(0, 32),
      createdAt: this.now(),
    };
    this.store.users.set(user.id, user);
    this.store.usernameIndex.set(username.toLowerCase(), user.id);
    this.store.wallets.set(user.id, { available: 0, reserved: 0 });
    return user;
  }

  async authenticate(username: string, password: string): Promise<User | null> {
    const user = this.findUserByUsername(username);
    if (!user) {
      // 即使账号不存在也跑一次哈希，避免用响应时间探测用户是否存在
      await hashPasswordAsync('dummy-password-for-timing');
      return null;
    }
    return (await verifyPasswordAsync(password, user.passwordHash)) ? user : null;
  }

  createSession(userId: string, familyId?: string): { session: Session; tokens: ReturnType<typeof issueTokens> } {
    const tokens = issueTokens(this.now());
    const session: Session = {
      id: randomUUID(),
      userId,
      accessHash: tokens.accessHash,
      refreshHash: tokens.refreshHash,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      familyId: familyId ?? randomUUID(),
      revokedAt: null,
      createdAt: this.now(),
    };
    this.store.sessions.set(session.id, session);
    return { session, tokens };
  }

  /** 按访问令牌摘要找会话（未撤销且未过期） */
  findActiveSessionByAccess(accessToken: string): Session | null {
    const digest = hashToken(accessToken);
    for (const s of this.store.sessions.values()) {
      if (s.accessHash === digest && s.revokedAt === null && s.accessExpiresAt > this.now()) return s;
    }
    return null;
  }

  findSessionByRefresh(refreshToken: string): Session | null {
    const digest = hashToken(refreshToken);
    for (const s of this.store.sessions.values()) {
      if (s.refreshHash === digest) return s;
    }
    return null;
  }

  revokeSession(id: string): void {
    const s = this.store.sessions.get(id);
    if (s) s.revokedAt = this.now();
  }

  revokeFamily(familyId: string): number {
    let n = 0;
    for (const s of this.store.sessions.values()) {
      if (s.familyId === familyId && s.revokedAt === null) { s.revokedAt = this.now(); n++; }
    }
    return n;
  }

  walletOf(userId: string): Wallet {
    return this.store.wallets.get(userId) ?? { available: 0, reserved: 0 };
  }

  setWallet(userId: string, wallet: Wallet): void {
    this.store.wallets.set(userId, wallet);
  }

  getIdempotent(key: string): { fingerprint: string; response: unknown } | undefined {
    return this.store.idempotency.get(key);
  }

  saveIdempotent(key: string, fingerprint: string, response: unknown): void {
    this.store.idempotency.set(key, { fingerprint, response });
  }

  get userCount(): number { return this.store.users.size; }
  get sessionCount(): number { return this.store.sessions.size; }
}
