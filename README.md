# kicksnap

Self-hosted snap app. Open, snap, send. Snaps burn after they're viewed.

## What it feels like

- **Opens on the camera.** Tap the shutter for a photo, hold it for up to 10s of video. Double-tap to flip.
- **Swipe, don't navigate.** Swipe right for chats, left for friends. No menus.
- **Snap, then play.** Draw on it in 9 colours, add text (tap T again for big outlined text), drag it around.
- **Send.** Tap the timer for 3s / 5s / 10s / ∞, hit send, tap faces.
- **Snap back.** Open a snap, hit "snap back", and the next one goes straight to that person.
- **No passwords, ever.** A new device either says "I'm new" (then you pick a name) or "I've got an account".
  Then you either use a passkey, or scan the QR it shows from a phone that's already signed in.
- **Add friends by QR.** Your code is on the friends screen. Scan theirs, or type their name.

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
