from app import __version__
from app.admin import main as admin_cli

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 64


def send(sender, to, seconds=5):
    return sender.post(
        "/api/v1/snaps",
        files={"file": ("snap.jpg", JPEG, "image/jpeg")},
        data={"to": ",".join(u.name for u in to), "seconds": str(seconds)},
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
    assert a.post(f"/api/v1/chats/u:{b.name}/messages", json={"body": "hej"}).status_code == 200
    msgs = b.get(f"/api/v1/chats/u:{a.name}/messages").json()["messages"]
    assert [m["body"] for m in msgs] == ["hej"]


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
