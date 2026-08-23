package com.example.otpforward

import com.example.otpforward.core.ServerConfig

import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

class ScanActivity : AppCompatActivity() {
    private val launcher = registerForActivityResult(ScanContract()) {
        if ((it.contents != null) && (it.contents.startsWith("http://") || it.contents.startsWith("https://"))) {
            ServerConfig.setUrl(this, it.contents)
            ServerConfig.add(this, it.contents)
            Toast.makeText(this, "✅ 已设置", Toast.LENGTH_LONG).show()
            setResult(RESULT_OK)
        } else Toast.makeText(this, "❌ 无效或取消", Toast.LENGTH_SHORT).show()
        finish()
    }
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        val o = ScanOptions()
        o.setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        o.setPrompt("扫描服务器二维码")
        o.setBeepEnabled(false)
        launcher.launch(o)
    }
}
