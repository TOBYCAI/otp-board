package com.example.otpforward.core

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.os.PersistableBundle
import android.os.SystemClock
import android.util.Log

/** Enqueues a claimed OTP for durable delivery via JobScheduler. */
object OtpForwarder {
    private const val TAG = "OtpForwarder"
    private const val OVERRIDE_DEADLINE_MS = 3 * 60_000L
    private const val INITIAL_BACKOFF_MS = 5_000L

    fun enqueue(
        context: Context,
        otp: String,
        source: String,
        platform: String,
        time: String,
        claimedAtMs: Long,
    ) {
        val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
        val deadline = SystemClock.elapsedRealtime() + OVERRIDE_DEADLINE_MS

        val extras = PersistableBundle().apply {
            putString(ForwardJobService.EXTRA_OTP, otp)
            putString(ForwardJobService.EXTRA_SOURCE, source)
            putString(ForwardJobService.EXTRA_PLATFORM, platform)
            putString(ForwardJobService.EXTRA_TIME, time)
            putString(ForwardJobService.EXTRA_TOKEN, ServerConfig.getToken(context))
            putString(ForwardJobService.EXTRA_URL, ServerConfig.getUrl(context))
            putLong(ForwardJobService.EXTRA_DEADLINE, deadline)
            putLong(ForwardJobService.EXTRA_CLAIMED_AT, claimedAtMs)
        }

        val jobInfo = JobInfo.Builder(
            jobIdFor(otp),
            ComponentName(context, ForwardJobService::class.java),
        )
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setOverrideDeadline(OVERRIDE_DEADLINE_MS)
            .setBackoffCriteria(INITIAL_BACKOFF_MS, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
            .setExtras(extras)
            .build()

        runCatching { scheduler.schedule(jobInfo) }
            .onFailure { Log.e(TAG, "schedule failed", it) }
    }

    private fun jobIdFor(otp: String): Int =
        Math.floorMod(otp.hashCode(), Int.MAX_VALUE) + 1
}
