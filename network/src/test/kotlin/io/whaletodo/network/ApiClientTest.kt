package io.whaletodo.network

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.net.InetSocketAddress

/**
 * 用 JDK 自带 HttpServer 起一个假后端，验证客户端的真实 HTTP 行为：
 * 鉴权头、401 自动刷新并重试一次、刷新失败清令牌、错误码映射。
 */
class ApiClientTest {

    private lateinit var server: HttpServer
    private lateinit var baseUrl: String

    /** 记录收到的请求，便于断言 */
    private val calls = mutableListOf<Recorded>()

    data class Recorded(val method: String, val path: String, val auth: String?, val body: String, val idem: String?)

    @Before
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        baseUrl = "http://127.0.0.1:${server.address.port}/api/v1"
        server.executor = null
    }

    @After
    fun tearDown() {
        server.stop(0)
    }

    private fun handler(routes: (Recorded) -> Pair<Int, String>) {
        server.createContext("/") { exchange: HttpExchange ->
            val rec = Recorded(
                method = exchange.requestMethod,
                path = exchange.requestURI.path,
                auth = exchange.requestHeaders.getFirst("Authorization"),
                body = exchange.requestBody.readBytes().toString(Charsets.UTF_8),
                idem = exchange.requestHeaders.getFirst("Idempotency-Key"),
            )
            calls += rec
            val (status, body) = routes(rec)
            val bytes = body.toByteArray(Charsets.UTF_8)
            exchange.responseHeaders.add("Content-Type", "application/json; charset=utf-8")
            exchange.responseHeaders.add("x-request-id", "req-test-1")
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    private fun client(store: TokenStore = InMemoryTokenStore()) =
        ApiClient(ApiConfig(baseUrl, allowInsecureHttp = true), store)

    /* ---------------- 配置 ---------------- */

    @Test
    fun `release 构建拒绝明文 http 基址`() {
        try {
            ApiConfig("http://api.example.com/api/v1")
            fail("应当拒绝 http 基址")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("明文 HTTP"))
        }
    }

    @Test
    fun `调试构建允许 http，且路径拼接正确`() {
        val cfg = ApiConfig("http://10.0.2.2:8080/api/v1/", allowInsecureHttp = true)
        assertEquals("http://10.0.2.2:8080/api/v1/me", cfg.resolve("/me"))
        assertEquals("http://10.0.2.2:8080/api/v1/me", ApiConfig("http://10.0.2.2:8080/api/v1", true).resolve("/me"))
    }

    @Test
    fun `https 公网基址默认可用`() {
        val cfg = ApiConfig(ApiConfig.PUBLIC_BASE)
        assertEquals("https://api.whaletodo.top:8443/api/v1/health/live", cfg.resolve("/health/live"))
    }

    /* ---------------- 基本请求 ---------------- */

    @Test
    fun `请求自动带 Bearer 令牌`() {
        handler { Pair(200, """{"request_id":"r1","data":{"ok":true}}""") }
        val store = InMemoryTokenStore(TokenPair("access-1", "refresh-1"))
        val res = client(store).get("/me")

        assertEquals(200, res.status)
        assertEquals("req-test-1", res.requestId)
        assertEquals("Bearer access-1", calls.single().auth)
    }

    @Test
    fun `未登录时不带鉴权头`() {
        handler { Pair(200, """{"request_id":"r1","data":{}}""") }
        client().post("/auth/login", """{"username":"a","password":"b"}""", auth = false)
        assertNull(calls.single().auth)
    }

    @Test
    fun `写请求透传 Idempotency-Key`() {
        handler { Pair(201, """{"request_id":"r1","data":{}}""") }
        val store = InMemoryTokenStore(TokenPair("a", "r"))
        client(store).post("/rewards/daily/claim", auth = true, idempotencyKey = "key-1")
        assertEquals("key-1", calls.single().idem)
        assertEquals("POST", calls.single().method)
    }

    /* ---------------- 401 刷新 ---------------- */

    @Test
    fun `401 时用 refresh 换新令牌并重试原请求一次`() {
        var meCalls = 0
        handler { rec ->
            when (rec.path) {
                "/api/v1/me" -> {
                    meCalls++
                    if (meCalls == 1) Pair(401, """{"request_id":"r","error":{"code":"UNAUTHENTICATED","message":"过期"}}""")
                    else Pair(200, """{"request_id":"r2","data":{"user":{"id":"u1"}}}""")
                }
                "/api/v1/auth/refresh" -> Pair(200, """{"request_id":"r3","data":{"access_token":"new-a","refresh_token":"new-r"}}""")
                else -> Pair(404, """{"error":{"code":"VALIDATION_ERROR","message":"?"}}""")
            }
        }
        val store = InMemoryTokenStore(TokenPair("old-a", "old-r"))
        val res = client(store).get("/me")

        assertEquals(200, res.status)
        assertEquals(2, meCalls)
        assertEquals(TokenPair("new-a", "new-r"), store.read())
        assertEquals("Bearer new-a", calls.last().auth)
    }

    @Test
    fun `刷新失败时清空令牌并抛出 401`() {
        handler { rec ->
            if (rec.path == "/api/v1/auth/refresh") {
                Pair(401, """{"request_id":"r","error":{"code":"UNAUTHENTICATED","message":"刷新令牌已失效"}}""")
            } else {
                Pair(401, """{"request_id":"r","error":{"code":"UNAUTHENTICATED","message":"访问令牌无效"}}""")
            }
        }
        val store = InMemoryTokenStore(TokenPair("old-a", "old-r"))
        try {
            client(store).get("/me")
            fail("应当抛出 ApiException")
        } catch (e: ApiException) {
            assertEquals("UNAUTHENTICATED", e.code)
            assertEquals(401, e.status)
        }
        assertNull(store.read())
    }

    @Test
    fun `登录成功保存令牌`() {
        handler { Pair(200, """{"request_id":"r","data":{"access_token":"acc","refresh_token":"ref"}}""") }
        val store = InMemoryTokenStore()
        val tokens = AuthApi(client(store), store).login("alice", "S3cret-passw0rd")
        assertEquals(TokenPair("acc", "ref"), tokens)
        assertEquals(TokenPair("acc", "ref"), store.read())
    }

    @Test
    fun `退出登录即使服务端失败也清本地令牌`() {
        handler { Pair(500, """{"request_id":"r","error":{"code":"INTERNAL","message":"boom"}}""") }
        val store = InMemoryTokenStore(TokenPair("a", "r"))
        try {
            AuthApi(client(store), store).logout()
        } catch (_: ApiException) {
            // 预期
        }
        assertNull(store.read())
    }

    /* ---------------- 错误映射 ---------------- */

    @Test
    fun `非 2xx 映射为 ApiException 并带错误码与 request_id`() {
        handler { Pair(409, """{"request_id":"req-x","error":{"code":"CONFLICT","message":"今日已领取签到奖励"}}""") }
        val store = InMemoryTokenStore(TokenPair("a", "r"))
        try {
            client(store).post("/rewards/daily/claim", idempotencyKey = "k")
            fail("应当抛出")
        } catch (e: ApiException) {
            assertEquals("CONFLICT", e.code)
            assertEquals("今日已领取签到奖励", e.message)
            assertEquals(409, e.status)
            assertNotNull(e.requestId)
        }
    }

    @Test
    fun `响应缺字段时抛 INTERNAL`() {
        handler { Pair(200, """{"request_id":"r","data":{}}""") }
        val store = InMemoryTokenStore()
        try {
            AuthApi(client(store), store).login("alice", "pw")
            fail("应当抛出")
        } catch (e: ApiException) {
            assertEquals("INTERNAL", e.code)
            assertTrue(e.message.contains("access_token"))
        }
    }

    @Test
    fun `成功响应不带错误解析`() {
        handler { Pair(200, """{"request_id":"r","data":{"available":30,"reserved":0}}""") }
        val store = InMemoryTokenStore(TokenPair("a", "r"))
        val res = client(store).get("/wallet")
        assertTrue(res.isSuccess)
        assertFalse(res.body.isEmpty())
    }
}
