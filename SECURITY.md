# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub:
**Security → Report a vulnerability** on https://github.com/robotman4/kicksnap/security/advisories/new.

Include what you found, how to reproduce it, and what an attacker could do with it. Once a fix is released, you're credited in the advisory unless you'd rather not be.

## Supported versions

Only the latest release and the `main` branch get security fixes.

## In scope

- The Kiks server (`backend/`) and web app (`frontend/`): auth, device linking, passkeys, bearer tokens,
  access to snaps, texts and groups, admin endpoints, media handling, rate limits.
- The end-to-end encryption protocol ([docs/e2e.md](docs/e2e.md)) and its implementations.
- The container image and `compose.yml` defaults.

## Out of scope

- Instances run by other people. Contact that instance's operator.
- Your reverse proxy, TLS setup or host.
- Denial of service by flooding a server with traffic.

## Things worth knowing

- Snaps and texts are end-to-end encrypted ([docs/e2e.md](docs/e2e.md)). The server sees metadata (who, when,
  photo/video, sizes) but not content. The web app is served by the server it talks to, so a malicious operator
  could serve a modified app; that's the limit of E2E in any web app.
- Device secrets are stored only as SHA-256 hashes. A leaked database doesn't give working sign-ins.
