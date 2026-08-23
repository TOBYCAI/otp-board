package com.example.otpforward.core

import org.json.JSONObject

/**
 * The canonical OTP payload — the single object that travels across the wire.
 * Shape is enforced by `shared/proto/otp-payload.schema.json` (validated server-side).
 *
 * `source` is intentionally a constructor parameter: the EXTRACTOR does not know
 * the channel, but the caller (SMS broadcast, notification listener, …) does.
 */
data class OtpPayload(
    val otp: String,
    val source: String,
    val platform: String,
    val time: String,
    val token: String = "",
) {
    fun toJson(): JSONObject {
        val obj = JSONObject()
            .put("otp", otp)
            .put("source", source)
            .put("platform", platform)
            .put("time", time)
        if (token.isNotEmpty()) obj.put("token", token)
        return obj
    }

    fun toJsonString(): String = toJson().toString()
}
