package com.example.otpforward.core

import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.widget.Toast
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Delivers a claimed OTP once, with bounded retries, even if the process was restarted. */
class ForwardJobService : JobService() {
    companion object {
        private const val TAG = "OtpForwardJob"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        const val EXTRA_OTP = "otp"
        const val EXTRA_SOURCE = "source"
        const val EXTRA_PLATFORM = "platform"
        const val EXTRA_TIME = "time"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_URL = "url"
        const val EXTRA_DEADLINE = "deadline"
        const val EXTRA_CLAIMED_AT = "claimed_at"

        private val client = OkHttpClient.Builder()
            .callTimeout(10, TimeUnit.SECONDS)
            .build()
    }

    private val executor = Executors.newSingleThreadExecutor()

    override fun onStartJob(params: JobParameters): Boolean {
        executor.execute {
            jobFinished(params, deliver(params))
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = true

    private fun deliver(params: JobParameters): Boolean {
        val otp = params.extras.getString(EXTRA_OTP).orEmpty()
        val source = params.extras.getString(EXTRA_SOURCE).orEmpty()
        val platform = params.extras.getString(EXTRA_PLATFORM).orEmpty()
        val time = params.extras.getString(EXTRA_TIME).orEmpty()
        val token = params.extras.getString(EXTRA_TOKEN).orEmpty()
        val url = params.extras.getString(EXTRA_URL).orEmpty()
        val deadlineMs = params.extras.getLong(EXTRA_DEADLINE, 0L)
        val claimedAtMs = params.extras.getLong(EXTRA_CLAIMED_AT, 0L)

        val isLastAttempt = deadlineMs > 0L && SystemClock.elapsedRealtime() >= deadlineMs

        val payload = OtpPayload(otp, source, platform, time, token).toJson()

        val request = runCatching {
            Request.Builder()
                .url(url)
                .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))
                .build()
        }.getOrElse {
            release(otp, claimedAtMs)
            Log.e(TAG, "invalid URL", it)
            return false
        }

        return try {
            client.newCall(request).execute().use { response ->
                val code = response.code
                when {
                    code in 200..299 -> {
                        Log.d(TAG, "forward ok code=$code otp=$otp")
                        false
                    }
                    code == 408 || code == 429 || code >= 500 -> {
                        if (isLastAttempt) {
                            release(otp, claimedAtMs)
                            notifyFailure("转发失败: HTTP $code")
                            false
                        } else {
                            Log.d(TAG, "retryable response=$code otp=$otp")
                            true
                        }
                    }
                    else -> {
                        release(otp, claimedAtMs)
                        notifyFailure(
                            when (code) {
                                403 -> "Token 错误，请检查设置"
                                else -> "转发失败: HTTP $code"
                            },
                        )
                        false
                    }
                }
            }
        } catch (e: IOException) {
            Log.e(TAG, "forward failed otp=$otp", e)
            if (isLastAttempt) {
                release(otp, claimedAtMs)
                notifyFailure("转发失败，请检查网络")
                false
            } else {
                true
            }
        }
    }

    private fun release(otp: String, claimedAtMs: Long) {
        if (otp.isNotEmpty() && claimedAtMs > 0L) {
            OtpDeliveryDeduplicator.release(applicationContext, otp, claimedAtMs)
        }
    }

    private fun notifyFailure(message: String) {
        Handler(Looper.getMainLooper()).post {
            Toast.makeText(applicationContext, message, Toast.LENGTH_LONG).show()
        }
    }
}
