package com.getkiks.app

import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // While a snap is open: no screenshots, no screen recording, blank in the app switcher.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "kiks/secure").setMethodCallHandler { call, result ->
            when (call.method) {
                "on" -> window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                "off" -> window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                else -> return@setMethodCallHandler result.notImplemented()
            }
            result.success(null)
        }
    }
}
