"""End-to-end encryption, driven by the reference client in e2e_ref.py (docs/e2e.md)."""
import json
import os

import pytest

from app.admin import main as admin_cli
from conftest import User
from e2e_ref import (
    Client, b64, check_number, ed_pub, new_x, open_, seal, sha, sign, snap_text, text_text, unb64, x_pub,
    device_list_text,
)

AUTH = {"X-Kicksnap-Auth": "bearer"}


def link(client, existing: Client) -> Client:
    """Sign a new device into `existing`'s account by QR, with the identity key sealed to its link key."""
    l_priv, l_pub = new_x()
    start = client.post("/api/v1/link/start", json={"link_key": b64(l_pub)}).json()
    blob = seal(l_pub, existing.ik, "link")
    r = existing.user.post(f"/api/v1/link/kicksnap-link:{start['code']}/approve", json={"key_blob": b64(blob)})
    assert r.status_code == 200, r.text
    r = client.get(f"/api/v1/link/{start['code']}?secret={start['secret']}", headers=AUTH).json()
    assert r["approved"]
    ik = open_(l_priv, unb64(r["key_blob"]), "link")
    assert ed_pub(ik) == existing.ik_pub
    dev = Client(User(client, existing.user.name, r["token"]), ik)
    dev.setup()
    return dev


@pytest.fixture
def pair(friends):
    a, b = friends()
    ca, cb = Client(a), Client(b)
    ca.setup()
    cb.setup()
    return ca, cb


def test_identity_and_signed_device_list(new_user):
    c = Client(new_user())
    c.setup()
    me = c.me()
    assert me["identity_key"] == b64(c.ik_pub)
    assert me["device_list"]["version"] == 1
    assert Client.targets(me) == {me["device_id"]: c.dk_pub}
    h = c.user.h
    # a second identity needs replace; the same one again is fine
    assert c.user.c.put("/api/v1/keys/identity", headers=h, json={"identity_key": b64(os.urandom(32))}).status_code == 409
    assert c.user.c.put("/api/v1/keys/identity", headers=h, json={"identity_key": b64(c.ik_pub)}).status_code == 200
    # the server checks signature, owner and version
    payload = device_list_text(c.user.name, 5, {me["device_id"]: c.dk_pub})
    bad = sign(os.urandom(32), payload)
    assert c.user.c.put("/api/v1/keys/devices", headers=h, json={"payload": payload, "sig": b64(bad)}).status_code == 400
    other = device_list_text("someoneelse", 5, {me["device_id"]: c.dk_pub})
    assert c.user.c.put("/api/v1/keys/devices", headers=h, json={"payload": other, "sig": b64(sign(c.ik, other))}).status_code == 400
    old = device_list_text(c.user.name, 1, {me["device_id"]: c.dk_pub})
    assert c.user.c.put("/api/v1/keys/devices", headers=h, json={"payload": old, "sig": b64(sign(c.ik, old))}).status_code == 409


def test_replacing_identity_clears_the_list(new_user):
    c = Client(new_user())
    c.setup()
    c.ik = None
    c.setup(new_identity=True)
    me = c.me()
    assert me["identity_key"] == b64(c.ik_pub) and me["device_list"]["version"] == 1


def test_only_friends_keys_are_handed_out(pair, new_user):
    a, b = pair
    stranger = Client(new_user())
    stranger.setup()
    got = a.bundles([b.user.name, stranger.user.name, a.user.name])
    assert set(got) == {a.user.name, b.user.name}


def test_friend_list_carries_identity_key(pair):
    a, b = pair
    friends = a.user.get("/api/v1/friends").json()["friends"]
    assert next(f for f in friends if f["username"] == b.user.name)["key"] == b64(b.ik_pub)


def test_snap_roundtrip_to_every_device(client, pair):
    a, b = pair
    b2 = link(client, b)
    r, env = a.send_snap([b.user.name], media=b"secret photo")
    assert r.status_code == 200, r.text
    snap_id = r.json()["id"]
    # the server only has ciphertext
    assert a.user.get(f"/api/v1/snaps/{snap_id}/media").status_code == 404  # sender isn't a recipient
    raw = b.user.get(f"/api/v1/snaps/{snap_id}/media").content
    assert b"secret photo" not in raw
    for dev in (b, b2):
        got_env, media, _ = dev.open_snap(snap_id, f"u:{b.user.name}")
        assert media == b"secret photo" and got_env["from"] == a.user.name
    # a device linked after sending has no key for it
    b3 = link(client, b)
    assert b3.user.get(f"/api/v1/snaps/{snap_id}/key").json()["key"] is None


def test_snap_signature_is_bound_to_the_conversation(pair):
    a, b = pair
    r, _ = a.send_snap([b.user.name])
    k = b.user.get(f"/api/v1/snaps/{r.json()['id']}/key").json()
    env, _, sig = b.unwrap(k["key"], k["envelope"])
    from e2e_ref import verify
    assert verify(unb64(env["ik"]), sig, snap_text(env, f"u:{b.user.name}"))
    assert not verify(unb64(env["ik"]), sig, snap_text(env, "u:someoneelse"))
    assert not verify(unb64(env["ik"]), sig, snap_text(env, "g:1"))


def test_group_snap_and_text(friends, new_user):
    a, b = friends()
    _, c = friends(a)
    ca, cb, cc = Client(a), Client(b), Client(c)
    for x in (ca, cb, cc):
        x.setup()
    g = a.post("/api/v1/groups", json={"name": "crew", "members": [b.name, c.name]}).json()
    r, _ = ca.send_snap(groups=[g["id"]], media=b"group pic")
    assert r.status_code == 200, r.text
    for x in (cb, cc):
        sid = next(s for s in x.user.get("/api/v1/chats").json() if s["key"] == f"g:{g['id']}")["snaps"][0]["id"]
        assert x.open_snap(sid, f"g:{g['id']}")[1] == b"group pic"
    r, _ = cb.say(f"g:{g['id']}", "hej gänget 👋")
    assert r.status_code == 200, r.text
    for x in (ca, cb, cc):
        assert x.read_texts(f"g:{g['id']}", lambda m: f"g:{g['id']}") == ["hej gänget 👋"]


def test_direct_text_readable_by_both_sides_and_my_other_devices(client, pair):
    a, b = pair
    a2 = link(client, a)
    r, _ = a.say(f"u:{b.user.name}", "hej")
    assert r.status_code == 200, r.text
    msgs = b.user.get(f"/api/v1/chats/u:{a.user.name}/messages").json()["messages"]
    assert msgs[0]["e2e"] and "hej" not in msgs[0]["body"]
    assert b.read_texts(f"u:{a.user.name}", lambda m: f"u:{b.user.name}") == ["hej"]
    # my own text, on my other device: signed for the conversation with b
    assert a2.read_texts(f"u:{b.user.name}", lambda m: f"u:{b.user.name}") == ["hej"]


def test_link_check_number_and_typed_code(client, pair):
    a, _ = pair
    _, l_pub = new_x()
    start = client.post("/api/v1/link/start", json={"link_key": b64(l_pub)}).json()
    # typed instead of scanned: the approver fetches the key and compares the check number
    got = a.user.get(f"/api/v1/link/{start['code']}/key").json()["link_key"]
    assert unb64(got) == l_pub and len(check_number(l_pub)) == 6


def test_key_request_from_a_keyless_device(client, pair):
    a, _ = pair
    # a second device of a's account that lost its keys (e.g. signed in with a passkey)
    second = link(client, a)
    keyless = Client(second.user)
    l_priv, l_pub = new_x()
    req = keyless.user.post("/api/v1/keys/requests", json={"link_key": b64(l_pub)}).json()
    assert a.user.get(f"/api/v1/keys/requests/{req['code']}").json()["link_key"] == b64(l_pub)
    assert keyless.user.get(f"/api/v1/keys/requests/{req['code']}/poll?secret={req['secret']}").json()["key_blob"] is None
    blob = b64(seal(l_pub, a.ik, "link"))
    assert a.user.post(f"/api/v1/keys/requests/{req['code']}/approve", json={"key_blob": blob}).status_code == 200
    got = keyless.user.get(f"/api/v1/keys/requests/{req['code']}/poll?secret={req['secret']}").json()["key_blob"]
    assert ed_pub(open_(l_priv, unb64(got), "link")) == a.ik_pub


def test_key_requests_are_only_for_your_own_devices(pair):
    a, b = pair
    _, l_pub = new_x()
    req = a.user.post("/api/v1/keys/requests", json={"link_key": b64(l_pub)}).json()
    assert b.user.get(f"/api/v1/keys/requests/{req['code']}").status_code == 410


def test_report_with_verified_proof(pair, new_user):
    a, b = pair
    admin = new_user("admin")
    admin_cli(["grant", admin.name])
    r, env = a.send_snap([b.user.name], media=b"bad pic")
    snap_id = r.json()["id"]
    _, media, sig = b.open_snap(snap_id, f"u:{b.user.name}")
    t, tenv = a.say(f"u:{b.user.name}", "mean words")
    texts = b.user.get(f"/api/v1/reports/texts/{a.user.name}").json()
    mine = next(x for x in texts if x["e2e"])
    tenv2, _, tsig = b.unwrap(mine["key"], mine["body"])
    proof = {k: env[k] for k in ("sent_at", "nonce", "kind", "mime", "seconds", "overlay")}
    r = b.user.post("/api/v1/reports", data={
        "username": a.user.name, "reason": "harassment", "block": "false",
        "snap_proof": json.dumps({**proof, "snap_id": snap_id, "sig": b64(sig)}),
        "message_ids": [str(mine["id"])],
        "text_proofs": json.dumps([{"id": mine["id"], "body": tenv2["body"], "sent_at": tenv2["sent_at"], "nonce": tenv2["nonce"], "sig": b64(tsig)}]),
    }, files={"file": ("snap.jpg", media, "image/jpeg")})
    assert r.status_code == 200, r.text
    rep = next(q for q in admin.get("/api/v1/admin/reports").json() if q["reported"] == a.user.name)
    assert rep["media_verified"] is True
    assert rep["texts"] == [{"body": "mean words", "at": rep["texts"][0]["at"], "group": None, "verified": True}]
    assert admin.get(rep["media"]).content == b"bad pic"


def test_report_with_made_up_proof_is_marked(pair, new_user):
    a, b = pair
    admin = new_user("admin")
    admin_cli(["grant", admin.name])
    r, env = a.send_snap([b.user.name], media=b"harmless")
    snap_id = r.json()["id"]
    _, _, sig = b.open_snap(snap_id, f"u:{b.user.name}")
    a.say(f"u:{b.user.name}", "nice pic")
    mine = next(x for x in b.user.get(f"/api/v1/reports/texts/{a.user.name}").json() if x["e2e"])
    tenv, _, tsig = b.unwrap(mine["key"], mine["body"])
    proof = {k: env[k] for k in ("sent_at", "nonce", "kind", "mime", "seconds", "overlay")}
    r = b.user.post("/api/v1/reports", data={
        "username": a.user.name, "reason": "nudity", "block": "false",
        "snap_proof": json.dumps({**proof, "snap_id": snap_id, "sig": b64(sig)}),
        "message_ids": [str(mine["id"])],
        "text_proofs": json.dumps([{**{k: tenv[k] for k in ("sent_at", "nonce")}, "id": mine["id"], "body": "something awful", "sig": b64(tsig)}]),
    }, files={"file": ("snap.jpg", b"something else entirely", "image/jpeg")})
    assert r.status_code == 200, r.text
    rep = next(q for q in admin.get("/api/v1/admin/reports").json() if q["reported"] == a.user.name)
    assert rep["media_verified"] is False
    assert rep["texts"][0]["verified"] is False


def test_vectors_file_matches_reference():
    """docs/e2e-vectors.json is what the web and Flutter clients test against; keep it honest."""
    from pathlib import Path

    v = json.loads((Path(__file__).resolve().parents[2] / "docs" / "e2e-vectors.json").read_text())
    for case in v["hkdf"]:
        from e2e_ref import hkdf
        assert b64(hkdf(unb64(case["ikm"]), unb64(case["salt"]), case["info"])) == case["out"]
    for case in v["seal"]:
        assert b64(seal(unb64(case["pub"]), unb64(case["plaintext"]), case["label"], unb64(case["eph"]), unb64(case["nonce"]))) == case["out"]
        assert open_(unb64(case["priv"]), unb64(case["out"]), case["label"]) == unb64(case["plaintext"])
    for case in v["sign"]:
        assert b64(ed_pub(unb64(case["seed"]))) == case["pub"]
        assert b64(sign(unb64(case["seed"]), case["text"])) == case["sig"]
    for case in v["x25519"]:
        assert b64(x_pub(unb64(case["priv"]))) == case["pub"]
    for case in v["check_number"]:
        assert check_number(unb64(case["link_key"])) == case["check"]
    for case in v["snap"]:
        assert snap_text(case["envelope"], case["to"]) == case["signed_text"]
    for case in v["text"]:
        assert text_text(case["envelope"], case["to"]) == case["signed_text"]
    assert sha(b"") == "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
