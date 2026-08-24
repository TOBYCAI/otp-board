package com.example.otpforward.core

import android.content.Context
import androidx.core.content.edit

/**
 * Client-side server configuration: the ingest URL, the optional push token,
 * and a small list of recently used URLs. UI-free so it can live in the shared core.
 */
object ServerConfig {
    private const val P = "otp_prefs"
    private const val K_URL = "server_url"
    private const val K_TOKEN = "otp_token"
    private const val K_LIST = "saved_urls"
    // 占位符：安装后请在 App 内「服务器设置」填入你自己的服务端地址
    const val DEFAULT_URL = "https://your-otp-server.example/otp"

    fun getUrl(c: Context) = prefs(c).getString(K_URL, DEFAULT_URL)!!
    fun setUrl(c: Context, u: String) = prefs(c).edit { putString(K_URL, u.trim()) }

    fun getToken(c: Context) = prefs(c).getString(K_TOKEN, "")!!
    fun setToken(c: Context, t: String) = prefs(c).edit { putString(K_TOKEN, t.trim()) }

    fun getList(c: Context) =
        prefs(c).getString(K_LIST, "")!!.splitToSequence("\n").filter { it.isNotBlank() }.toMutableList()

    fun add(c: Context, u: String) {
        val l = getList(c)
        if (u !in l) { l.add(u.trim()); save(c, l) }
    }

    fun remove(c: Context, u: String) {
        save(c, getList(c).toMutableList().also { it.remove(u) })
    }

    private fun save(c: Context, l: List<String>) =
        prefs(c).edit { putString(K_LIST, l.joinToString("\n")) }

    private fun prefs(c: Context) = c.getSharedPreferences(P, Context.MODE_PRIVATE)
}
