package io.whaletodo.network

/**
 * 账户相关的高层封装：登录成功后自动保存令牌。
 * 仅覆盖账户与会话；签到/钱包/订单/同步的调用由各业务层按需包装 [ApiClient]。
 */
class AuthApi(
    private val client: ApiClient,
    private val tokenStore: TokenStore,
) {
    /** 注册；body 形如 {"username":"..","password":".."} */
    fun register(username: String, password: String): ApiResponse =
        client.post("/auth/register", credentials(username, password), auth = false)

    /** 登录并保存令牌；返回令牌对 */
    fun login(username: String, password: String): TokenPair {
        val response = client.post("/auth/login", credentials(username, password), auth = false)
        val access = Json.stringField(response.body, "access_token")
            ?: throw ApiException("INTERNAL", "登录响应缺少 access_token", response.status, response.requestId)
        val refresh = Json.stringField(response.body, "refresh_token")
            ?: throw ApiException("INTERNAL", "登录响应缺少 refresh_token", response.status, response.requestId)
        val tokens = TokenPair(access, refresh)
        tokenStore.save(tokens)
        return tokens
    }

    /** 退出登录：先通知服务端撤销，再清本地令牌（服务端失败也要清） */
    fun logout() {
        try {
            client.post("/auth/logout")
        } finally {
            tokenStore.clear()
        }
    }

    /** 当前用户资料（原始 JSON，由上层解析） */
    fun me(): ApiResponse = client.get("/me")

    /** 签到状态 */
    fun dailyReward(): ApiResponse = client.get("/rewards/daily")

    /** 领取签到奖励（带幂等键，客户端重试不会重复领奖） */
    fun claimDailyReward(idempotencyKey: String): ApiResponse =
        client.post("/rewards/daily/claim", auth = true, idempotencyKey = idempotencyKey)

    /** 钱包余额 */
    fun wallet(): ApiResponse = client.get("/wallet")

    private fun credentials(username: String, password: String) =
        """{"username":"${esc(username)}","password":"${esc(password)}"}"""

    private fun esc(s: String) = s.replace("\\", "\\\\").replace("\"", "\\\"")
}
