# Kiks for Android and iPhone (Flutter)

The native app. Same server, same accounts and the same end-to-end encryption as the web app
([docs/e2e.md](../docs/e2e.md)), so a phone running this app and a browser running the PWA talk to each other.

App ID: `com.getkiks.app` (Android `applicationId`, iOS bundle id). Changing it later makes it a different app:
people have to reinstall and link the device again. Change it before anything goes to a store.

## Install a test build on Android

Every push to `main` that touches `app/`, `backend/` or the E2E spec builds a release APK in GitHub Actions
(workflow **android**):

- **Phone:** open `https://github.com/robotman4/kicksnap/releases/tag/android-latest`, download `kiks.apk`,
  open it and allow installs from the browser when Android asks. Newer builds install over older ones.
- **Any run:** Actions → android → the run → artifact `kiks-android-<n>` (a zip with the APK).

First start asks for your server (`kiks.example.com`). Set the repo variable `KIKS_SERVER`
(Settings → Secrets and variables → Actions → Variables) to bake a default in.

Sign in: "I've got an account" shows a QR. On a device that's already signed in (web or app): tap your face →
add a device → scan it. That also moves your encryption keys, so the new phone can open snaps right away.

## Develop

Needs Flutter 3.47 (`flutter --version`), Android Studio or the Android command-line tools, and JDK 17.

```bash
cd app
flutter pub get
flutter run                                    # phone on USB with USB debugging on
flutter run --dart-define=KIKS_SERVER=https://kiks.example.com
flutter analyze && flutter test                # crypto against docs/e2e-vectors.json
flutter build apk --release                    # build/app/outputs/flutter-apk/app-release.apk
```

Against a local server from a phone on the same Wi-Fi: run the backend on `0.0.0.0:8000` and type
`http://<your-pc-ip>:8000` as the server (plain `http://` is allowed for this; use HTTPS for anything real).

The interop test runs the Dart client against a real backend (CI does this on every build):

```bash
(cd ../backend && DATA_DIR=$(mktemp -d) uvicorn app.main:app --port 8765) &
KIKS_TEST_SERVER=http://127.0.0.1:8765 flutter test
```

### Layout

| | |
|---|---|
| `lib/crypto.dart` | E2E primitives (X25519, Ed25519, HKDF, AES-GCM), byte-for-byte the web's `crypto.ts` |
| `lib/e2e.dart` | keys on this device, device list, sealing/opening snaps and texts, linking; port of `e2e.ts` |
| `lib/api.dart` | `/api/v1` client, bearer token, live socket |
| `lib/store.dart` | token and keys in Keystore/Keychain (`flutter_secure_storage`), prefs |
| `lib/screens/` | one file per screen, named like the PWA's (`Camera`, `Preview`, `Chats`, `Viewer`...) |
| `test/` | `crypto_test.dart` (vectors), `interop_test.dart` (real server) |

## Signing

- Without anything set up, builds are signed with the **dev key** checked in at `android/app/kiks-dev.keystore`
  (password `kiks-dev`). It's public on purpose: it only exists so test builds update each other.
- For a real release key (Play Store, or before handing the APK to people outside testing):

  ```bash
  keytool -genkeypair -v -keystore kiks-release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias kiks
  base64 -w0 kiks-release.jks   # -> secret KIKS_KEYSTORE_B64
  ```

  Add repo secrets `KIKS_KEYSTORE_B64`, `KIKS_KEYSTORE_PASSWORD`, `KIKS_KEY_ALIAS`, `KIKS_KEY_PASSWORD`. CI then
  signs with it. Keep the `.jks` and passwords backed up: Play needs the same key for every update. Moving from
  the dev key to the release key needs one uninstall/reinstall (and linking the phone again).
  Locally: put the same four values in `android/key.properties` (`storeFile=...`, gitignored).

## Push notifications: not yet

The app has no push yet. While it's open it gets live updates over the socket and refreshes when you come back
to it. The web app's Web Push doesn't work for native apps, they need Google's FCM and Apple's APNs.

What it takes (plan section 1, "Push: the real cost"):

1. **You:** a Firebase project (free) at console.firebase.google.com → add an Android app with package
   `com.getkiks.app` → download `google-services.json`. Then Project settings → Service accounts → generate a
   private key (JSON) for the server. iOS additionally needs the paid Apple account and an APNs key (`.p8`)
   uploaded to the same Firebase project.
2. **Code:** `firebase_messaging` in the app, a `push_tokens` table and an FCM sender in the backend (or a small
   push gateway, so self-hosted servers can push to the store app without holding its keys).

Send me the go-ahead plus the two Firebase files (out of git) and I'll wire it up. UnifiedPush (ntfy) for
de-Googled phones can come after.

## iPhone (later, on the Mac)

The code already builds for iOS; it hasn't been run on a device yet. On the Mac:

```bash
brew install --cask flutter        # or the SDK zip from flutter.dev, version 3.47
xcode-select --install && sudo xcodebuild -runFirstLaunch   # Xcode from the App Store first
brew install cocoapods
cd app && flutter pub get && cd ios && pod install && cd ..
open ios/Runner.xcworkspace
```

In Xcode: Runner target → Signing & Capabilities → Team = your Apple ID (free) or the paid team. With a free
Apple ID the build runs on your own iPhone for 7 days. iPhone: Settings → Privacy & Security → Developer Mode
on, and trust the developer under General → VPN & Device Management. Then `flutter run --release` with the
phone plugged in.

TestFlight (needs the $99/year account): create the app in App Store Connect with bundle id `com.getkiks.app`,
then `flutter build ipa` and upload `build/ios/ipa/*.ipa` with Transporter. Answer the export-compliance
question (the app uses standard encryption for end-to-end messaging).

Known iOS gaps to check on the first run: videos from Android Chrome (WebM) don't play on iPhone (Android app
and iPhone record MP4, which plays everywhere); screenshots can't be blocked on iOS, only on Android.

## Not in the app (use the web app)

Passkeys (bound to the server's domain, which a store app can't declare for every self-hosted server), the
admin view, and saving a snap to the gallery.
