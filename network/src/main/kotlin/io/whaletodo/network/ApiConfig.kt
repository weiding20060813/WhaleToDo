package io.whaletodo.network

/**
 * API 基址配置：**必须可配置**（部署说明第 3 条）。
 *
 * 规则：
 *  - 发布构建只允许 https（不允许把访问令牌发往 http）
 *  - 调试构建可显式放开 http（allowInsecureHttp = true），用于本机/模拟器联调
 *  - 域名与端口不写死：由调用方注入，改为 api.whaletodo.top:8443 时无需改代码
 */
data class ApiConfig(
    val baseUrl: String,
    val allowInsecureHttp: Boolean = false,
) {
    init {
        require(baseUrl.isNotBlank()) { "baseUrl 不能为空" }
        val normalized = baseUrl.trimEnd('/')
        require(normalized.startsWith("http://") || normalized.startsWith("https://")) {
            "baseUrl 必须以 http:// 或 https:// 开头，当前：$baseUrl"
        }
        if (!normalized.startsWith("https://") && !allowInsecureHttp) {
            throw IllegalArgumentException("不允许使用明文 HTTP 基址：$baseUrl（仅调试构建可显式放开）")
        }
    }

    /** 规范化后的基址（去掉末尾斜杠） */
    val normalizedBaseUrl: String = baseUrl.trimEnd('/')

    /** 拼接路径：path 需以 / 开头 */
    fun resolve(path: String): String {
        require(path.startsWith("/")) { "path 必须以 / 开头，当前：$path" }
        return normalizedBaseUrl + path
    }

    companion object {
        /** 模拟器访问宿主机 */
        const val EMULATOR_HOST_BASE = "http://10.0.2.2:8080/api/v1"

        /** 真机同局域网（把 <IP> 换成开发机内网地址） */
        fun lanBase(ip: String, port: Int = 8080) = "http://$ip:$port/api/v1"

        /** 部署后的公网基址（待公网 TLS 验证通过后启用） */
        const val PUBLIC_BASE = "https://api.whaletodo.top:8443/api/v1"
    }
}
