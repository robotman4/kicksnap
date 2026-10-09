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


hub = Hub()
