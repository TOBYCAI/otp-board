package com.example.otpforward

import com.example.otpforward.core.OtpDeliveryDeduplicator
import com.example.otpforward.core.OtpExtractor
import com.example.otpforward.core.OtpForwarder

import android.app.Notification
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

class NotificationListener : NotificationListenerService() {
    private companion object {
        const val TAG = "OtpNotification"
    }

    private data class NotificationSource(
        val source: String,
        val fallbackPlatform: String,
    )

    private val supportedPackages = mapOf(
        // SMS/RCS clients. RCS and some vendor messages do not emit SMS_RECEIVED, so their
        // notification is the only reliable local delivery surface.
        "com.google.android.apps.messaging" to NotificationSource("SMS", "Google Messages"),
        "com.android.mms" to NotificationSource("SMS", "短信"),
        "com.samsung.android.messaging" to NotificationSource("SMS", "Samsung Messages"),
        "com.miui.mms" to NotificationSource("SMS", "小米短信"),
        "com.huawei.message" to NotificationSource("SMS", "华为信息"),
        "com.coloros.mcs" to NotificationSource("SMS", "OPPO 信息"),
        "com.oneplus.mms" to NotificationSource("SMS", "OnePlus Messages"),
        "com.whatsapp" to NotificationSource("WhatsApp", "WhatsApp"),
        "com.whatsapp.w4b" to NotificationSource("WhatsApp", "WhatsApp Business"),
        "com.tencent.mm" to NotificationSource("WeChat", "微信"),
        "com.tencent.wework" to NotificationSource("WeChat Work", "企业微信"),
        "com.alibaba.android.rimet" to NotificationSource("DingTalk", "钉钉"),
        "com.ss.android.lark" to NotificationSource("Feishu", "飞书"),
        "com.bytedance.lark" to NotificationSource("Lark", "Lark"),
        "org.telegram.messenger" to NotificationSource("Telegram", "Telegram"),
        "org.thoughtcrime.securesms" to NotificationSource("Signal", "Signal"),
        "com.viber.voip" to NotificationSource("Viber", "Viber"),
        "com.google.android.gm" to NotificationSource("Email", "Gmail"),
        "com.microsoft.office.outlook" to NotificationSource("Email", "Outlook"),
        "com.tencent.androidqqmail" to NotificationSource("Email", "QQ邮箱"),
        "com.netease.mobimail" to NotificationSource("Email", "网易邮箱"),
        "com.yahoo.mobile.client.android.mail" to NotificationSource("Email", "Yahoo Mail"),
        "com.samsung.android.email.provider" to NotificationSource("Email", "Samsung Email"),
        "com.fsck.k9" to NotificationSource("Email", "K-9 Mail"),
        "eu.faircode.email" to NotificationSource("Email", "FairEmail"),
        "ch.protonmail.android" to NotificationSource("Email", "Proton Mail"),
    )

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val source = supportedPackages[sbn.packageName]
            ?: if (sbn.packageName == "com.android.shell" && isDebuggable()) {
                // Enables adb `cmd notification post` end-to-end tests without weakening release.
                NotificationSource("TestNotification", "ADB Notification")
            } else {
                return
            }
        if ((sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY) != 0) return

        val title = sbn.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        // Vendor notification bundles are not type-consistent across Android releases. A broken
        // notification must never crash the process and take SMS_RECEIVED down with it.
        val content = runCatching { buildNotificationContent(sbn) }
            .onFailure { Log.e(TAG, "failed to inspect notification package=${sbn.packageName}", it) }
            .getOrNull()
            .orEmpty()
        if (content.isBlank()) return

        val result = OtpExtractor.process(content, title.ifEmpty { source.fallbackPlatform }) ?: return
        val otp = result["otp"].orEmpty()
        val claimedAtMs = System.currentTimeMillis()
        if (!OtpDeliveryDeduplicator.claim(this, otp, claimedAtMs)) {
            if (isDebuggable()) Log.d(TAG, "duplicate OTP ignored")
            return
        }
        if (isDebuggable()) {
            Log.d(TAG, "matched package=${sbn.packageName}, source=${source.source}, content=$content, otp=${result["otp"]}")
        }

        OtpForwarder.enqueue(
            this,
            otp,
            source.source,
            result["platform"].orEmpty().ifEmpty { title.ifEmpty { source.fallbackPlatform } },
            result["time"] ?: "",
            claimedAtMs,
        )
    }

    private fun buildNotificationContent(sbn: StatusBarNotification): String {
        val extras = sbn.notification.extras
        val messages = getMessageBundles(extras).map { message ->
            NotificationContentSelector.Message(
                sender = message.getCharSequence("sender")?.toString(),
                text = message.getCharSequence("text")?.toString(),
                time = message.getLong("time", 0L),
            )
        }
        val content = NotificationContentSelector.select(
            title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
            bigTitle = extras.getCharSequence(Notification.EXTRA_TITLE_BIG)?.toString(),
            text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
            bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString(),
            textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
                ?.map(CharSequence::toString)
                .orEmpty(),
            messages = messages,
        )

        if (isDebuggable() && content.isNotEmpty()) {
            Log.d(TAG, "captured package=${sbn.packageName}, keys=${extras.keySet().sorted()}, content=$content")
        }

        return content
    }

    private fun isDebuggable(): Boolean {
        return (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    }

    // Do not use Bundle.getParcelableArray(key, Bundle::class.java) here. Some Android 16
    // notifications return a runtime Parcelable[] even though every element is a Bundle; Kotlin
    // then inserts an Array<Bundle> cast and crashes with ClassCastException.
    @Suppress("DEPRECATION")
    private fun getMessageBundles(extras: Bundle): List<Bundle> {
        return extras.getParcelableArray(Notification.EXTRA_MESSAGES)
            ?.mapNotNull { it as? Bundle }
            .orEmpty()
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {}
}
