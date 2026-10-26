package io.whaletodo.app.account

import io.whaletodo.app.profile.CodePurpose
import io.whaletodo.app.profile.ProfileBridge
import io.whaletodo.app.profile.ProfileException
import io.whaletodo.app.profile.VerificationDispatch
import io.whaletodo.network.ApiException
import io.whaletodo.network.AuthApi
import java.io.IOException
import java.time.LocalDate
import java.util.UUID
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** 把现有账号弹窗接到真实邮箱账户 API；不改 UI，只提供 ProfileBridge 实现。 */
class ServerProfileBridge(
    private val auth: AuthApi,
    private val session: AccountSession,
    private val credentials: AccountCredentials,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ProfileBridge {
    override val details = session.details

    override suspend fun login(email: String, password: String) = call {
        val clean = email.trim()
        auth.loginWithEmail(clean, password)
        credentials.saveEmail(clean)
        loadAccount(clean)
    }

    override suspend fun register(
        email: String,
        code: String,
        password: String,
        nickname: String?,
    ): Unit = call {
        val clean = email.trim()
        val ticket = auth.verifyEmailCode(clean, code, PURPOSE_REGISTER).ticket
        auth.registerWithEmail(clean, ticket, password, nickname)
        Unit
    }

    override suspend fun requestCode(
        email: String,
        purpose: CodePurpose,
    ): VerificationDispatch = call {
        val result = auth.sendEmailCode(email.trim(), purpose.wire())
        if (!result.sent) {
            val seconds = ((result.retryAfterMs + 999) / 1000).coerceAtLeast(1)
            throw ProfileException("验证码发送过于频繁，请${seconds}秒后再试")
        }
        VerificationDispatch((result.retryAfterMs / 1000).toInt().coerceIn(1, 300))
    }

    override suspend fun resetPassword(
        email: String,
        code: String,
        password: String,
    ) = call {
        val clean = email.trim()
        val ticket = auth.verifyEmailCode(clean, code, PURPOSE_RESET).ticket
        auth.resetPassword(clean, ticket, password)
        credentials.clear()
        session.clear()
    }

    override suspend fun signOut() {
        withContext(io) {
            try {
                auth.logout()
            } catch (_: Exception) {
                // 服务端不可达也要在本机退出；令牌在 finally 中清除。
            } finally {
                credentials.clear()
                session.clear()
            }
        }
    }

    override suspend fun signIn(): Unit = call {
        if (session.details.value == null) throw ProfileException("请先登录")
        val businessDate = try {
            auth.claimDailyReward(UUID.randomUUID().toString()).businessDate
        } catch (e: ApiException) {
            if (e.code != "CONFLICT") throw e
            auth.dailyReward().businessDate
        }
        val entitlements = auth.entitlements()
        val wallet = auth.wallet()
        session.updateBalance(entitlements, wallet.available)
        parseDate(businessDate)?.let(session::markSignedIn)
        Unit
    }

    /** App 启动时若本地仍有令牌，恢复登录态；401 会清空本地凭据并回到 guest。 */
    suspend fun restore() {
        if (credentials.read() == null) return
        val email = credentials.readEmail().orEmpty()
        withContext(io) {
            try {
                loadAccount(email)
            } catch (e: ApiException) {
                if (e.status == 401 || e.code == "UNAUTHENTICATED") {
                    credentials.clear()
                    session.clear()
                }
            } catch (_: IOException) {
                // 离线启动保留令牌，下次启动再试。
            }
        }
    }

    private suspend fun loadAccount(email: String) {
        val profile = auth.me()
        val entitlements = auth.entitlements()
        val wallet = auth.wallet()
        session.update(email, profile, entitlements, wallet.available)
    }

    private suspend fun <T> call(block: suspend () -> T): T = withContext(io) {
        try {
            block()
        } catch (e: ApiException) {
            if (e.status == 401 || e.code == "UNAUTHENTICATED") {
                credentials.clear()
                session.clear()
            }
            throw ProfileException(friendly(e))
        } catch (_: IOException) {
            throw ProfileException("网络连接失败，请检查网络后重试")
        }
    }

    private fun friendly(e: ApiException): String = when (e.code) {
        "UNAUTHENTICATED" -> "邮箱或密码错误，或登录已过期，请重新登录"
        "RATE_LIMITED" -> "操作过于频繁，请稍后再试"
        "CONFLICT" -> "该邮箱已被注册"
        "VALIDATION_ERROR" -> e.message.takeIf { it.isNotBlank() } ?: "请检查输入信息"
        "INTERNAL" -> "服务暂时不可用，请稍后重试"
        else -> "暂时无法完成，请稍后重试"
    }

    private fun parseDate(value: String): LocalDate? =
        runCatching { LocalDate.parse(value) }.getOrNull()

    private fun CodePurpose.wire(): String = when (this) {
        CodePurpose.REGISTER -> PURPOSE_REGISTER
        CodePurpose.RESET_PASSWORD -> PURPOSE_RESET
    }

    private companion object {
        const val PURPOSE_REGISTER = "register"
        const val PURPOSE_RESET = "reset"
    }
}
