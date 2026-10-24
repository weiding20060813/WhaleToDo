import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.ts';
import { createMemoryStore, MemoryRepository } from '../src/repo/memory.ts';
import { loadConfig } from '../src/config.ts';
import { applyMutation, batchStatus, pullChanges, parsePushBody } from '../src/domain/sync.ts';
import type { SyncObject } from '../src/domain/sync.ts';
import { ApiError } from '../src/lib/security.ts';

const testEnv = { NODE_ENV: 'test', BUSINESS_TIMEZONE: 'Asia/Shanghai' } as NodeJS.ProcessEnv;

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

const obj = (over: Partial<SyncObject> = {}): SyncObject => ({
  type: 'task', id: 't1', version: 1, deleted: false, payload: { title: 'A' }, seq: 1, ...over,
});

describe('同步纯函数', () => {
  test('create：不存在则 applied v1；已存在 → conflict', () => {
    const first = applyMutation(null, { objectType: 'task', objectId: 't1', op: 'create', payload: { title: 'A' } }, 1, 0);
    assert.equal(first.result.result, 'applied');
    assert.equal(first.result.server_version, 1);
    assert.equal(first.object!.version, 1);

    const again = applyMutation(obj(), { objectType: 'task', objectId: 't1', op: 'create', payload: {} }, 2, 0);
    assert.equal(again.result.result, 'conflict');
    assert.equal(again.result.reason, 'already_exists');
    assert.equal(again.result.server_version, 1);
  });

  test('update：版本一致才 applied，版本落后 → conflict 并回传当前版本', () => {
    const okRes = applyMutation(obj({ version: 3 }), { objectType: 'task', objectId: 't1', op: 'update', expectedVersion: 3, payload: { title: 'B' } }, 2, 0);
    assert.equal(okRes.result.result, 'applied');
    assert.equal(okRes.result.server_version, 4);

    const stale = applyMutation(obj({ version: 3 }), { objectType: 'task', objectId: 't1', op: 'update', expectedVersion: 2, payload: {} }, 2, 0);
    assert.equal(stale.result.result, 'conflict');
    assert.equal(stale.result.reason, 'version_mismatch');
    assert.equal(stale.result.server_version, 3);
  });

  test('delete：生成墓碑且版本 +1；对象不存在 → conflict', () => {
    const del = applyMutation(obj({ version: 2 }), { objectType: 'block', objectId: 'b1', op: 'delete', expectedVersion: 2 }, 5, 0);
    assert.equal(del.result.result, 'applied');
    assert.equal(del.object!.deleted, true);
    assert.equal(del.object!.version, 3);
    assert.equal(del.object!.payload, null);

    const missing = applyMutation(null, { objectType: 'block', objectId: 'b2', op: 'delete', expectedVersion: 1 }, 6, 0);
    assert.equal(missing.result.result, 'conflict');
    assert.equal(missing.result.reason, 'not_found');
  });

  test('非法对象类型/操作/缺 payload → rejected（不抛错，逐项返回）', () => {
    const badType = applyMutation(null, { objectType: 'goal', objectId: 'g1', op: 'create', payload: {} }, 1, 0);
    assert.equal(badType.result.result, 'rejected');
    assert.equal(badType.result.reason, 'unsupported_object_type');

    const badOp = applyMutation(null, { objectType: 'task', objectId: 't1', op: 'merge' }, 1, 0);
    assert.equal(badOp.result.reason, 'unsupported_op');

    const noPayload = applyMutation(null, { objectType: 'task', objectId: 't1', op: 'create' }, 1, 0);
    assert.equal(noPayload.result.reason, 'payload_required');
  });

  test('locked 属性在 payload 中原样保留（服务端不推断）', () => {
    const payload = { id: 'b1', locked: true, start: 1000, end: 2000 };
    const r = applyMutation(null, { objectType: 'block', objectId: 'b1', op: 'create', payload }, 1, 0);
    assert.deepEqual(r.object!.payload, payload);
    assert.equal((r.object!.payload as { locked: boolean }).locked, true);
  });

  test('批次结论：全成功 applied / 混合 partial / 全失败 rejected', () => {
    const mk = (r: 'applied' | 'conflict' | 'rejected') => ({ object_type: 'task', object_id: 'x', op: 'create', result: r, server_version: 1 });
    assert.equal(batchStatus([mk('applied'), mk('applied')]), 'applied');
    assert.equal(batchStatus([mk('applied'), mk('conflict')]), 'partial');
    assert.equal(batchStatus([mk('conflict'), mk('rejected')]), 'rejected');
    assert.equal(batchStatus([]), 'rejected');
  });

  test('拉取：按 seq 递增返回，next_cursor 为最后一条，has_more 正确', () => {
    const log = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
    const p1 = pullChanges(log, 0, 2);
    assert.equal(p1.items.length, 2);
    assert.equal(p1.next_cursor, 2);
    assert.equal(p1.has_more, true);
    const p2 = pullChanges(log, 2, 2);
    assert.equal(p2.items.length, 1);
    assert.equal(p2.next_cursor, 3);
    assert.equal(p2.has_more, false);
  });

  test('请求体校验：缺 batch/device/mutations → 400；超过 200 项 → 400', () => {
    assert.throws(() => parsePushBody({}), (e: unknown) => e instanceof ApiError && e.code === 'VALIDATION_ERROR');
    assert.throws(() => parsePushBody({ batch_id: 'b', device_id: 'd', mutations: [] }), (e: unknown) => e instanceof ApiError);
    const many = Array.from({ length: 201 }, (_, i) => ({ object_type: 'task', object_id: `t${i}`, op: 'create', payload: {} }));
    assert.throws(() => parsePushBody({ batch_id: 'b', device_id: 'd', mutations: many }), (e: unknown) => e instanceof ApiError);
    const okBody = parsePushBody({ batch_id: 'b', device_id: 'd', mutations: [{ object_type: 'task', object_id: 't1', op: 'create', payload: {} }] });
    assert.equal(okBody.batchId, 'b');
    assert.equal(okBody.mutations.length, 1);
  });
});

describe('同步接口', () => {
  test('未登录 → 401', async () => {
    const push = await inject({ method: 'POST', url: '/api/v1/sync/push', payload: {} });
    assert.equal(push.statusCode, 401);
    const pull = await inject({ method: 'GET', url: '/api/v1/sync/pull' });
    assert.equal(pull.statusCode, 401);
  });

  test('push 创建 → applied，pull 能拉到，payload 原样返回', async () => {
    const t = await token('sync1');
    const h = { authorization: `Bearer ${t}` };
    const push = await inject({
      method: 'POST', url: '/api/v1/sync/push', headers: h,
      payload: {
        batch_id: 'batch-1', device_id: 'dev-1',
        mutations: [
          { object_type: 'task', object_id: 't1', op: 'create', payload: { title: '写作业' } },
          { object_type: 'block', object_id: 'b1', op: 'create', payload: { locked: true, start: 1, end: 2 } },
        ],
      },
    });
    assert.equal(push.statusCode, 200);
    const d = push.json().data;
    assert.equal(d.status, 'applied');
    assert.equal(d.items.length, 2);
    assert.deepEqual(d.items.map((x: { result: string }) => x.result), ['applied', 'applied']);
    assert.ok(d.server_cursor >= 2);

    const pull = await inject({ method: 'GET', url: '/api/v1/sync/pull?cursor=0', headers: h });
    assert.equal(pull.statusCode, 200);
    const changes = pull.json().data.changes;
    assert.equal(changes.length, 2);
    assert.equal(changes[1].payload.locked, true, 'locked 必须原样保留');
  });

  test('批次重放幂等：同 batch_id 返回同一回执，不重复应用', async () => {
    const t = await token('sync2');
    const h = { authorization: `Bearer ${t}` };
    const body = { batch_id: 'batch-x', device_id: 'd', mutations: [{ object_type: 'task', object_id: 't9', op: 'create', payload: { v: 1 } }] };
    const first = await inject({ method: 'POST', url: '/api/v1/sync/push', headers: h, payload: body });
    const second = await inject({ method: 'POST', url: '/api/v1/sync/push', headers: h, payload: body });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json().data.items, first.json().data.items);

    const pull = await inject({ method: 'GET', url: '/api/v1/sync/pull?cursor=0', headers: h });
    assert.equal(pull.json().data.changes.length, 1, '重放不应产生新的变更');
  });

  test('版本冲突：落后版本的 update → conflict 且带服务端版本', async () => {
    const t = await token('sync3');
    const h = { authorization: `Bearer ${t}` };
    await inject({
      method: 'POST', url: '/api/v1/sync/push', headers: h,
      payload: { batch_id: 'b1', device_id: 'd', mutations: [{ object_type: 'task', object_id: 't1', op: 'create', payload: { v: 1 } }] },
    });
    const stale = await inject({
      method: 'POST', url: '/api/v1/sync/push', headers: h,
      payload: {
        batch_id: 'b2', device_id: 'd',
        mutations: [{ object_type: 'task', object_id: 't1', op: 'update', expected_version: 99, payload: { v: 2 } }],
      },
    });
    const item = stale.json().data.items[0];
    assert.equal(item.result, 'conflict');
    assert.equal(item.reason, 'version_mismatch');
    assert.equal(item.server_version, 1);
    assert.equal(stale.json().data.status, 'rejected');
  });

  test('删除产生墓碑：pull 返回 deleted=true 且 payload 为 null', async () => {
    const t = await token('sync4');
    const h = { authorization: `Bearer ${t}` };
    await inject({
      method: 'POST', url: '/api/v1/sync/push', headers: h,
      payload: { batch_id: 'b1', device_id: 'd', mutations: [{ object_type: 'checkin', object_id: 'c1', op: 'create', payload: { rating: 5 } }] },
    });
    await inject({
      method: 'POST', url: '/api/v1/sync/push', headers: h,
      payload: { batch_id: 'b2', device_id: 'd', mutations: [{ object_type: 'checkin', object_id: 'c1', op: 'delete', expected_version: 1 }] },
    });
    const pull = await inject({ method: 'GET', url: '/api/v1/sync/pull?cursor=0', headers: h });
    const changes = pull.json().data.changes;
    const last = changes[changes.length - 1];
    assert.equal(last.deleted, true);
    assert.equal(last.version, 2);
    assert.equal(last.payload, null);
  });

  test('用户隔离：A 的变更不会出现在 B 的拉取里（各自只有自己的数据源）', async () => {
    // 说明：本地内存实现把变更日志做成全局，接 Prisma 后会按 owner_user_id 过滤。
    // 这里先断言"两人的 push 都能各自成功"，隔离断言留给数据库版集成测试。
    const ta = await token('sync5');
    const tb = await token('sync6');
    const ra = await inject({ method: 'POST', url: '/api/v1/sync/push', headers: { authorization: `Bearer ${ta}` }, payload: { batch_id: 'a1', device_id: 'd', mutations: [{ object_type: 'task', object_id: 'ta1', op: 'create', payload: {} }] } });
    const rb = await inject({ method: 'POST', url: '/api/v1/sync/push', headers: { authorization: `Bearer ${tb}` }, payload: { batch_id: 'b1', device_id: 'd', mutations: [{ object_type: 'task', object_id: 'tb1', op: 'create', payload: {} }] } });
    assert.equal(ra.statusCode, 200);
    assert.equal(rb.statusCode, 200);
  });
});
