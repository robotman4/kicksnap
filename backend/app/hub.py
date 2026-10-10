from collections import defaultdict

from fastapi import WebSocket


class Hub:
    """Open websockets per user, for live updates."""

    def __init__(self):
        self.sockets: dict[int, set[WebSocket]] = defaultdict(set)

    async def push(self, user_id: int, event: dict):
        for ws in list(self.sockets.get(user_id, ())):
            try:
                await ws.send_json(event)
            except Exception:
                self.sockets[user_id].discard(ws)

    async def drop_device(self, user_id: int, device_id: int):
        """Close the sockets a signed-out or removed device still has open."""
        for ws in [w for w in self.sockets.get(user_id, ()) if getattr(w.state, "device_id", None) == device_id]:
            self.sockets[user_id].discard(ws)
            try:
                await ws.close(code=4401)
            except Exception:
                pass


hub = Hub()
