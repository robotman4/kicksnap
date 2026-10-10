import pytest

from app import __version__
from app.admin import main as admin_cli

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 64


def send(sender, to, seconds=5):
    """E2E-shaped upload without real crypto (test_e2e.py does the real thing); the server can't tell."""
    return sender.post(
        "/api/v1/snaps",
        files={"file": ("snap", JPEG, "application/octet-stream")},
        data={"to": ",".join(u.name for u in to), "seconds": str(seconds), "kind": "photo", "envelope": "x", "keys": "{}"},
    )


def chat_row(user, other):
    return next(c for c in user.get("/api/v1/chats").json() if c["name"] == other.name)


def test_health_reports_version(client):
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    assert r.json()["version"] == __version__


def test_unversioned_api_still_works(client):
    assert client.get("/api/health").json()["ok"] is True


def test_signed_out_is_401(client):
    assert client.get("/api/v1/me").status_code == 401
    assert client.get("/api/v1/me", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_cookie_sign_up(client):
    r = client.post("/api/v1/devices/new")
    assert "ks_device" in r.cookies
    assert "token" not in r.json()
    client.cookies.clear()


def test_name_rules(new_user):
    u = new_user()
    assert u.c.get("/api/v1/names/" + u.name).json() == {"free": False, "valid": True}
    assert u.c.get("/api/v1/names/x").json()["valid"] is False
    assert u.c.get("/api/v1/names/admin").json()["free"] is False  # reserved


def test_friend_request_then_accept(new_user, friends):
    a, b = friends()
    assert b.name in [f["username"] for f in a.get("/api/v1/friends").json()["friends"]]


def test_can_only_snap_friends(new_user):
    a, b = new_user(), new_user()
    assert send(a, [b]).status_code == 400


def test_snap_send_open_burn(friends):
    a, b = friends()
    r = send(a, [b])
    assert r.status_code == 200, r.text
    row = chat_row(b, a)
    assert row["state"] == "new"
    snap_id = row["snaps"][0]["id"]
    media = b.get(f"/api/v1/snaps/{snap_id}/media")
    assert media.status_code == 200 and media.content == JPEG
    assert b.post(f"/api/v1/snaps/{snap_id}/open").status_code == 200
    # burned: gone for the viewer, and the sender sees "opened"
    assert b.get(f"/api/v1/snaps/{snap_id}/media").status_code == 404
    assert chat_row(a, b)["state"] == "opened"


def test_text_message(friends):
    a, b = friends()
    assert a.post(f"/api/v1/chats/u:{b.name}/messages", json={"body": "hej", "keys": {}}).status_code == 200
    msgs = b.get(f"/api/v1/chats/u:{a.name}/messages").json()["messages"]
    assert [m["body"] for m in msgs] == ["hej"]


def test_clients_from_before_e2e_are_told_to_update(friends):
    a, b = friends()
    r = a.post("/api/v1/snaps", files={"file": ("snap.jpg", JPEG, "image/jpeg")}, data={"to": b.name})
    assert r.status_code == 426
    assert a.post(f"/api/v1/chats/u:{b.name}/messages", json={"body": "hej"}).status_code == 426


def test_block_stops_snaps(friends):
    a, b = friends()
    assert b.post("/api/v1/blocks", json={"username": a.name}).status_code == 200
    assert send(a, [b]).status_code == 400


def test_report_reaches_admin_queue(friends, new_user):
    a, b = friends()
    admin = new_user("admin")
    admin_cli(["grant", admin.name])
    assert a.get("/api/v1/admin/reports").status_code == 404  # not admin: looks like nothing's there
    r = a.post("/api/v1/reports", data={"username": b.name, "reason": "spam"})
    assert r.status_code == 200, r.text
    queue = admin.get("/api/v1/admin/reports").json()
    report = next(q for q in queue if q["reported"] == b.name)
    assert report["reporter"] == a.name and report["was_friend"] is True


def test_admin_suspend_and_delete_reserves_name(new_user):
    admin, bad = new_user("admin"), new_user("bad")
    admin_cli(["grant", admin.name])
    assert admin.post(f"/api/v1/admin/users/{bad.name}/suspend", json={}).status_code == 200
    assert bad.get("/api/v1/friends").status_code == 403
    assert admin.post(f"/api/v1/admin/users/{bad.name}/delete", json={}).status_code == 200
    assert bad.get("/api/v1/me").status_code == 401
    assert admin.c.get("/api/v1/names/" + bad.name).json()["free"] is False


def test_delete_own_account(new_user):
    u = new_user()
    assert u.delete("/api/v1/me", json={"username": "wrong"}).status_code == 400
    assert u.delete("/api/v1/me", json={"username": u.name}).status_code == 200
    assert u.get("/api/v1/me").status_code == 401


def test_logout_kills_token(new_user):
    u = new_user()
    assert u.post("/api/v1/auth/logout").status_code == 200
    assert u.get("/api/v1/me").status_code == 401


def test_names_from_before_the_rename_still_work(client, new_user):
    # bearer clients built against the old header
    r = client.post("/api/v1/devices/new", headers={"X-Kicksnap-Auth": "bearer"})
    assert r.json()["token"]
    # friend QR codes made before the rename
    a, b = new_user(), new_user()
    assert a.post("/api/v1/friends", json={"username": f"kicksnap:{b.name}"}).json()["status"] == "requested"
    assert b.post("/api/v1/friends", json={"username": f"kiks:{a.name}"}).json()["status"] == "friends"


def test_report_files_cant_be_pages(friends, new_user):
    # an SVG or HTML "screenshot" would run as a page on our origin when an admin opens it
    a, b = friends()
    svg = ("x.svg", b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "image/svg+xml")
    r = a.post("/api/v1/reports", data={"username": b.name, "reason": "spam"}, files={"shots": svg})
    assert r.status_code == 400
    r = a.post("/api/v1/reports", data={"username": b.name, "reason": "spam"}, files={"file": ("x.html", b"<script>", "image/svg+xml")})
    assert r.status_code == 400
    png = ("x.png", b"\x89PNG not really", "image/png")
    assert a.post("/api/v1/reports", data={"username": b.name, "reason": "spam", "block": "false"}, files={"shots": png}).status_code == 200
    admin = new_user("admin")
    admin_cli(["grant", admin.name])
    report = next(q for q in admin.get("/api/v1/admin/reports").json() if q["reported"] == b.name)
    res = admin.get(report["shots"][0])
    assert res.headers["content-type"] == "image/png"
    assert res.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in res.headers["content-security-policy"]


def test_made_up_tokens_dont_dodge_rate_limits(client):
    codes = [
        client.post("/api/v1/devices/new", headers={"Authorization": f"Bearer fake{i}"}).status_code for i in range(12)
    ]
    assert codes.count(429) == 2


def test_pages_cant_be_framed(client):
    assert client.get("/api/v1/health").headers["x-frame-options"] == "DENY"


def test_removed_device_loses_its_socket(new_user):
    from starlette.websockets import WebSocketDisconnect

    u = new_user()
    with u.c.websocket_connect("/api/v1/ws", headers=u.h) as ws:
        mine = next(d for d in u.get("/api/v1/devices").json()["devices"] if d["this"])
        assert u.delete(f"/api/v1/devices/{mine['id']}").status_code == 200
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
        assert closed.value.code == 4401


def test_native_report_files_get_their_type_from_the_name(friends):
    # the Flutter app sends multipart parts as application/octet-stream
    a, b = friends()
    shot = ("screenshot0.jpg", JPEG, "application/octet-stream")
    assert a.post("/api/v1/reports", data={"username": b.name, "reason": "spam"}, files={"shots": shot}).status_code == 200
