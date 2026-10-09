# Changelog

Versions follow [semver](https://semver.org). Release images: `ghcr.io/robotman4/kiks:<version>` (`ghcr.io/robotman4/kicksnap` up to 1.0.0-beta.1).

## Unreleased

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
