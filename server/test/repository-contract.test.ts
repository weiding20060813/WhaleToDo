// 仓储契约测试：任何实现（内存 / Prisma）都必须通过。
// 现在只跑内存实现；接 Prisma 后在这里加一组 `contract(makePrismaRepo)` 即可。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, MemoryRepository } from '../src/repo/memory.ts';
import { fromSync } from '../src/repo/from-sync.ts';
import type { AccountRepository } from '../src/repo/types.ts';
import { hashToken } from '../src/lib/security.ts';

const PASSWORD = 'S3cret-passw0rd';

/** 对任意实现跑同一套断言 */
async function runContract(makeRepo: () => AccountRepository, label: string) {
  describe(`仓储契约（${label}）`, () => {
    test('建号后可按用户名/ID 找到，且不暴露密码', async () => {
      const repo = makeRepo();
      const user = await repo.createUser('alice', PASSWORD, '爱丽丝');
      assert.equal(user.username, 'alice');
      assert.equal(user.displayName, '爱丽丝');
      assert.ok(!('passwordHash' in user), '对外的用户对象不应带密码哈希');

      assert.equal((await repo.findUserByUsername('alice'))?.id, user.id);
      assert.equal((await repo.findUserById(user.id))?.username, 'alice');
      assert.equal(await repo.findUserByUsername('nobody'), null);
    });

    test('用户名大小写不敏感，重复注册由上层判定（仓储允许取到同一条）', async () => {
      const repo = makeRepo();
      const user = await repo.createUser('Alice', PASSWORD);
      assert.equal((await repo.findUserByUsername('alice'))?.id, user.id);
    });

    test('认证：正确密码通过、错误密码失败、不存在账号失败', async () => {
      const repo = makeRepo();
      const user = await repo.createUser('bob', PASSWORD);
      assert.equal((await repo.authenticate('bob', PASSWORD))?.id, user.id);
      assert.equal(await repo.authenticate('bob', 'Wrong-passw0rd'), null);
      assert.equal(await repo.authenticate('ghost', PASSWORD), null);
    });

    test('会话：令牌只以摘要形式存储，可反查', async () => {
      const repo = makeRepo();
      const user = await repo.createUser('carol', PASSWORD);
      const { tokens } = await repo.createSession(user.id);

      const byAccess = await repo.findActiveSessionByAccess(tokens.accessToken);
      assert.equal(byAccess?.userId, user.id);
      const byRefresh = await repo.findSessionByRefresh(tokens.refreshToken);
      assert.equal(byRefresh?.id, byAccess?.id);

      // 库里存的是摘要而不是明文
      assert.equal(byAccess?.accessHash, hashToken(tokens.accessToken));
      assert.notEqual(byAccess?.accessHash, tokens.accessToken);
    });

    test('撤销：单会话撤销后查不到；同 family 全部撤销', async () => {
      const repo = makeRepo();
      const user = await repo.createUser('dave', PASSWORD);
      const first = await repo.createSession(user.id);
      const second = await repo.createSession(user.id, first.session.familyId);

      await repo.revokeSession(first.session.id);
      assert.equal(await repo.findActiveSessionByAccess(first.tokens.accessToken), null);
      // 同 family 的另一条仍有效（撤销是单条的）
      assert.ok(await repo.findActiveSessionByAccess(second.tokens.accessToken));

      const revoked = await repo.revokeFamily(first.session.familyId);
      assert.ok(revoked >= 1);
      assert.equal(await repo.findActiveSessionByAccess(second.tokens.accessToken), null);
    });

    test('钱包：默认 0，可写入并读回', async () => {
      const repo = makeRepo();
      const user = await repo.createUser('erin', PASSWORD);
      assert.deepEqual(await repo.walletOf(user.id), { available: 0, reserved: 0 });
      await repo.setWallet(user.id, { available: 30, reserved: 5 });
      assert.deepEqual(await repo.walletOf(user.id), { available: 30, reserved: 5 });
    });

    test('幂等回执：未命中返回 undefined，写入后可命中且不保留明文', async () => {
      const repo = makeRepo();
      assert.equal(await repo.getIdempotent('k1'), undefined);
      // 指纹由调用方计算（HMAC），仓储本身不应接收明文请求体
      const fingerprint = 'a'.repeat(64);
      await repo.saveIdempotent('k1', fingerprint, { ok: true });
      const hit = await repo.getIdempotent('k1');
      assert.equal(hit?.fingerprint, fingerprint);
      assert.deepEqual(hit?.response, { ok: true });
    });
  });
}

await runContract(() => fromSync(new MemoryRepository(createMemoryStore(), () => Date.now())), '内存实现');
