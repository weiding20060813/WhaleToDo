// 把同步的内存仓储适配成异步接口，供契约测试使用。
// 说明：内存实现内部保持同步（简单、无 IO）；Prisma 实现将直接实现 AccountRepository。
// 两者跑同一套契约测试，换持久化时路由层不改。
import type { AccountRepository, RepoUser, RepoSession } from './types.ts';
import type { MemoryRepository } from './memory.ts';

function toRepoUser(u: { id: string; username: string; displayName: string; createdAt: number }): RepoUser {
  return { id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt };
}

function toRepoSession(s: RepoSession): RepoSession {
  return s;   // 内存仓储的会话对象已满足接口（不含明文令牌）
}

export function fromSync(repo: MemoryRepository): AccountRepository {
  return {
    findUserByUsername: async (username) => {
      const u = repo.findUserByUsername(username);
      return u ? toRepoUser(u) : null;
    },
    findUserById: async (id) => {
      const u = repo.findUserById(id);
      return u ? toRepoUser(u) : null;
    },
    createUser: async (username, password, displayName) => toRepoUser(await repo.createUser(username, password, displayName)),
    authenticate: async (username, password) => {
      const u = await repo.authenticate(username, password);
      return u ? toRepoUser(u) : null;
    },
    createSession: async (userId, familyId) => {
      const { session, tokens } = repo.createSession(userId, familyId);
      return { session: toRepoSession(session), tokens };
    },
    findActiveSessionByAccess: async (token) => {
      const s = repo.findActiveSessionByAccess(token);
      return s ? toRepoSession(s) : null;
    },
    findSessionByRefresh: async (token) => {
      const s = repo.findSessionByRefresh(token);
      return s ? toRepoSession(s) : null;
    },
    revokeSession: async (id) => { repo.revokeSession(id); },
    revokeFamily: async (familyId) => repo.revokeFamily(familyId),
    walletOf: async (userId) => repo.walletOf(userId),
    setWallet: async (userId, wallet) => { repo.setWallet(userId, wallet); },
    getIdempotent: async (key) => repo.getIdempotent(key),
    saveIdempotent: async (key, fingerprint, response) => { repo.saveIdempotent(key, fingerprint, response); },
  };
}
