# Running kicksnap

One container, one volume. Everything here is for the person running the server.

## Install

```bash
git clone https://github.com/robotman4/kicksnap && cd kicksnap
cp .env.example .env        # set VAPID_SUBJECT, and FORWARDED_ALLOW_IPS (below)
docker compose up -d --build
```

Or use a release image instead of building: in `compose.yml` replace `build: .` and `image: kicksnap:latest` with

```yaml
    image: ghcr.io/robotman4/kicksnap:1.0.0-beta.1
```

Then make yourself admin, after you've picked your name in the app:

```bash
docker compose exec kicksnap python -m app.admin grant <yourname>
```

## Reverse proxy (HTTPS)

Browsers only allow camera, passkeys, push and the service worker on `https://`. kicksnap speaks plain HTTP on
port 8000, so put any TLS reverse proxy in front. It needs to:

- pass WebSocket upgrades (`/api/v1/ws`, `/ws`),
- send `X-Forwarded-Proto: https` (so the sign-in cookie is marked `Secure`) and `X-Forwarded-For`,
- allow request bodies up to `MAX_UPLOAD_MB` (default 50).

Caddy, Traefik and Pangolin do all of this by default. nginx needs the WebSocket headers and `client_max_body_size`.

### Caddy

```caddyfile
snap.example.com {
    reverse_proxy kicksnap:8000
}
```

### Traefik (labels on the kicksnap service)

```yaml
    labels:
      - traefik.enable=true
      - traefik.http.routers.kicksnap.rule=Host(`snap.example.com`)
      - traefik.http.routers.kicksnap.entrypoints=websecure
      - traefik.http.routers.kicksnap.tls.certresolver=letsencrypt
      - traefik.http.services.kicksnap.loadbalancer.server.port=8000
```

Pangolin is Traefik underneath: point a resource at the container's port 8000 and that's it.

### Trusting the proxy: `FORWARDED_ALLOW_IPS`

uvicorn only believes `X-Forwarded-For` from addresses in `FORWARDED_ALLOW_IPS` (default `127.0.0.1`). A proxy in
another container or on another host isn't 127.0.0.1, so every visitor looks like the proxy's IP, and the
per-IP rate limits (sign-ups, link codes, name checks) are shared by everyone.

Set it to the proxy's address as the container sees it (comma separated), or `*` if nothing but the proxy can
reach the port (for example the port isn't published, or is firewalled to the proxy):

```bash
FORWARDED_ALLOW_IPS=172.18.0.1
```

To find it: `docker compose logs kicksnap` shows the client IP on each request. If every line has the same
`172.x`/`10.x` address, that's your proxy and it isn't trusted yet.

### Checking it works

```bash
curl -si -X POST https://snap.example.com/api/v1/devices/new | grep -i set-cookie
```

The cookie line should end with `Secure`. If it doesn't, the proxy isn't sending `X-Forwarded-Proto`.
(This makes a throwaway account with no name; those are deleted after a day.) In a browser: DevTools →
Application → Cookies → `ks_device` has the Secure box ticked.

`curl https://snap.example.com/api/v1/health` shows the running version, whether the database answers (503 if
not, so it works for uptime monitors), and how many unhandled errors happened in the last hour. The errors
themselves, with tracebacks, are in `docker compose logs kicksnap`.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | host port |
| `SNAP_TTL_HOURS` | `24` | unopened snaps burn after this |
| `MAX_UPLOAD_MB` | `50` | largest snap upload |
| `RP_ID` | request host | passkey domain; set it if you serve on several hostnames |
| `VAPID_SUBJECT` | project URL | `mailto:` or `https:` contact for push services |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | proxy address(es) to trust, see above |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |

## Backups

What matters is `/data/kicksnap.db` (accounts, friends, reports) and `/data/vapid.pem` (lose it and every device
has to turn notifications on again). Media isn't worth backing up: it burns within `SNAP_TTL_HOURS` anyway.

Don't `cp` the database while it runs: with WAL mode a plain copy can be inconsistent. Use the built-in backup,
which is safe while the app is running:

```bash
# writes /data/backups/kicksnap-<UTC time>/{kicksnap.db,vapid.pem}, keeps the newest 14
docker compose exec -T kicksnap python -m app.admin backup --keep 14

# copy them off the volume
docker compose cp kicksnap:/data/backups ./backups
```

Nightly from the host's crontab:

```cron
30 3 * * * cd /opt/kicksnap && docker compose exec -T kicksnap python -m app.admin backup --keep 14 && docker compose cp kicksnap:/data/backups ./backups
```

Then ship `./backups` off the box with whatever you already use (restic, borg, rsync).

### Restore

```bash
docker compose stop kicksnap
docker run --rm -v kicksnap_kicksnap-data:/data -v "$PWD/backups/kicksnap-20261009-033000:/b:ro" alpine sh -c \
  'cp /b/kicksnap.db /b/vapid.pem /data/ && rm -f /data/kicksnap.db-wal /data/kicksnap.db-shm && chown 10001 /data/kicksnap.db /data/vapid.pem && chmod 600 /data/vapid.pem'
docker compose start kicksnap
```

(The volume is `<compose project>_kicksnap-data`; `docker volume ls` shows the exact name.)

## Upgrading

```bash
docker compose exec -T kicksnap python -m app.admin backup     # always, first
git pull && docker compose up -d --build                       # or bump the image tag and `docker compose pull`
docker compose exec kicksnap python -m app.admin version       # version and schema number
```

Database migrations run by themselves on start. They only go forward: to roll back to an older version, restore
the backup you made before upgrading. Read [CHANGELOG.md](../CHANGELOG.md) before jumping versions.

## Admin from the shell

`docker compose exec kicksnap python -m app.admin --help` lists everything: grant/revoke admin, open reports,
suspend, delete, reserve/release names, backup, version.
