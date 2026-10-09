# kicksnap

Self-hosted snap app. Open, snap, send. Snaps burn after they're viewed.

## What it feels like

- **Opens on the camera.** Tap the shutter for a photo, hold it for up to 10s of video. Tap to focus, double-tap to flip.
  Photos are full-resolution stills (the whole sensor frame, nothing cropped).
- **Swipe, don't navigate.** Swipe right for chats, left for friends. No menus.
- **Snap, then play.** Draw on it in 9 colours, add text (tap T again for big outlined text), drag it around.
- **Send.** Tap the timer for 3s / 5s / 10s / ∞, hit send, tap faces.
- **Snap back.** Open a snap, hit "snap back", and the next one goes straight to that person.
- **No passwords, ever.** A new device either says "I'm new" (then you pick a name) or "I've got an account".
  Then you either use a passkey, or scan the QR it shows from a phone that's already signed in.
- **Add friends by QR.** Your code is on the friends screen. Scan theirs, or type their name.
- **Notifications.** Push for new snaps and friend requests, even with the app closed. Pull down on chats or friends to refresh.

## Screens

<p>
<img src="docs/screens/welcome.png" width="160"> <img src="docs/screens/camera.png" width="160"> <img src="docs/screens/draw.png" width="160"> <img src="docs/screens/text.png" width="160">
<img src="docs/screens/sendto.png" width="160"> <img src="docs/screens/chats.png" width="160"> <img src="docs/screens/link.png" width="160"> <img src="docs/screens/settings.png" width="160">
</p>

## Run it

```bash
cp .env.example .env
docker compose up -d --build
```

Open http://localhost:8080.

Browsers only give camera access on `https://` or `localhost`. To use it from a phone, put it behind a TLS
reverse proxy. Caddy, for example:

```caddyfile
snap.example.com {
    reverse_proxy kicksnap:8000
}
```

WebSockets (`/ws`) pass through Caddy with no extra config.

Data (SQLite + media) lives in the `kicksnap-data` volume at `/data`.

### Notifications

Web Push with VAPID, no third-party service of your own needed (the browser's push service delivers it).
The VAPID key is generated on first start and stored as `/data/vapid.pem`; keep it, or every device has to
turn notifications on again. Payloads only say who sent something, never the snap.

- **iPhone:** Apple only allows web push for apps added to the home screen (Share → Add to Home Screen, iOS 16.4+).
  Settings says so when it's opened in a normal Safari tab.
- **Android:** works in Chrome, installed or not.
- Set `VAPID_SUBJECT` to a `mailto:` or `https:` URL you own (Apple rejects some placeholders).

### Sign-in

- Each browser gets a random device secret in an `httpOnly` cookie. Only its SHA-256 is stored.
- Linking a device: the new one shows a 6-character code (and QR), valid 5 minutes. A signed-in device scans
  it (or types it) and approves. The new device's poll then gets its own cookie.
- Passkeys are WebAuthn, discoverable credentials. The relying-party ID defaults to the request host; set `RP_ID`
  if you serve on several hostnames. Passkeys need HTTPS (or `localhost`).
- Signed-in devices are listed under your face → "signed in on". Remove any from there.
- Accounts that never pick a name are deleted after a day.

## How snaps burn

- A snap's media is deleted from disk once every recipient has opened it.
- Anything unopened after `SNAP_TTL_HOURS` (default 24) is deleted.
- The sender only ever sees "delivered" / "opened". There is no history.

## Moderation

Nobody is admin by default. Whoever runs the server grants it from the shell:

```bash
docker compose exec kicksnap python -m app.admin grant kim     # revoke / list too
docker compose exec kicksnap python -m app.admin reports       # open reports
docker compose exec kicksnap python -m app.admin suspend sam --days 7
docker compose exec kicksnap python -m app.admin delete sam    # --free-name to not reserve it
docker compose exec kicksnap python -m app.admin reserve ceo "impersonation"
```

- Admins get an "admin" tile in their profile: open reports (with the snap if the reporter attached it), user
  search, reserved names and a log of every admin action.
- Reporting is in the app (snap viewer flag, or a friend's chat options). It blocks by default. No email, no
  scores; the "friends who reported" count only sorts the queue. Admins get one push when the queue goes from
  empty to not empty.
- Suspend (optionally for N days) keeps the account but locks it; friends see "unavailable". Delete wipes it and
  by default reserves the name.
- People who delete their own account get their name held for `NAME_COOLDOWN_DAYS` (default 30), then freed.
- If anyone reports illegal content (for example child sexual abuse material), you have to act on it and may be
  legally required to report it where you live. Don't just dismiss it.

## Develop

```bash
# api on :8000
cd backend && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
DATA_DIR=./data uvicorn app.main:app --reload

# web on :5173, proxies /api and /ws to :8000
cd frontend && npm install && npm run dev
```

API docs: http://localhost:8000/api/docs

## Stack

FastAPI + SQLite on the back, React + Vite + Tailwind PWA on the front, one container.
