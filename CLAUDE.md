# Kiks (repo: kicksnap)

Camera-first ephemeral messaging. Self-hosted server, web PWA, native Flutter app.

## Layout

- `backend/`: FastAPI + SQLite. API under `/api/v1` (`backend/app/api.py`), schema/migrations in `db.py`.
  Tests: `cd backend && pip install -r requirements-dev.txt && python -m pytest`.
- `frontend/`: React + Vite PWA. `npm run build` type-checks. E2E code in `src/crypto.ts`, `src/e2e.ts`.
- `app/`: Flutter app (Android now, iOS later), package `kiks`, app ID `com.getkiks.app`. See `app/README.md`.
- `docs/e2e.md` + `docs/e2e-vectors.json`: the E2E protocol both clients implement.
- `.github/workflows/ci.yml` (backend, frontend, image) `android.yml` (APK) and `ios.yml` (unsigned iOS compile on macOS).

## Rules

- Work and commit directly on `main` until beta (owner's call). Other sessions push there too: `git pull --rebase`
  before pushing, and keep CI green.
- Protocol changes touch `docs/e2e.md`, `frontend/src/e2e.ts` and `app/lib/e2e.dart` in the same commit.
  Regenerate vectors if primitives change; `app/test/crypto_test.dart` checks them.
- API: additive only on `/api/v1`. Native clients send `X-Kiks-Auth: bearer` on sign-in, then
  `Authorization: Bearer <token>`.
- QR prefixes: `kiks:` (friend), `kiks-link:` (link a device), `kiks-group:` (join group).
- UI text: short, lowercase, friendly. Keep the app's screens matching the PWA's.

## App specifics

- Flutter 3.47.7. The Android SDK can't be downloaded in the cloud sandbox (dl.google.com blocked), so only
  `flutter analyze` and `flutter test` run locally; the APK is built by the `android` workflow.
- Interop test: run the backend on :8765 and `KIKS_TEST_SERVER=http://127.0.0.1:8765 flutter test`.
- Default server `https://snap.getkiks.com` (`Store.defaultServer`, overridable with `--dart-define=KIKS_SERVER`).
  Users switch on the welcome screen's server pill; signed-in users sign out first.
- Signing: `android/app/kiks-dev.keystore` (public, test builds only) unless `android/key.properties` exists
  (CI writes it from `KIKS_KEYSTORE_*` secrets).
- iOS: bundle id `com.getkiks.app`, iOS 15+. No Mac in the sandbox: CI's `ios` job is the only iOS compile check.
  Signing/TestFlight happen on Kim's Mac (steps in `app/README.md`).
- Passkeys: Android via Credential Manager (`kiks/passkey` channel in `MainActivity.kt`, `lib/passkey.dart`). The
  server accepts `android:apk-key-hash:` origins from `ANDROID_CERTS` and serves `/.well-known/assetlinks.json`.
  iOS passkeys not done (needs the paid account + Associated Domains).
- No push yet (needs Firebase/APNs, see `app/README.md`). Admin stays web-only.
