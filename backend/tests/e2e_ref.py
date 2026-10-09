"""
Reference client for docs/e2e.md, used by the tests and to make docs/e2e-vectors.json.

Plain functions over bytes so it reads like the spec. Not used by the server.
"""
import base64
import hashlib
import json
import os

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

RAW = serialization.Encoding.Raw, serialization.PublicFormat.Raw
RAW_PRIV = serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sha(b: bytes) -> str:
    return b64(hashlib.sha256(b).digest())


def hkdf(ikm: bytes, salt: bytes, info: str) -> bytes:
    return HKDF(hashes.SHA256(), 32, salt or None, info.encode()).derive(ikm)


def aead_seal(key: bytes, pt: bytes, nonce: bytes | None = None) -> bytes:
    nonce = nonce or os.urandom(12)
    return nonce + AESGCM(key).encrypt(nonce, pt, None)


def aead_open(key: bytes, blob: bytes) -> bytes:
    return AESGCM(key).decrypt(blob[:12], blob[12:], None)


def sym(ck: bytes, label: str) -> bytes:
    return hkdf(ck, b"", f"kicksnap/1 {label}")


# --- keys ---------------------------------------------------------------------

def x_pub(priv: bytes) -> bytes:
    return X25519PrivateKey.from_private_bytes(priv).public_key().public_bytes(*RAW)


def ed_pub(seed: bytes) -> bytes:
    return Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(*RAW)


def new_x() -> tuple[bytes, bytes]:
    k = X25519PrivateKey.generate()
    return k.private_bytes(*RAW_PRIV), k.public_key().public_bytes(*RAW)


def new_ed() -> tuple[bytes, bytes]:
    k = Ed25519PrivateKey.generate()
    return k.private_bytes(*RAW_PRIV), k.public_key().public_bytes(*RAW)


def sign(seed: bytes, text: str) -> bytes:
    return Ed25519PrivateKey.from_private_bytes(seed).sign(text.encode())


def verify(pub: bytes, sig: bytes, text: str) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(pub).verify(sig, text.encode())
        return True
    except Exception:
        return False


# --- boxes --------------------------------------------------------------------

def seal(pub: bytes, pt: bytes, label: str, eph: bytes | None = None, nonce: bytes | None = None) -> bytes:
    e_priv = eph or new_x()[0]
    e_pub = x_pub(e_priv)
    shared = X25519PrivateKey.from_private_bytes(e_priv).exchange(X25519PublicKey.from_public_bytes(pub))
    assert shared != bytes(32)
    key = hkdf(shared, e_pub + pub, f"kicksnap/1 {label}")
    return e_pub + aead_seal(key, pt, nonce)


def open_(priv: bytes, blob: bytes, label: str) -> bytes:
    e_pub = blob[:32]
    shared = X25519PrivateKey.from_private_bytes(priv).exchange(X25519PublicKey.from_public_bytes(e_pub))
    if shared == bytes(32):
        raise ValueError("bad key")
    key = hkdf(shared, e_pub + x_pub(priv), f"kicksnap/1 {label}")
    return aead_open(key, blob[32:])


# --- signed texts -------------------------------------------------------------

def device_list_text(username: str, version: int, devices: dict[int, bytes]) -> str:
    return "\n".join(["kicksnap/1 devices", username, str(version)] + [f"{i} {b64(devices[i])}" for i in sorted(devices)])


def snap_text(e: dict, to: str) -> str:
    return "\n".join([
        "kicksnap/1 snap", e["from"], to, str(e["sent_at"]), e["nonce"], e["kind"], e["mime"], str(e["seconds"]),
        e["media"], e["overlay"] or "-",
    ])


def text_text(e: dict, to: str) -> str:
    return "\n".join(["kicksnap/1 text", e["from"], to, str(e["sent_at"]), e["nonce"], sha(e["body"].encode())])


def check_number(link_pub: bytes) -> str:
    return f"{int.from_bytes(hashlib.sha256(link_pub).digest()[:3], 'big') % 1_000_000:06d}"


def fingerprint(ik_pub: bytes) -> str:
    h = hashlib.sha256(ik_pub).digest()[:10].hex()
    return " ".join(h[i:i + 4] for i in range(0, 20, 4))


# --- a client -----------------------------------------------------------------

class Client:
    """One device of one account: holds the identity seed (if it has it) and its device key."""

    def __init__(self, user, ik: bytes | None = None):
        self.user = user  # tests.conftest.User
        self.ik = ik
        self.dk, self.dk_pub = new_x()

    @property
    def ik_pub(self) -> bytes:
        return ed_pub(self.ik)

    def me(self) -> dict:
        r = self.user.get("/api/v1/keys/me")
        assert r.status_code == 200, r.text
        return r.json()

    def setup(self, new_identity: bool = False) -> None:
        """Generate/publish identity if the account has none, publish this device, sign the list."""
        if self.ik is None:
            self.ik = new_ed()[0]
            r = self.user.c.put("/api/v1/keys/identity", headers=self.user.h, json={"identity_key": b64(self.ik_pub), "replace": new_identity})
            assert r.status_code == 200, r.text
        r = self.user.c.put("/api/v1/keys/device", headers=self.user.h, json={"enc_key": b64(self.dk_pub)})
        assert r.status_code == 200, r.text
        self.publish_list()

    def publish_list(self) -> None:
        me = self.me()
        assert me["identity_key"] == b64(self.ik_pub)
        devices: dict[int, bytes] = {}
        version = 0
        if me["device_list"]:
            version = me["device_list"]["version"]
            for line in me["device_list"]["payload"].split("\n")[3:]:
                i, k = line.split(" ")
                devices[int(i)] = unb64(k)
        active = {d["id"] for d in me["devices"]}
        devices = {i: k for i, k in devices.items() if i in active}
        devices[me["device_id"]] = self.dk_pub
        payload = device_list_text(self.user.name, version + 1, devices)
        r = self.user.c.put("/api/v1/keys/devices", headers=self.user.h, json={"payload": payload, "sig": b64(sign(self.ik, payload))})
        assert r.status_code == 200, r.text

    def bundles(self, users=(), groups=()) -> dict:
        q = f"users={','.join(users)}&groups={','.join(map(str, groups))}"
        r = self.user.get(f"/api/v1/keys?{q}")
        assert r.status_code == 200, r.text
        return r.json()["users"]

    @staticmethod
    def targets(bundle: dict) -> dict[int, bytes]:
        """Device id -> DK public, from the signed list, limited to devices the server lists as active."""
        if not bundle or not bundle["identity_key"] or not bundle["device_list"]:
            return {}
        dl = bundle["device_list"]
        assert verify(unb64(bundle["identity_key"]), unb64(dl["sig"]), dl["payload"])
        active = {d["id"] for d in bundle["devices"]}
        out = {}
        for line in dl["payload"].split("\n")[3:]:
            i, k = line.split(" ")
            if int(i) in active:
                out[int(i)] = unb64(k)
        return out

    def _envelope(self, ck: bytes, env: dict) -> str:
        return b64(aead_seal(sym(ck, "envelope"), json.dumps(env).encode()))

    def wraps(self, ck: bytes, sig: bytes, devices: dict[int, bytes]) -> dict[str, str]:
        return {str(i): b64(seal(k, ck + sig, "wrap")) for i, k in devices.items()}

    def send_snap(self, to_users=(), groups=(), media: bytes = b"\xff\xd8 photo", seconds: int = 5, overlay: bytes | None = None):
        ck = os.urandom(32)
        env = {"v": 1, "type": "snap", "from": self.user.name, "ik": b64(self.ik_pub), "sent_at": 1760000000,
               "nonce": b64(os.urandom(16)), "kind": "photo", "mime": "image/jpeg", "seconds": seconds,
               "media": sha(media), "overlay": sha(overlay) if overlay else None}
        b = self.bundles(to_users, groups)
        keys: dict[str, dict] = {}
        if to_users:
            keys["u"] = {}
            for name in to_users:
                keys["u"].update(self.wraps(ck, sign(self.ik, snap_text(env, f"u:{name}")), self.targets(b.get(name))))
        for g in groups:
            sig = sign(self.ik, snap_text(env, f"g:{g}"))
            keys[f"g:{g}"] = {}
            for name, bundle in b.items():
                if name != self.user.name:
                    keys[f"g:{g}"].update(self.wraps(ck, sig, self.targets(bundle)))
        files = {"file": ("snap", aead_seal(sym(ck, "media"), media), "application/octet-stream")}
        if overlay:
            files["overlay"] = ("overlay", aead_seal(sym(ck, "overlay"), overlay), "application/octet-stream")
        return self.user.post("/api/v1/snaps", files=files, data={
            "to": ",".join(to_users), "groups": ",".join(map(str, groups)), "seconds": str(seconds), "kind": "photo",
            "envelope": self._envelope(ck, env), "keys": json.dumps(keys),
        }), env

    def say(self, chat: str, body: str):
        """chat: u:<name> or g:<id>. Wraps for the recipients and all of my own devices."""
        ck = os.urandom(32)
        env = {"v": 1, "type": "text", "from": self.user.name, "ik": b64(self.ik_pub), "sent_at": 1760000000,
               "nonce": b64(os.urandom(16)), "body": body}
        kind, _, ident = chat.partition(":")
        b = self.bundles([ident, self.user.name] if kind == "u" else [self.user.name], [int(ident)] if kind == "g" else [])
        sig = sign(self.ik, text_text(env, chat))
        keys = {}
        for bundle in b.values():
            keys.update(self.wraps(ck, sig, self.targets(bundle)))
        return self.user.post(f"/api/v1/chats/{chat}/messages", json={"body": self._envelope(ck, env), "keys": keys}), env

    def unwrap(self, key: str, envelope: str) -> tuple[dict, bytes, bytes]:
        pt = open_(self.dk, unb64(key), "wrap")
        ck, sig = pt[:32], pt[32:]
        env = json.loads(aead_open(sym(ck, "envelope"), unb64(envelope)))
        return env, ck, sig

    def open_snap(self, snap_id: str, to: str) -> tuple[dict, bytes, bytes]:
        k = self.user.get(f"/api/v1/snaps/{snap_id}/key").json()
        env, ck, sig = self.unwrap(k["key"], k["envelope"])
        assert verify(unb64(env["ik"]), sig, snap_text(env, to))
        media = aead_open(sym(ck, "media"), self.user.get(f"/api/v1/snaps/{snap_id}/media").content)
        assert sha(media) == env["media"]
        return env, media, sig

    def read_texts(self, chat: str, to_for) -> list[str]:
        out = []
        for m in self.user.get(f"/api/v1/chats/{chat}/messages").json()["messages"]:
            if not m["e2e"]:
                out.append(m["body"])
                continue
            if not m["key"]:
                out.append(None)
                continue
            env, _, sig = self.unwrap(m["key"], m["body"])
            assert verify(unb64(env["ik"]), sig, text_text(env, to_for(m))), "bad signature"
            out.append(env["body"])
        return out
