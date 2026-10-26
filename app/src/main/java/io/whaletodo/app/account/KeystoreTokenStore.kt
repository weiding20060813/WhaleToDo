package io.whaletodo.app.account

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import io.whaletodo.network.TokenPair
import io.whaletodo.network.TokenStore
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** 账户凭据存储：令牌和登录邮箱都只用密文落盘。 */
interface AccountCredentials : TokenStore {
    fun readEmail(): String?
    fun saveEmail(email: String)
}

/**
 * AndroidKeyStore AES/GCM 加密的令牌存储。
 * SharedPreferences 里只有 `base64(iv):base64(ciphertext)`，没有明文令牌或验证码。
 */
class KeystoreTokenStore(context: Context) : AccountCredentials {
    private val prefs = context.applicationContext
        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val lock = Any()

    override fun read(): TokenPair? = synchronized(lock) {
        val plain = decrypt(KEY_TOKENS) ?: return null
        val split = plain.indexOf('\n')
        if (split <= 0 || split == plain.lastIndex) {
            clearLocked()
            return null
        }
        TokenPair(plain.substring(0, split), plain.substring(split + 1))
    }

    override fun save(tokens: TokenPair) = synchronized(lock) {
        require(tokens.accessToken.isNotBlank() && tokens.refreshToken.isNotBlank()) {
            "令牌不能为空"
        }
        write(KEY_TOKENS, tokens.accessToken + "\n" + tokens.refreshToken)
    }

    override fun saveEmail(email: String) = synchronized(lock) {
        val clean = email.trim()
        if (clean.isEmpty()) prefs.edit().remove(KEY_EMAIL).apply()
        else write(KEY_EMAIL, clean)
    }

    override fun readEmail(): String? = synchronized(lock) {
        decrypt(KEY_EMAIL)?.takeIf { it.isNotBlank() }
    }

    override fun clear() = synchronized(lock) {
        clearLocked()
    }

    private fun clearLocked() {
        prefs.edit().remove(KEY_TOKENS).remove(KEY_EMAIL).apply()
        runCatching {
            keyStore().deleteEntry(KEY_ALIAS)
        }
    }

    private fun write(name: String, plain: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val encrypted = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val stored = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(encrypted, Base64.NO_WRAP)
        prefs.edit().putString(name, stored).apply()
    }

    private fun decrypt(name: String): String? {
        val stored = prefs.getString(name, null) ?: return null
        return try {
            val parts = stored.split(':', limit = 2)
            require(parts.size == 2)
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val encrypted = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
            cipher.doFinal(encrypted).toString(Charsets.UTF_8)
        } catch (_: Exception) {
            prefs.edit().remove(name).apply()
            null
        }
    }

    private fun secretKey(): SecretKey {
        val store = keyStore()
        (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun keyStore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "whaletodo.account.credentials.v1"
        const val PREFS_NAME = "account_credentials"
        const val KEY_TOKENS = "tokens"
        const val KEY_EMAIL = "email"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
