package com.example.otpforward

import com.example.otpforward.core.OtpDeliveryDeduplicator
import com.example.otpforward.core.OtpExtractor
import com.example.otpforward.core.OtpForwarder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class SmsReceiver : BroadcastReceiver() {
    private companion object {
        const val TAG = "OtpSms"
    }

    override fun onReceive(ctx: Context, i: Intent) {
        if (i.action != "android.provider.Telephony.SMS_RECEIVED") return

        val messages = android.provider.Telephony.Sms.Intents.getMessagesFromIntent(i)
        val body = messages.joinToString("") { it.displayMessageBody ?: "" }
        val sender = messages.firstOrNull()?.displayOriginatingAddress ?: ""

        Log.d(TAG, "received sender=$sender body=$body")
        val result = OtpExtractor.process(body, sender)
        if (result == null) {
            Log.d(TAG, "rejected by OTP rules")
            return
        }
        val otp = result["otp"].orEmpty()
        val claimedAtMs = System.currentTimeMillis()
        if (!OtpDeliveryDeduplicator.claim(ctx, otp, claimedAtMs)) {
            Log.d(TAG, "duplicate OTP ignored")
            return
        }
        Log.d(TAG, "matched otp=${result["otp"]} platform=${result["platform"]}")

        OtpForwarder.enqueue(
            ctx,
            otp,
            "SMS",
            result["platform"] ?: "",
            result["time"] ?: "",
            claimedAtMs,
        )
    }
}
