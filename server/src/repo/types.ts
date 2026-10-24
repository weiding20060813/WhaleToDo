// 仓储接口：内存实现与 Prisma 实现都遵守同一份契约。
// 目的：把"换持久化"变成纯替换，路由层不改；契约测试（test/repository-contract.test.ts）
// 对任何实现跑同一套断言。
import type { Wallet } from '../domain/ledger.ts';

export interface RepoUser {
  id: string;
  username: string;
  displayName: string;
  createdAt: number;
}

export interface RepoSession {
  id: string;
  userId: string;
  accessHash: string;
  refreshHash: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  familyId: string;
  revokedAt: number | null;
  createdAt: number;
}

export interface IdempotencyHit {
  fingerprint: string;
  response: unknown;
}

export interface CreatedSession {
  session: RepoSession;
  tokens: {
    accessToken: string;
    refreshToken: string;
    accessHash: string;
    refreshHash: string;
    accessExpiresAt: number;
    refreshExpiresAt: number;
  };
}

/**
 * 账户相关的最小契约。
 * 事务边界（Prisma 实现必须遵守）：
 *  - `createUser`：插入 users + 初始化 point_wallets，单事务
 *  - `createSession` / `revokeSession` / `revokeFamily`：会话表写操作，单事务
 *  - 刷新轮换 = revokeSession(旧) + createSession(新, 同一 family) 必须在**同一事务**内，
 *    否则中途失败会出现"旧令牌已废、新令牌没发"的锁死状态
 */
export interface AccountRepository {
  findUserByUsername(username: string): Promise<RepoUser | null>;
  findUserById(id: string): Promise<RepoUser | null>;
  createUser(username: string, password: string, displayName?: string): Promise<RepoUser>;
  authenticate(username: string, password: string): Promise<RepoUser | null>;

  createSession(userId: string, familyId?: string): Promise<CreatedSession>;
  findActiveSessionByAccess(accessToken: string): Promise<RepoSession | null>;
  findSessionByRefresh(refreshToken: string): Promise<RepoSession | null>;
  revokeSession(id: string): Promise<void>;
  revokeFamily(familyId: string): Promise<number>;

  walletOf(userId: string): Promise<Wallet>;
  setWallet(userId: string, wallet: Wallet): Promise<void>;

  getIdempotent(key: string): Promise<IdempotencyHit | undefined>;
  saveIdempotent(key: string, fingerprint: string, response: unknown): Promise<void>;
}
