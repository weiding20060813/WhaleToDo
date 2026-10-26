package io.whaletodo.network

/**
 * 极简 JSON 取值工具。
 *
 * 说明：本模块刻意不引入 JSON 库，避免在客户端主工程之外新增依赖与构建插件。
 * 只用于从服务端固定结构里读少数标量字段（access_token / refresh_token / code / message）。
 * 接入 kotlinx.serialization 后应替换为正式的 DTO 解析。
 */
internal object Json {

    /** 读取顶层或任意层级中第一个 `"key":"value"` 的字符串值；不存在返回 null */
    fun stringField(json: String, key: String): String? {
        val regex = Regex("\"${Regex.escape(key)}\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")
        val raw = regex.find(json)?.groupValues?.getOrNull(1) ?: return null
        return unescape(raw)
    }

    /** 读取数值字段（允许整数与小数，返回 Long） */
    fun longField(json: String, key: String): Long? {
        val regex = Regex("\"${Regex.escape(key)}\"\\s*:\\s*(-?\\d+)")
        return regex.find(json)?.groupValues?.getOrNull(1)?.toLongOrNull()
    }

    /** 读取布尔字段 */
    fun booleanField(json: String, key: String): Boolean? {
        val regex = Regex("\"${Regex.escape(key)}\"\\s*:\\s*(true|false)")
        return regex.find(json)?.groupValues?.getOrNull(1)?.toBooleanStrictOrNull()
    }

    /** 生成 JSON 字符串字面量；调用方只传非敏感字段 */
    fun quote(value: String): String = buildString(value.length + 2) {
        append('"')
        value.forEach { c ->
            when (c) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
            }
        }
        append('"')
    }

    private fun unescape(s: String): String {
        if (!s.contains('\\')) return s
        val sb = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c != '\\' || i == s.length - 1) { sb.append(c); i++; continue }
            when (s[i + 1]) {
                'n' -> sb.append('\n')
                't' -> sb.append('\t')
                'r' -> sb.append('\r')
                '"' -> sb.append('"')
                '\\' -> sb.append('\\')
                '/' -> sb.append('/')
                else -> sb.append(s[i + 1])
            }
            i += 2
        }
        return sb.toString()
    }
}
