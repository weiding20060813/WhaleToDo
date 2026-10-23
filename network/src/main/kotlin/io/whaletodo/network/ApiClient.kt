package io.whaletodo.network

import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/** 服务端统一错误：对应契约里的 9 个错误码 */
class ApiException(
    val code: String,
    override val message: String,
    val status: Int,
    val requestId: String?,
) : Exception(message)

/** 原始响应：成功时 body 为 `{request_id, data:{...}}` */
data class ApiResponse(val status: Int, val body: String, val requestId: String?) {
    val isSuccess: Boolean get() = status in 200..299
}

/**
 * HTTP 客户端。
 *
 * 行为约定（与契约一致）：
 *  - 自动带上 `Authorization: Bearer <access_token>`
 *  - 访问令牌过期（401）时用 refresh_token 换一次新令牌并**重试原请求一次**
 *  - 刷新失败立即清空本地令牌（避免拿失效令牌反复请求）
 *  - 非 2xx 一律抛 [ApiException]，携带错误码、状态码与 request_id
 *  - 写请求由调用方传 Idempotency-Key
 *
 * 不做的部分：
 *  - 不解析业务 DTO（由上层按需解析 body）
 *  - 不做重试风暴：只重试一次刷新
 */
class ApiClient(
    private val config: ApiConfig,
    private val tokenStore: TokenStore,
    private val timeoutMs: Int = 15_000,
) {
    fun get(path: String, auth: Boolean = true): ApiResponse = request("GET", path, null, auth, null)

    fun post(
        path: String,
        body: String? = null,
        auth: Boolean = true,
        idempotencyKey: String? = null,
    ): ApiResponse = request("POST", path, body, auth, idempotencyKey)

    private fun request(
        method: String,
        path: String,
        body: String?,
        auth: Boolean,
        idempotencyKey: String?,
    ): ApiResponse {
        var response = execute(method, path, body, auth, idempotencyKey)
        if (response.status == 401 && auth) {
            val refreshed = refreshTokens()
            if (refreshed) {
                response = execute(method, path, body, auth, idempotencyKey)
            } else {
                tokenStore.clear()
            }
        }
        if (!response.isSuccess) throw toException(response)
        return response
    }

    /** 用 refresh_token 换新令牌；成功返回 true 并写回 TokenStore */
    fun refreshTokens(): Boolean {
        val current = tokenStore.read() ?: return false
        val payload = """{"refresh_token":"${escape(current.refreshToken)}"}"""
        val response = execute("POST", "/auth/refresh", payload, auth = false, idempotencyKey = null)
        if (!response.isSuccess) return false
        val access = Json.stringField(response.body, "access_token") ?: return false
        val refresh = Json.stringField(response.body, "refresh_token") ?: return false
        tokenStore.save(TokenPair(access, refresh))
        return true
    }

    private fun execute(
        method: String,
        path: String,
        body: String?,
        auth: Boolean,
        idempotencyKey: String?,
    ): ApiResponse {
        val url = java.net.URI.create(config.resolve(path)).toURL()
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            instanceFollowRedirects = false
            setRequestProperty("Accept", "application/json")
        }
        try {
            if (auth) {
                tokenStore.read()?.let { conn.setRequestProperty("Authorization", "Bearer ${it.accessToken}") }
            }
            idempotencyKey?.let { conn.setRequestProperty("Idempotency-Key", it) }
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.use { s -> BufferedReader(s.reader(Charsets.UTF_8)).readText() } ?: ""
            return ApiResponse(status, text, conn.getHeaderField("x-request-id"))
        } finally {
            conn.disconnect()
        }
    }

    private fun toException(response: ApiResponse): ApiException {
        val code = Json.stringField(response.body, "code") ?: "INTERNAL"
        val message = Json.stringField(response.body, "message") ?: "请求失败（HTTP ${response.status}）"
        return ApiException(code, message, response.status, response.requestId)
    }

    private fun escape(s: String): String = s.replace("\\", "\\\\").replace("\"", "\\\"")
}
