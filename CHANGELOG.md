# Changelog

Versions follow [semver](https://semver.org). Release images: `ghcr.io/robotman4/kicksnap:<version>`.

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
- Test suite and CI (tests, frontend build, image smoke test; version tags publish to GHCR).
- AGPL-3.0.
