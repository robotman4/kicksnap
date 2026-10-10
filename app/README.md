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

The app starts on the public server `https://snap.getkiks.com`. People on a self-hosted server tap the server
name at the top of the welcome screen and type theirs (it's checked against `/api/v1/health`). Once signed in,
switching servers means signing out first (your face → sign out). To ship a build with a different default, set
the repo variable `KIKS_SERVER` (Settings → Secrets and variables → Actions → Variables), e.g.
`https://kiks.example.com`.

Sign in: "I've got an account" shows a QR, and on Android a "use my passkey" button (see Passkeys below). On a device that's already signed in (web or app): tap your face →
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

## iPhone (on the Mac)

The same code builds for iOS; CI (workflow **ios**) compiles it unsigned on every push, so a red **ios** run
means something broke for iPhone. Tested on a real iPhone (iOS 26): snaps go both ways with Android.

What the Apple account gets you:

| | free Apple ID | paid developer account ($99/year) |
|---|---|---|
| Run on your own iPhone | yes, re-install every 7 days | yes, 1 year |
| TestFlight / App Store | no | yes |
| Push notifications (APNs) | no | yes |

One-time setup:

```bash
# Xcode from the App Store first, open it once, accept the license, install the iOS platform it offers
sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -runFirstLaunch
brew install --cask flutter                # check: flutter --version shows 3.47.x
brew install cocoapods                     # only used if a plugin isn't on Swift Package Manager yet
flutter doctor                             # Xcode section should be green
git clone https://github.com/robotman4/kicksnap && cd kicksnap/app
flutter pub get
open ios/Runner.xcworkspace
```

In Xcode: click **Runner** (top of the left panel) → target **Runner** → **Signing & Capabilities** →
tick *Automatically manage signing* → **Team**: add your Apple ID (Xcode → Settings → Accounts) and pick it.
With a free Apple ID the bundle id `com.getkiks.app` may already be taken by another free team; if Xcode says so,
change it locally to e.g. `com.getkiks.app.kim` (don't commit that).

On the iPhone: plug it in, trust the Mac, then Settings → Privacy & Security → **Developer Mode** on (it restarts).

```bash
flutter run --release                                  # builds, installs and starts it on the plugged-in phone
flutter run --release --dart-define=KIKS_SERVER=https://kiks.example.com   # start on your own server
```

There's no `.ipa` to download: an iPhone only installs apps signed for it, so the build has to come from your
Mac (or TestFlight). Free iPhone builds have no passkeys (sign in by scanning the QR from another device).

First start: General → VPN & Device Management → trust your developer certificate, then open Kiks again.

TestFlight (paid account): App Store Connect → My Apps → + → new app, bundle id `com.getkiks.app`. Then
`flutter build ipa --build-number=<n>` and upload `build/ios/ipa/*.ipa` with the Transporter app. Export
compliance: the app uses standard encryption (end-to-end messaging), which needs no separate documentation.

Known iOS gaps to check on the first run: videos recorded by Chrome on Android with the web app (WebM) don't
play on iPhone (the native apps record MP4, which plays everywhere); screenshots can't be blocked on iOS.

## Passkeys

Android: sign in with a passkey ("I've got an account" → use my passkey) and add one (your face → add a
passkey). Same passkeys as the web app on that server, through Android's Credential Manager (Google Password
Manager or whatever passkey provider the phone uses). Like on the web, a passkey sign-in doesn't bring your
encryption keys: the phone then asks one of your other devices for them.

It works on any Kiks server because the server tells Android it trusts the app: it serves
`/.well-known/assetlinks.json` naming `com.getkiks.app` and the signing key's SHA-256 (server env
`ANDROID_APP_ID`, `ANDROID_CERTS`). The server has to be at the root of its domain, and `RP_ID` (if set) has to
be that domain.

**Before real users:** `ANDROID_CERTS` defaults to the public dev key that test builds are signed with. Anyone
can sign an app with that key, so once there's a release key, set `ANDROID_CERTS` on the server to its
fingerprint only (`keytool -list -v -keystore kiks-release.jks | grep SHA256`).

iPhone: the code is in (`AppDelegate.swift`, same `kiks/passkey` channel), but iOS only allows passkeys for
domains compiled into the app, which needs the paid Apple account. Free builds show a note instead of the button.
To turn it on:

1. Xcode → Runner → **Signing & Capabilities** → **+ Capability** → **Associated Domains** → add
   `webcredentials:snap.robotman4.se` (one line per server; `webcredentials:snap.getkiks.com` for the public one).
   While testing, `webcredentials:snap.robotman4.se?mode=developer` skips Apple's cache (iPhone in Developer Mode).
2. Server: `IOS_APP_IDS=<TEAMID>.com.getkiks.app` (Team ID from developer.apple.com → Membership). Check
   `https://<server>/.well-known/apple-app-site-association` returns JSON.
3. Build with `--dart-define=KIKS_IOS_PASSKEYS=true` (`flutter run --release ...` or `flutter build ipa ...`).

Self-hosted servers not in that list can't use passkeys on iPhone; QR linking always works.

## Not in the app (use the web app)

The admin view, saving a snap to the gallery, and passkeys on free iPhone builds (above).
