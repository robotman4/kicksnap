package com.getkiks.app

import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executor

class MainActivity : FlutterActivity() {
    private val main = Executor { Handler(Looper.getMainLooper()).post(it) }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger

        // While a snap is open: no screenshots, no screen recording, blank in the app switcher.
        MethodChannel(messenger, "kiks/secure").setMethodCallHandler { call, result ->
            when (call.method) {
                "on" -> window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                "off" -> window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                else -> return@setMethodCallHandler result.notImplemented()
            }
            result.success(null)
        }

        // Passkeys through Android's Credential Manager. Takes the server's WebAuthn options JSON and
        // hands back the credential JSON exactly as a browser would send it.
        MethodChannel(messenger, "kiks/passkey").setMethodCallHandler { call, result ->
            val json = call.arguments as? String ?: return@setMethodCallHandler result.error("bad", "no options", null)
            val cm = CredentialManager.create(this)
            when (call.method) {
                "create" -> cm.createCredentialAsync(
                    this, CreatePublicKeyCredentialRequest(json), null, main,
                    object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
                        override fun onResult(r: CreateCredentialResponse) {
                            result.success((r as CreatePublicKeyCredentialResponse).registrationResponseJson)
                        }
                        override fun onError(e: CreateCredentialException) {
                            result.error(if (e is CreateCredentialCancellationException) "cancelled" else "failed", e.errorMessage?.toString() ?: e.type, null)
                        }
                    },
                )
                "get" -> cm.getCredentialAsync(
                    this, GetCredentialRequest(listOf(GetPublicKeyCredentialOption(json))), null, main,
                    object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                        override fun onResult(r: GetCredentialResponse) {
                            val c = r.credential
                            if (c is PublicKeyCredential) result.success(c.authenticationResponseJson)
                            else result.error("failed", "not a passkey", null)
                        }
                        override fun onError(e: GetCredentialException) {
                            val code = when (e) {
                                is GetCredentialCancellationException -> "cancelled"
                                is NoCredentialException -> "none"
                                else -> "failed"
                            }
                            result.error(code, e.errorMessage?.toString() ?: e.type, null)
                        }
                    },
                )
                else -> result.notImplemented()
            }
        }
    }
}
