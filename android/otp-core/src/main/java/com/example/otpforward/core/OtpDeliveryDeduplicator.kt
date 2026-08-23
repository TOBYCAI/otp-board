package com.example.otpforward.core

import android.content.Context
import androidx.core.content.edit
import java.security.MessageDigest

/** Prevents one OTP being forwarded again by another channel or after a process restart. */
object OtpDeliveryDeduplicator {
    internal const val DUPLICATE_WINDOW_MS = 2 * 60_000L
    private const val PREFERENCES_NAME = "otp_delivery_deduplication"
    private val recent = linkedMapOf<String, Long>()

    @Synchronized
    fun claim(context: Context, otp: String, nowMs: Long = System.currentTimeMillis()): Boolean {
        val preferences = context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
        val staleKeys = preferences.all
            .filter { (key, value) ->
                val timestamp = value as? Long
                key.startsWith("otp_") && (timestamp == null || isExpired(timestamp, nowMs))
            }
            .keys
        if (staleKeys.isNotEmpty()) {
            preferences.edit { staleKeys.forEach { remove(it) } }
        }
        return claim(
            otp = otp,
            nowMs = nowMs,
            readPersisted = { key -> preferences.getLong(key, Long.MIN_VALUE).takeUnless { it == Long.MIN_VALUE } },
            writePersisted = { key, value -> preferences.edit { putLong(key, value) } },
        )
    }

    /** Releases a reservation after final delivery failure, without deleting a newer claim. */
    @Synchronized
    fun release(context: Context, otp: String, claimedAtMs: Long) {
        val preferences = context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
        release(
            otp = otp,
            claimedAtMs = claimedAtMs,
            readPersisted = { key -> preferences.getLong(key, Long.MIN_VALUE).takeUnless { it == Long.MIN_VALUE } },
            removePersisted = { key -> preferences.edit { remove(key) } },
        )
    }

    @Synchronized
    internal fun release(
        otp: String,
        claimedAtMs: Long,
        readPersisted: (String) -> Long? = { null },
        removePersisted: (String) -> Unit = { },
    ) {
        if (otp.isBlank()) return
        val key = otpKey(otp)
        if (recent[key] == claimedAtMs) recent.remove(key)
        if (readPersisted(key) == claimedAtMs) removePersisted(key)
    }

    @Synchronized
    internal fun claim(
        otp: String,
        nowMs: Long = System.currentTimeMillis(),
        readPersisted: (String) -> Long? = { null },
        writePersisted: (String, Long) -> Unit = { _, _ -> },
    ): Boolean {
        if (otp.isBlank()) return false
        recent.entries.removeAll { isExpired(it.value, nowMs) }

        val key = otpKey(otp)
        val previous = listOfNotNull(recent[key], readPersisted(key)).maxOrNull()
        if (previous != null && !isExpired(previous, nowMs)) return false

        recent[key] = nowMs
        writePersisted(key, nowMs)
        return true
    }

    private fun isExpired(previousMs: Long, nowMs: Long): Boolean {
        // Treat a backwards clock jump as stale instead of suppressing OTPs indefinitely.
        return nowMs < previousMs || nowMs - previousMs > DUPLICATE_WINDOW_MS
    }

    private fun otpKey(otp: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(otp.trim().toByteArray(Charsets.UTF_8))
        return "otp_" + digest.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
    }

    @Synchronized
    internal fun clearForTest() = recent.clear()
}
