import AuthenticationServices
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "KiksPasskeys") {
      Passkeys.register(with: registrar)
    }
  }
}

/// Passkeys through AuthenticationServices: takes the server's WebAuthn options JSON and hands back the
/// credential JSON a browser would send (same "kiks/passkey" channel as Android's MainActivity.kt).
/// Only works for domains in the app's Associated Domains (webcredentials:...), which needs the paid
/// Apple account; the Dart side only offers it in builds made with --dart-define=KIKS_IOS_PASSKEYS=true.
class Passkeys: NSObject, FlutterPlugin, ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding
{
  private var pending: FlutterResult?

  static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(name: "kiks/passkey", binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(Passkeys(), channel: channel)
  }

  func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    guard let text = call.arguments as? String, let data = text.data(using: .utf8),
      let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let challenge = b64(o["challenge"] as? String)
    else {
      return result(FlutterError(code: "bad", message: "bad options", details: nil))
    }
    if pending != nil {
      return result(FlutterError(code: "failed", message: "busy", details: nil))
    }
    let request: ASAuthorizationRequest
    switch call.method {
    case "create":
      guard let rp = (o["rp"] as? [String: Any])?["id"] as? String,
        let user = o["user"] as? [String: Any], let name = user["name"] as? String,
        let uid = b64(user["id"] as? String)
      else { return result(FlutterError(code: "bad", message: "bad options", details: nil)) }
      request = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rp)
        .createCredentialRegistrationRequest(challenge: challenge, name: name, userID: uid)
    case "get":
      guard let rp = o["rpId"] as? String else {
        return result(FlutterError(code: "bad", message: "bad options", details: nil))
      }
      let r = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rp)
        .createCredentialAssertionRequest(challenge: challenge)
      r.allowedCredentials = ((o["allowCredentials"] as? [[String: Any]]) ?? []).compactMap {
        b64($0["id"] as? String).map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
      }
      request = r
    default:
      return result(FlutterMethodNotImplemented)
    }
    pending = result
    let controller = ASAuthorizationController(authorizationRequests: [request])
    controller.delegate = self
    controller.presentationContextProvider = self
    controller.performRequests()
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }.first { $0.isKeyWindow } ?? ASPresentationAnchor()
  }

  func authorizationController(
    controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    var out: [String: Any]?
    if let c = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
      var response: [String: Any] = ["clientDataJSON": b64u(c.rawClientDataJSON)]
      if let a = c.rawAttestationObject { response["attestationObject"] = b64u(a) }
      response["transports"] = ["internal", "hybrid"]
      out = credential(c.credentialID, response)
    } else if let c = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
      out = credential(c.credentialID, [
        "clientDataJSON": b64u(c.rawClientDataJSON),
        "authenticatorData": b64u(c.rawAuthenticatorData),
        "signature": b64u(c.signature),
        "userHandle": b64u(c.userID),
      ])
    }
    if let out = out, let data = try? JSONSerialization.data(withJSONObject: out),
      let s = String(data: data, encoding: .utf8)
    {
      finish(s)
    } else {
      finish(FlutterError(code: "failed", message: "not a passkey", details: nil))
    }
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    let code = (error as? ASAuthorizationError)?.code == .canceled ? "cancelled" : "failed"
    finish(FlutterError(code: code, message: error.localizedDescription, details: nil))
  }

  private func finish(_ value: Any?) {
    pending?(value)
    pending = nil
  }

  private func credential(_ id: Data, _ response: [String: Any]) -> [String: Any] {
    [
      "id": b64u(id), "rawId": b64u(id), "type": "public-key", "response": response,
      "authenticatorAttachment": "platform", "clientExtensionResults": [String: Any](),
    ]
  }

  private func b64u(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  private func b64(_ s: String?) -> Data? {
    guard var t = s?.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") else {
      return nil
    }
    while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)
  }
}
