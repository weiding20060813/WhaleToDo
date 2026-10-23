# WhaleToDo Server（Weiding 主责）

后端骨架：账户、签到积分、订单/支付、同步。技术栈按评审结论：**TypeScript + Fastify + Prisma + PostgreSQL**
（数据库 schema 与迁移由 Bottledkzk 统一维护，本目录只提交**迁移建议**与业务实现）。

## 当前状态（2026-10-23）

| 部分 | 状态 |
| --- | --- |
| 统一错误码（9 个） | ✅ 已实现 + 测试 |
| 密码哈希（scrypt，Argon2id 待替换） | ✅ 已实现 + 测试 |
| 不透明令牌（只存 SHA-256 摘要、15min/30d） | ✅ 已实现 + 测试 |
| 积分账本（award/reserve/settle/release/adjust + 幂等） | ✅ 已实现 + 测试（26 项） |
| Fastify 路由（`/auth/*`、`/me`） | ⏳ 下一步 |
| Prisma schema 与迁移建议 | ⏳ 下一步（等 schema 归属确认后提交建议） |
| PostgreSQL 集成测试 | ⏳ 本机无 Postgres/Docker，需先装或连服务器 |

## 为什么现在就能跑测试

Node 24 原生支持**直接运行 TypeScript**（类型剥离），且 `node --test` 支持 `.ts`。
所以纯逻辑层不依赖任何 npm 包：

```bash
cd server
node --test test/*.test.ts      # 26 项，全过
```

需要第三方依赖（fastify / prisma / argon2）的部分，要等网络可用后：

```bash
npm install        # 本机当前到 registry 只有 8~21 KB/s，建议换网或挂代理
npm run typecheck
```

## 设计要点（与《接口与数据契约草案》和评审结论对齐）

1. **错误码**：`UNAUTHENTICATED / FORBIDDEN / VALIDATION_ERROR / INSUFFICIENT_POINTS / RATE_LIMITED /
   CONFLICT / UPSTREAM_UNAVAILABLE / REQUEST_PENDING / INTERNAL`，响应体 `{request_id, error:{code,message,details?}}`。
2. **密码**：当前用 `scrypt(N=2^15,r=8,p=1)` + 16B 随机盐，编码里带参数便于升级；
   契约要求 Argon2id，等 `argon2` 包可用后替换 `hashPassword/verifyPassword` 实现，接口不变。
3. **令牌**：256bit 随机不透明串，**库里只存 SHA-256 摘要**；access 15 分钟、refresh 30 天；
   刷新时旧 refresh 立即作废、重放触发整串撤销（由会话表实现，下一步接 Prisma）。
4. **账本**：`event_id` 才是幂等键（唯一），`request_id` 只做关联（普通索引）；
   AI 流程 = 鉴权+限额 → **事务预占** → 模型调用 → 成功结算 / 明确失败释放；结果未知保留状态可查询。
   `available` 与 `reserved` 分开且均不得为负；批量记账失败整体抛出，调用方须包在数据库事务里。
5. **时区**：签到业务日由服务端按 `BUSINESS_TIMEZONE`（默认 `Asia/Shanghai`）生成，配置化、不硬编码；
   客户端展示时区跟随手机系统，两者互不影响。
6. **模拟支付**：`PAYMENT_PROVIDER=mock` 仅在 `NODE_ENV=test|demo` 允许；生产启动时检测到 mock 直接拒绝启动。

## 目录

```text
server/
├── src/
│   ├── lib/security.ts      # 错误码 / 密码 / 令牌
│   └── domain/ledger.ts     # 积分账本（纯函数）
├── test/
│   ├── security.test.ts     # 12 项
│   └── ledger.test.ts       # 14 项
├── package.json
└── tsconfig.json
```

## 下一步

1. `src/http/app.ts`：Fastify 实例 + 统一错误处理 + 请求 ID + `Idempotency-Key` 校验。
2. `src/routes/auth.ts`：`register / login / refresh / logout`；`src/routes/me.ts`：`/me`、`/me/entitlements`。
3. `prisma/schema.prisma`（建议稿）：`users`、`auth_sessions`、`daily_claims`、`point_wallets`、`point_ledger`，
   其中账本唯一键为 `(user_id, event_id)`。
4. 集成测试：需要 PostgreSQL（本机待装或用服务器），覆盖错误密码、令牌过期、刷新重放、撤销、A/B 越权。
