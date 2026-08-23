package com.example.otpforward

import com.example.otpforward.core.ServerConfig

import android.Manifest
import android.animation.ArgbEvaluator
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.DialogInterface
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.animation.DecelerateInterpolator
import android.view.animation.LinearInterpolator
import android.widget.*
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.core.view.GravityCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.drawerlayout.widget.DrawerLayout
import com.google.android.material.card.MaterialCardView
import com.google.android.material.color.MaterialColors
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.navigation.NavigationView
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.google.android.material.textfield.TextInputLayout
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.*

class MainActivity : AppCompatActivity() {
    private lateinit var tvUrl: TextView
    private lateinit var tvToken: TextView
    private lateinit var tvStatus: TextView
    private lateinit var progressTest: LinearProgressIndicator
    private lateinit var cardStatus: MaterialCardView
    private lateinit var btnSms: Button
    private lateinit var btnNotify: Button
    private lateinit var btnTest: Button
    private lateinit var statusGlow: View
    private var glowAnimator: AnimatorSet? = null
    private var testAnimator: ObjectAnimator? = null

    private val scanLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (it.resultCode == RESULT_OK) updateUrl()
    }

    override fun onCreate(b: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(b)
        window.isNavigationBarContrastEnforced = false
        setContentView(R.layout.activity_main)

        val headerLayout: View = findViewById(R.id.header_layout)
        val mainScroll: View = findViewById(R.id.main_scroll)
        val navView: NavigationView = findViewById(R.id.nav_view)

        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.drawer_layout)) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            headerLayout.setPadding(headerLayout.paddingLeft, bars.top, headerLayout.paddingRight, headerLayout.paddingBottom)
            mainScroll.setPadding(mainScroll.paddingLeft, mainScroll.paddingTop, mainScroll.paddingRight, bars.bottom)
            navView.setPadding(navView.paddingLeft, bars.top, navView.paddingRight, bars.bottom)
            insets
        }

        tvUrl = findViewById(R.id.tv_server_url)
        tvToken = findViewById(R.id.tv_server_token)
        tvStatus = findViewById(R.id.tv_status)
        progressTest = findViewById(R.id.progress_test)
        cardStatus = findViewById(R.id.card_status)
        btnSms = findViewById(R.id.btn_sms_permission)
        btnNotify = findViewById(R.id.btn_notification_access)
        btnTest = findViewById(R.id.btn_test)
        statusGlow = findViewById(R.id.status_glow)

        val drawerLayout: DrawerLayout = findViewById(R.id.drawer_layout)
        findViewById<View>(R.id.btn_open_drawer).setOnClickListener {
            drawerLayout.openDrawer(GravityCompat.START)
        }

        navView.setNavigationItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_server_settings -> {
                    showServers()
                    drawerLayout.closeDrawers()
                }
                R.id.nav_dark_mode -> {
                    showThemeDialog()
                    drawerLayout.closeDrawers()
                }
            }
            true
        }

        updateThemeIcon(navView.menu.findItem(R.id.nav_dark_mode))

        btnTest.setOnClickListener { it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY); testConn() }
        findViewById<Button>(R.id.btn_scan).setOnClickListener { it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY); scan() }

        btnSms.setOnClickListener { it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY); reqSms() }
        btnNotify.setOnClickListener {
            it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            Toast.makeText(this, getString(R.string.toast_notification_access), Toast.LENGTH_LONG).show()
        }

        updateUrl(); checkPerm()

        startEntranceAnimations()

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(enabled = true) {
                override fun handleOnBackPressed() {
                    val drawerLayout: DrawerLayout = findViewById(R.id.drawer_layout)
                    if (drawerLayout.isDrawerOpen(GravityCompat.START)) {
                        drawerLayout.closeDrawer(GravityCompat.START)
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            },
        )
    }

    private fun showThemeDialog() {
        val modes = arrayOf(
            getString(R.string.theme_follow_system),
            getString(R.string.theme_light),
            getString(R.string.theme_dark),
        )
        val modeValues = intArrayOf(
            AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM,
            AppCompatDelegate.MODE_NIGHT_NO,
            AppCompatDelegate.MODE_NIGHT_YES,
        )
        val currentMode = getSharedPreferences("cfg", MODE_PRIVATE).getInt("theme_mode", AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)
        val checkedItem = modeValues.indexOf(currentMode).coerceAtLeast(0)

        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.theme_dialog_title)
            .setSingleChoiceItems(modes, checkedItem) { dialog, which ->
                val newMode = modeValues[which]
                getSharedPreferences("cfg", MODE_PRIVATE).edit { putInt("theme_mode", newMode) }
                AppCompatDelegate.setDefaultNightMode(newMode)
                dialog.dismiss()
                recreate()
            }
            .show()
    }

    private fun updateThemeIcon(item: android.view.MenuItem) {
        val isDark = when (AppCompatDelegate.getDefaultNightMode()) {
            AppCompatDelegate.MODE_NIGHT_YES -> true
            AppCompatDelegate.MODE_NIGHT_NO -> false
            else -> (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
        }
        item.setIcon(if (isDark) R.drawable.ic_moon else R.drawable.ic_sun)
        val color = MaterialColors.getColor(this, androidx.appcompat.R.attr.colorPrimary, 0)
        item.icon?.setTint(color)
    }

    private fun showServers() {
        val saved = ServerConfig.getList(this)
        if (saved.isEmpty()) {
            MaterialAlertDialogBuilder(this)
                .setTitle(R.string.server_select_title)
                .setMessage(R.string.server_empty_message)
                .setPositiveButton(R.string.server_add) { _, _ -> inputUrl() }
                .setNegativeButton(R.string.server_cancel, null)
                .show()
            return
        }

        val checkedItem = saved.indexOf(ServerConfig.getUrl(this))
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.server_select_title)
            .setSingleChoiceItems(saved.toTypedArray(), checkedItem) { dialog, which ->
                ServerConfig.setUrl(this, saved[which])
                updateUrl()
                Toast.makeText(this, R.string.server_switched, Toast.LENGTH_SHORT).show()
                dialog.dismiss()
            }
            .setPositiveButton(R.string.server_add) { _, _ -> inputUrl() }
            .setNeutralButton(R.string.server_manage) { _, _ -> manageSaved() }
            .setNegativeButton(R.string.server_cancel, null)
            .show()
    }

    private fun inputUrl() {
        val view = layoutInflater.inflate(R.layout.dialog_server_edit, null)
        val urlLayout: TextInputLayout = view.findViewById(R.id.layout_server_url)
        val etUrl: EditText = view.findViewById(R.id.input_server_url)
        val etToken: EditText = view.findViewById(R.id.input_server_token)
        etUrl.setText(ServerConfig.getUrl(this))
        etToken.setText(ServerConfig.getToken(this))

        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.server_edit_title)
            .setView(view)
            .setPositiveButton(R.string.server_save, null)
            .setNegativeButton(R.string.server_cancel, null)
            .create()

        dialog.setOnShowListener {
            dialog.getButton(DialogInterface.BUTTON_POSITIVE).setOnClickListener {
                val u = etUrl.text.toString().trim()
                val t = etToken.text.toString().trim()
                if (u.toHttpUrlOrNull()?.isHttps != true) {
                    urlLayout.error = getString(R.string.server_url_required)
                    etUrl.requestFocus()
                    return@setOnClickListener
                }
                urlLayout.error = null
                ServerConfig.setUrl(this, u)
                ServerConfig.setToken(this, t)
                ServerConfig.add(this, u)
                updateUrl()
                dialog.dismiss()
            }
        }
        dialog.show()
    }

    private fun manageSaved() {
        val l = ServerConfig.getList(this)
        if (l.isEmpty()) {
            MaterialAlertDialogBuilder(this)
                .setTitle(R.string.server_manage)
                .setMessage(R.string.server_empty_message)
                .setPositiveButton(R.string.server_add) { _, _ -> inputUrl() }
                .setNegativeButton(R.string.server_cancel, null)
                .show()
            return
        }
        MaterialAlertDialogBuilder(this).setTitle(R.string.server_manage)
            .setItems(l.toTypedArray()) { _, i ->
                MaterialAlertDialogBuilder(this).setMessage(l[i])
                    .setPositiveButton(R.string.server_use) { _, _ ->
                        ServerConfig.setUrl(this, l[i])
                        updateUrl()
                    }
                    .setNegativeButton(R.string.server_delete) { _, _ ->
                        ServerConfig.remove(this, l[i])
                        Toast.makeText(this, R.string.server_deleted, Toast.LENGTH_SHORT).show()
                    }
                    .show()
            }
            .setNegativeButton(R.string.server_cancel, null)
            .show()
    }

    private fun testConn() {
        tvStatus.text = getString(R.string.status_testing)
        tvStatus.setTextColor(ContextCompat.getColor(this, R.color.status_accent))
        tvStatus.visibility = View.VISIBLE
        progressTest.visibility = View.VISIBLE
        btnTest.isEnabled = false

        testAnimator = ObjectAnimator.ofFloat(btnTest, "rotation", 0f, 360f).apply {
            duration = 1000
            repeatCount = ValueAnimator.INFINITE
            interpolator = LinearInterpolator()
            start()
        }

        val t = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        val token = ServerConfig.getToken(this)
        val json = if (token.isEmpty()) {
            """{"otp":"test","source":"Test","platform":"AndroidApp","time":"$t"}"""
        } else {
            """{"otp":"test","token":"$token","source":"Test","platform":"AndroidApp","time":"$t"}"""
        }
        val req = try {
            Request.Builder().url(ServerConfig.getUrl(this))
                .post(json.toRequestBody("application/json".toMediaType()))
                .build()
        } catch (_: IllegalArgumentException) {
            progressTest.visibility = View.GONE
            btnTest.isEnabled = true
            testAnimator?.cancel()
            btnTest.rotation = 0f
            tvStatus.text = getString(R.string.status_invalid_url)
            tvStatus.setTextColor(MaterialColors.getColor(this, androidx.appcompat.R.attr.colorError, 0))
            return
        }
        OkHttpClient().newCall(req).enqueue(
            object : Callback {
                override fun onFailure(call: Call, e: IOException) = runOnUiThread {
                    progressTest.visibility = View.GONE
                    btnTest.isEnabled = true
                    testAnimator?.cancel()
                    btnTest.rotation = 0f
                    tvStatus.text = getString(R.string.status_failed, e.message)
                    tvStatus.setTextColor(MaterialColors.getColor(this@MainActivity, androidx.appcompat.R.attr.colorError, 0))
                }

                override fun onResponse(call: Call, response: Response) = runOnUiThread {
                    progressTest.visibility = View.GONE
                    btnTest.isEnabled = true
                    testAnimator?.cancel()
                    btnTest.animate().rotation(0f).setDuration(300).start()

                    val errorColor = MaterialColors.getColor(this@MainActivity, androidx.appcompat.R.attr.colorError, 0)
                    when (response.code) {
                        200 -> {
                            tvStatus.text = getString(R.string.status_success)
                            tvStatus.setTextColor(ContextCompat.getColor(this@MainActivity, R.color.status_accent))
                            animateCardSuccess()
                        }
                        403 -> {
                            tvStatus.text = getString(R.string.status_token_error)
                            tvStatus.setTextColor(errorColor)
                        }
                        429 -> {
                            tvStatus.text = getString(R.string.status_too_many_requests)
                            tvStatus.setTextColor(errorColor)
                        }
                        else -> {
                            tvStatus.text = getString(R.string.status_http_error, response.code)
                            tvStatus.setTextColor(errorColor)
                        }
                    }
                    response.close()
                }
            }
        )
    }

    private fun animateCardSuccess() {
        if (!ValueAnimator.areAnimatorsEnabled()) return
        val colorFrom = cardStatus.cardBackgroundColor.defaultColor
        val colorTo = MaterialColors.getColor(this, com.google.android.material.R.attr.colorPrimaryContainer, 0)

        ValueAnimator.ofObject(ArgbEvaluator(), colorFrom, colorTo, colorFrom).apply {
            duration = 1000
            addUpdateListener { cardStatus.setCardBackgroundColor(it.animatedValue as Int) }
            start()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            cardStatus.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        } else {
            cardStatus.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        }
    }

    private fun scan() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), 101)
            return
        }
        scanLauncher.launch(Intent(this, ScanActivity::class.java))
    }

    private fun reqSms() =
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS), 100)

    private fun checkPerm() {
        val sg = ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        btnSms.text = getString(if (sg) R.string.perm_sms_granted else R.string.perm_sms_request)
        btnSms.isEnabled = !sg
        val nl = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")?.contains(packageName) == true
        btnNotify.text = getString(if (nl) R.string.perm_notify_granted else R.string.perm_notify_request)
        btnNotify.isEnabled = !nl
    }

    override fun onResume() {
        super.onResume()
        checkPerm()
        startStatusGlow()
    }

    override fun onPause() {
        glowAnimator?.cancel()
        glowAnimator = null
        super.onPause()
    }

    private fun updateUrl() {
        val url = ServerConfig.getUrl(this)
        tvUrl.text = url.ifEmpty { getString(R.string.server_not_set) }
        val token = ServerConfig.getToken(this)
        tvToken.text = getString(if (token.isEmpty()) R.string.token_not_set else R.string.token_set)
    }

    private fun startEntranceAnimations() {
        if (!ValueAnimator.areAnimatorsEnabled()) return
        val views = listOf(
            findViewById<View>(R.id.hero_layout),
            cardStatus,
            findViewById(R.id.actions_title),
            btnSms,
            btnNotify,
            findViewById(R.id.btn_scan),
        )
        views.forEachIndexed { index, view ->
            view.alpha = 0f
            view.translationY = resources.displayMetrics.density * 18f
            view.animate()
                .alpha(1f)
                .translationY(0f)
                .setStartDelay(50L + index * 65L)
                .setDuration(480L)
                .setInterpolator(DecelerateInterpolator(1.8f))
                .start()
        }
    }

    private fun startStatusGlow() {
        if (!ValueAnimator.areAnimatorsEnabled() || glowAnimator != null) return
        val alpha = ObjectAnimator.ofFloat(statusGlow, View.ALPHA, 0.35f, 0.92f, 0.35f).apply {
            duration = 2600L
            repeatCount = ValueAnimator.INFINITE
        }
        val scaleX = ObjectAnimator.ofFloat(statusGlow, View.SCALE_X, 0.86f, 1.08f, 0.86f).apply {
            duration = 2600L
            repeatCount = ValueAnimator.INFINITE
        }
        val scaleY = ObjectAnimator.ofFloat(statusGlow, View.SCALE_Y, 0.86f, 1.08f, 0.86f).apply {
            duration = 2600L
            repeatCount = ValueAnimator.INFINITE
        }
        glowAnimator = AnimatorSet().apply {
            playTogether(alpha, scaleX, scaleY)
            start()
        }
    }
}
