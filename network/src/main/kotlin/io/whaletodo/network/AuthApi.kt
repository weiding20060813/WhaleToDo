package io.whaletodo.network

import java.time.Instant

data class AuthUser(val id: String, val username: String, val displayName: String?)
data class AccountProfile(val id: String, val username: String, val displayName: String?)
data class EmailCodeDispatch(val sent: Boolean, val retryAfterMs: Long)
data class EmailTicket(val ticket: String, val expiresInSeconds: Int)
data class Entitlements(val vipActive: Boolean, val vipExpiresAt: Instant?)
data class WalletBalance(val available: Int, val reserved: Int)
data class DailyStatus(val businessDate: String, val claimed: Boolean)
data class DailyClaim(val businessDate: String, val pointsAwarded: Int, val availablePoints: Int)

/**
 * 账户相关的高层封装：登录成功后自动保存令牌。
 * 邮箱注册/重置使用「发码 → verify 换 ticket → 提交」流程；ticket 只在本进程内短暂持有。
 */
class AuthApi(
    private val client: ApiClient,
    private val tokenStore: TokenStore,
) {
    /** 保留用户名注册；body 形如 {"username":"..","password":".."} */
    fun register(username: String, password: String): ApiResponse =
        client.post("/auth/register", json("username" to username, "password" to password), auth = false)

    /** 保留用户名登录并保存令牌 */
    fun login(username: String, password: String): TokenPair =
        loginWith("username", username, password)

    /** 邮箱登录并保存令牌 */
    fun loginWithEmail(email: String, password: String): TokenPair =
        loginWith("email", email, password)

    private fun loginWith(field: String, principal: String, password: String): TokenPair {
        val response = client.post(
            "/auth/login",
            json(field to principal, "password" to password),
            auth = false,
        )
        val access = Json.stringField(response.body, "access_token")
            ?: throw missing(response, "access_token")
        val refresh = Json.stringField(response.body, "refresh_token")
            ?: throw missing(response, "refresh_token")
        return TokenPair(access, refresh).also(tokenStore::save)
    }

    /** 发送邮箱验证码；purpose 为 register / reset */
    fun sendEmailCode(email: String, purpose: String): EmailCodeDispatch {
        val response = client.post(
            "/auth/email/send-code",
            json("email" to email, "purpose" to purpose),
            auth = false,
        )
        return EmailCodeDispatch(
            sent = Json.booleanField(response.body, "sent") ?: false,
            retryAfterMs = Json.longField(response.body, "retry_after_ms") ?: 60_000L,
        )
    }

    /** 验证码换 ticket；ticket 由服务端限时消费 */
    fun verifyEmailCode(email: String, code: String, purpose: String): EmailTicket {
        val response = client.post(
            "/auth/email/verify",
            json("email" to email, "code" to code, "purpose" to purpose),
            auth = false,
        )
        return EmailTicket(
            ticket = Json.stringField(response.body, "ticket") ?: throw missing(response, "ticket"),
            expiresInSeconds = jsonInt(response, "expires_in") ?: 60,
        )
    }

    /** 邮箱注册；displayName 为空时由服务端生成 */
    fun registerWithEmail(
        email: String,
        ticket: String,
        password: String,
        displayName: String? = null,
    ): AuthUser {
        val response = client.post(
            "/auth/register/email",
            json(
                "email" to email,
                "ticket" to ticket,
                "password" to password,
                "display_name" to displayName?.takeIf { it.isNotBlank() },
            ),
            auth = false,
        )
        return parseUser(response)
    }

    /** 邮箱重置密码；成功后服务端撤销旧会话 */
    fun resetPassword(email: String, ticket: String, password: String) {
        client.post(
            "/auth/password/reset",
            json("email" to email, "ticket" to ticket, "password" to password),
            auth = false,
        )
    }

    /** 退出登录：先通知服务端撤销，再清本地令牌（服务端失败也要清） */
    fun logout() {
        try {
            client.post("/auth/logout")
        } finally {
            tokenStore.clear()
        }
    }

    /** 当前用户资料 */
    fun me(): AccountProfile {
        val user = parseUser(client.get("/me"))
        return AccountProfile(user.id, user.username, user.displayName)
    }

    /** 权益（当前服务端返回 VIP 占位与钱包余额） */
    fun entitlements(): Entitlements {
        val response = client.get("/me/entitlements")
        val expires = Json.stringField(response.body, "expires_at")
            ?.let { runCatching { Instant.parse(it) }.getOrNull() }
        return Entitlements(
            vipActive = Json.booleanField(response.body, "active") ?: false,
            vipExpiresAt = expires,
        )
    }

    /** 签到状态 */
    fun dailyReward(): DailyStatus {
        val response = client.get("/rewards/daily")
        return DailyStatus(
            businessDate = Json.stringField(response.body, "business_date").orEmpty(),
            claimed = Json.booleanField(response.body, "claimed") ?: false,
        )
    }

    /** 领取签到奖励（带幂等键，客户端重试不会重复领奖） */
    fun claimDailyReward(idempotencyKey: String): DailyClaim {
        val response = client.post("/rewards/daily/claim", auth = true, idempotencyKey = idempotencyKey)
        return DailyClaim(
            businessDate = Json.stringField(response.body, "business_date").orEmpty(),
            pointsAwarded = jsonInt(response, "points_awarded") ?: 0,
            availablePoints = jsonInt(response, "available") ?: 0,
        )
    }

    /** 钱包余额 */
    fun wallet(): WalletBalance {
        val response = client.get("/wallet")
        return WalletBalance(
            available = jsonInt(response, "available") ?: throw missing(response, "available"),
            reserved = jsonInt(response, "reserved") ?: 0,
        )
    }

    private fun parseUser(response: ApiResponse): AuthUser = AuthUser(
        id = Json.stringField(response.body, "id") ?: throw missing(response, "id"),
        username = Json.stringField(response.body, "username") ?: throw missing(response, "username"),
        displayName = Json.stringField(response.body, "display_name"),
    )

    private fun json(vararg fields: Pair<String, String?>): String =
        fields.joinToString(",", "{", "}") { (key, value) ->
            Json.quote(key) + ":" + (value?.let(Json::quote) ?: "null")
        }

    private fun jsonInt(response: ApiResponse, key: String): Int? =
        Json.longField(response.body, key)?.toInt()

    private fun missing(response: ApiResponse, field: String) =
        ApiException("INTERNAL", "响应缺少 $field", response.status, response.requestId)
}
