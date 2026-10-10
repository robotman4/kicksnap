# Changelog

Versions follow [semver](https://semver.org). Release images: `ghcr.io/robotman4/kiks:<version>` (`ghcr.io/robotman4/kicksnap` up to 1.0.0-beta.1).

## Unreleased

- **Upload limits are server settings.** `MAX_VIDEO_SECONDS` (30), `VIDEO_KBPS` (6000) and `DAILY_UPLOAD_MB` (500
  per user per day) join `MAX_UPLOAD_MB` (50). The apps get them from `/me`: the recorder stops at the limit, and a
  gallery pick that's too big or too long says so before sending. The server refuses oversize files and anything
  past the daily total with a clear message.
- **Security fixes before beta.** Report screenshots and snaps can only be photo/video types, and every file the
  server hands out is `nosniff` and sandboxed, so a reported "image" can't run script when an admin opens it.
  Rate limits no longer reset when a request brings a made-up bearer token. A passkey can't overwrite another
  account's. Signing out or removing a device closes its live connection right away. Pages can't be framed.
  Reports from the Android app with a snap or screenshots attached work now (they were refused as "not images").
- **More hardening.** The web app has a Content-Security-Policy. Passkeys and the live connection only accept the
  server's own origin (set `ORIGIN` if your proxy rewrites `Host`). If a friend you'd **verified** gets a new key,
  their snaps and chats stay locked until you tap ok or scan their code again. A snap or text delivered twice is
  refused. Resetting your keys sends a notification to your other devices. Link polling sends its secret in a
  header, not the URL. The app only allows plain http for servers on your own network.

- **Android app** (Flutter, [app/](app/README.md)). Camera-first like the web app: snaps, chats, groups,
  block/report, sign-in by QR from another device. Interoperates with the web app's E2E encryption; CI checks it
  against the real server on every build and publishes an APK to the `android-latest` pre-release. No push
  notifications yet. iOS builds from the same code on a Mac.
- **Passkeys in the Android app**: sign in and add one, same passkeys as the web. The server now serves
  `/.well-known/assetlinks.json` for it. Operators: set `ANDROID_CERTS` to the release key's SHA-256 once there is
  one (the default trusts the public dev key test builds use). `IOS_APP_IDS` turns on
  `apple-app-site-association` for iPhone builds with passkeys (paid Apple account, see app/README.md).

- **Snaps and chats are end-to-end encrypted** ([docs/e2e.md](docs/e2e.md)). Per-device keys, an account identity
  key that signs the device list and travels inside the QR link, "key changed" notices, verify by scanning a
  friend's code, reports with signature-checked proof. The terms page says so.
- Clients from before E2E get "update Kiks" when they send; snaps and chats already on the server stay readable
  until they burn. Each device sets up its keys on first start. A device signed in only with a passkey shows
  "this device can't open snaps yet" until another of your devices approves it (or you make new keys).

- **The app is now called Kiks.** App name, page title, home-screen name, notifications and docs say Kiks.
  "Snap" stays as the verb.

Operators, when upgrading:

- The compose service is now `kiks` (was `kicksnap`): use `docker compose exec kiks ...` and `logs kiks`. Pull the
  new `compose.yml` and run `docker compose up -d --remove-orphans` once, or the old `kicksnap` container keeps
  running and holds the port. Update reverse-proxy targets (`kiks:8000`) and Traefik labels if you copied them.
- Release images move to `ghcr.io/robotman4/kiks`.
- Unchanged, so existing data just works: the `kicksnap-data` volume, `/data/kicksnap.db`, `/data/vapid.pem`, the
  device cookie, env vars and passkeys. Nobody has to sign in again or re-enable push.
- New backups are named `kiks-<time>`; `backup --keep` counts old `kicksnap-<time>` ones too.
- QR codes now read `kiks:...`; old `kicksnap:...` codes still scan. Bearer clients send `X-Kiks-Auth: bearer`
  (`X-Kicksnap-Auth` still works). The username `kiks` is reserved on upgrade unless someone already has it.

## 1.0.0-beta.1

First beta.

- Snaps: full-res photos and up to 10 s video, drawing and text, view timers, burn after viewing or after
  `SNAP_TTL_HOURS`.
- Chats: short text messages, groups with an owner.
- Sign-in without passwords: device secret, QR/code device linking, passkeys.
- Friends by QR or name. Block, delete your own account (name held for a cooldown).
- Reports go to a server admin queue (no email), with proof: pick their texts (single group texts too) and add
  screenshots. Admin view and `python -m app.admin` CLI: suspend with a reason, delete, reserved names, admin log.
- Suspended people see why and can appeal once; admins lift or keep it with a reply.
- Web Push notifications with content-free payloads.
- API under `/api/v1` with `/api` as an alias; bearer token auth for non-browser clients.
- Terms and disclaimer page.
- Operator side: numbered database migrations (`PRAGMA user_version`), `app.admin backup`/`version`,
  `/api/v1/health` reports the version and checks the database, `FORWARDED_ALLOW_IPS` in compose,
  [deploy docs](docs/deploy.md).
- Push notifications go to all of a user's devices in parallel (httpx); a slow or dead push service no longer
  holds up the rest, and expired subscriptions are pruned.
- Unhandled errors are logged with method and path and counted in `/api/v1/health`; `LOG_LEVEL` env var. The
  burn loop logs and keeps going if one round fails.
- Test suite and CI (tests, frontend build, image smoke test; version tags publish to GHCR).
- AGPL-3.0.
