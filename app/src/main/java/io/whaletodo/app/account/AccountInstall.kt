package io.whaletodo.app.account

import android.content.Context
import io.whaletodo.app.BuildConfig
import io.whaletodo.app.agent.AgentBridgeHub
import io.whaletodo.app.profile.ProfileBridgeHub
import io.whaletodo.network.ApiClient
import io.whaletodo.network.ApiConfig
import io.whaletodo.network.AuthApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

private val accountScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
private val installLock = Any()
private var installed = false

/**
 * 在 Compose 启动前安装账户 bridge。
 * MainActivity 只调用这一处；API 基址来自 BuildConfig，release 不允许明文 HTTP。
 */
fun installAccount(context: Context) {
    val bridge = synchronized(installLock) {
        if (installed) return
        installed = true
        val credentials = KeystoreTokenStore(context.applicationContext)
        val config = ApiConfig(
            baseUrl = BuildConfig.API_BASE_URL,
            allowInsecureHttp = BuildConfig.DEBUG,
        )
        val auth = AuthApi(ApiClient(config, credentials), credentials)
        val session = AccountSession()
        val profile = ServerProfileBridge(auth, session, credentials)
        val originalAgent = AgentBridgeHub.bridge
        ProfileBridgeHub.bridge = profile
        AgentBridgeHub.bridge = AccountAgentBridge(originalAgent, session)
        profile
    }
    accountScope.launch {
        runCatching { bridge.restore() }
    }
}
