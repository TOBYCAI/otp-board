package com.example.otpforward

import android.animation.ValueAnimator
import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat
import kotlin.math.cos
import kotlin.math.sin

class AmbientGlowView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : View(context, attrs, defStyleAttr) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var phase = 0f
    private var animator: ValueAnimator? = null

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (width == 0 || height == 0) return

        val darkMode = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES
        val alpha = if (darkMode) 0.34f else 0.19f
        val radius = width.coerceAtLeast(height) * 0.62f

        drawGlow(
            canvas,
            width * (0.82f + 0.08f * cos(phase * Math.PI * 2).toFloat()),
            height * (0.08f + 0.04f * sin(phase * Math.PI * 2).toFloat()),
            radius,
            withAlpha(ContextCompat.getColor(context, R.color.glow_cyan), alpha),
        )
        drawGlow(
            canvas,
            width * (0.12f + 0.07f * sin(phase * Math.PI * 2).toFloat()),
            height * (0.62f + 0.05f * cos(phase * Math.PI * 2).toFloat()),
            radius * 0.82f,
            withAlpha(ContextCompat.getColor(context, R.color.glow_violet), alpha * 0.72f),
        )
    }

    private fun drawGlow(canvas: Canvas, x: Float, y: Float, radius: Float, color: Int) {
        paint.shader = RadialGradient(
            x,
            y,
            radius,
            intArrayOf(color, Color.TRANSPARENT),
            floatArrayOf(0f, 1f),
            Shader.TileMode.CLAMP,
        )
        canvas.drawCircle(x, y, radius, paint)
        paint.shader = null
    }

    private fun withAlpha(color: Int, alpha: Float): Int =
        Color.argb((255 * alpha).toInt(), Color.red(color), Color.green(color), Color.blue(color))

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!ValueAnimator.areAnimatorsEnabled()) return
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 14000L
            repeatCount = ValueAnimator.INFINITE
            addUpdateListener {
                phase = it.animatedValue as Float
                postInvalidateOnAnimation()
            }
            start()
        }
    }

    override fun onDetachedFromWindow() {
        animator?.cancel()
        animator = null
        super.onDetachedFromWindow()
    }
}
