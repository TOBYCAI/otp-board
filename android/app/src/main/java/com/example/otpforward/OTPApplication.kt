package com.example.otpforward

import android.app.Application
import androidx.appcompat.app.AppCompatDelegate
import com.google.android.material.color.DynamicColors

class OTPApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Enable Material You Dynamic Colors
        DynamicColors.applyToActivitiesIfAvailable(this)

        // Load saved theme preference
        val prefs = getSharedPreferences("cfg", MODE_PRIVATE)
        val mode = prefs.getInt("theme_mode", AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)
        AppCompatDelegate.setDefaultNightMode(mode)
    }
}
