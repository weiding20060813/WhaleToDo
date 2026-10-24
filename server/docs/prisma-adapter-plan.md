# Prisma 适配计划（Weiding）

日期：2026-10-24　状态：**骨架已就位，等待 schema 合并与 PostgreSQL 就绪**
相关：`src/repo/types.ts`（接口）、`src/repo/from-sync.ts`（内存适配）、
`test/repository-contract.test.ts`（契约测试）、`prisma/schema.prisma`（建议稿）

## 1. 为什么先做接口和契约测试

换持久化最容易出问题的不是 SQL 写错，而是**语义漂移**：内存版能过、数据库版卡在唯一约束或事务边界。
所以先把"仓储必须满足什么"固化成可执行断言：

```
任何实现 → runContract(makeRepo) → 同一套 7 项断言
```

现在跑的是内存实现（经 `fromSync` 适配）。Prisma 实现落地后，在
`test/repository-contract.test.ts` 末尾加一行 `await runContract(makePrismaRepo, 'Prisma')` 即可。

## 2. 表与方法的映射

| 接口方法 | 涉及表 / 操作 | 事务要求 |
| --- | --- | --- |
| `createUser` | `INSERT users` + `INSERT point_wallets(0,0)` | **单事务**，否则会出现"有用户没钱包" |
| `findUserByUsername` / `findUserById` | `SELECT users` | 单语句；只返回 `id/username/displayName/createdAt` |
| `authenticate` | `SELECT users` + 异步 scrypt 校验 | **不包事务**（哈希耗时不应占着连接） |
| `createSession` | `INSERT auth_sessions` | 单语句 |
| `findActiveSessionByAccess` | `SELECT ... WHERE access_hash=$1 AND revoked_at IS NULL AND access_expires_at > now()` | 需要 `access_hash` 索引（已有） |
| `findSessionByRefresh` | `SELECT ... WHERE refresh_hash=$1` | 需要 `refresh_hash` 索引（已有） |
| `revokeSession` | `UPDATE auth_sessions SET revoked_at=now() WHERE id=$1` | 单语句 |
| `revokeFamily` | `UPDATE ... WHERE family_id=$1 AND revoked_at IS NULL` | 单语句，返回影响行数 |
| `walletOf` / `setWallet` | `SELECT/UPDATE point_wallets` | 写入需带 `CHECK (available>=0 AND reserved>=0)` 兜底 |
| `getIdempotent` / `saveIdempotent` | `SELECT/INSERT idempotency_receipts` | 插入冲突（`23505`）应视为**并发重放**：改为读回已有回执，不报错 |

### 刷新轮换的事务边界（关键）

```text
BEGIN;
  UPDATE auth_sessions SET revoked_at = now() WHERE id = $old AND revoked_at IS NULL;
  -- 受影响行数必须为 1，否则说明被并发消费 → ROLLBACK，按"重放"处理
  INSERT INTO auth_sessions (...) VALUES (...);   -- 新会话，沿用同一 family_id
COMMIT;
```

不复用事务会出现"旧令牌已废、新令牌没发"的锁死状态，用户只能重新登录。

## 3. 从内存切到 Prisma 需要改的地方

| 位置 | 改动 |
| --- | --- |
| `src/main.ts` | `new MemoryRepository()` → `new PrismaRepository(prisma)` |
| `src/http/app.ts` | 调用处补 `await`（内存实现是同步的，接口是异步的） |
| `package.json` | 加 `@prisma/client` / `prisma` 依赖与 `prisma:generate`、`prisma:migrate` 脚本 |
| `.env` | `DATABASE_URL`（运行账号只有 DML） |

路由层的**契约不变**：响应字段、错误码、幂等行为都不动，客户端无需改。

## 4. 阻塞项

| 项 | 状态 |
| --- | --- |
| `prisma/schema.prisma` 评审 | 等 Bottledkzk（PR #3） |
| PostgreSQL 16 实例 | 由 Bottledkzk 安装，仅回环 `127.0.0.1:5432`，运行账号 DML / 迁移账号 DDL |
| `@prisma/client` 依赖 | 需要能访问 npm registry + Prisma 引擎下载（本机当前网络不稳） |
| 集成测试 | 依赖上面三项；契约测试可先跑内存版 |

## 5. 接入后的验证清单

1. `prisma migrate deploy`（迁移由 Bottledkzk 执行）后跑契约测试
2. 重复注册 → `23505` 唯一冲突 → 路由层映射为 `CONFLICT`
3. 并发刷新同一 refresh → 一个成功、一个按重放撤销整串
4. 并发签到 → `daily_claims` 唯一键挡住第二次，返回 409
5. 余额扣减到负数 → `CHECK` 约束报错 → 映射为 `INSUFFICIENT_POINTS`
