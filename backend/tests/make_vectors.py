"""
Writes docs/e2e-vectors.json from the reference implementation, with fixed inputs.

    python tests/make_vectors.py      (from backend/)

The web client (frontend/test/crypto.test.mjs), the server tests and the Flutter app all check against it.
"""
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from e2e_ref import (  # noqa: E402
    aead_seal, b64, check_number, device_list_text, ed_pub, fingerprint, hkdf, seal, sha, sign, snap_text, sym,
    text_text, x_pub,
)


def det(label: str, n: int = 32) -> bytes:
    """Deterministic 'random' bytes so the file doesn't change on every run."""
    out = b""
    i = 0
    while len(out) < n:
        out += hashlib.sha256(f"{label}/{i}".encode()).digest()
        i += 1
    return out[:n]


def main():
    ik = det("alice identity")
    dk_bob = det("bob device 7")
    ck = det("content key")
    v: dict = {"version": 1, "note": "All binary values are base64url without padding. See docs/e2e.md."}

    v["x25519"] = [{"priv": b64(dk_bob), "pub": b64(x_pub(dk_bob))}]
    v["hkdf"] = [
        {"ikm": b64(ck), "salt": "", "info": "kicksnap/1 envelope", "out": b64(sym(ck, "envelope"))},
        {"ikm": b64(ck), "salt": "", "info": "kicksnap/1 media", "out": b64(sym(ck, "media"))},
        {"ikm": b64(det("shared")), "salt": b64(det("salt", 64)), "info": "kicksnap/1 wrap", "out": b64(hkdf(det("shared"), det("salt", 64), "kicksnap/1 wrap"))},
    ]
    v["sign"] = [{"seed": b64(ik), "pub": b64(ed_pub(ik)), "text": "kicksnap/1 test\nhej", "sig": b64(sign(ik, "kicksnap/1 test\nhej"))}]
    v["fingerprint"] = [{"identity_key": b64(ed_pub(ik)), "fingerprint": fingerprint(ed_pub(ik))}]
    link = det("link key")
    v["check_number"] = [{"link_key": b64(x_pub(link)), "check": check_number(x_pub(link))}]

    devices = {3: x_pub(det("alice device 3")), 12: x_pub(det("alice device 12"))}
    payload = device_list_text("alice", 2, devices)
    v["device_list"] = [{"identity_key": b64(ed_pub(ik)), "payload": payload, "sig": b64(sign(ik, payload))}]

    media = b"\xff\xd8\xff\xe0 not really a jpeg"
    env = {"v": 1, "type": "snap", "from": "alice", "ik": b64(ed_pub(ik)), "sent_at": 1760000000,
           "nonce": b64(det("snap nonce", 16)), "kind": "photo", "mime": "image/jpeg", "seconds": 5,
           "media": sha(media), "overlay": None}
    st = snap_text(env, "u:bob")
    sig = sign(ik, st)
    envelope_json = json.dumps(env, separators=(",", ":"))
    v["snap"] = [{
        "to": "u:bob",
        "envelope": env,
        "signed_text": st,
        "sig": b64(sig),
        "content_key": b64(ck),
        "media_plain": b64(media),
        "media_cipher": b64(aead_seal(sym(ck, "media"), media, det("media nonce", 12))),
        "envelope_json": envelope_json,
        "envelope_cipher": b64(aead_seal(sym(ck, "envelope"), envelope_json.encode(), det("env nonce", 12))),
        "device_priv": b64(dk_bob),
        "wrap": b64(seal(x_pub(dk_bob), ck + sig, "wrap", det("eph"), det("wrap nonce", 12))),
    }]
    tenv = {"v": 1, "type": "text", "from": "alice", "ik": b64(ed_pub(ik)), "sent_at": 1760000001,
            "nonce": b64(det("text nonce", 16)), "body": "hej 👋 åäö"}
    tt = text_text(tenv, "g:42")
    v["text"] = [{"to": "g:42", "envelope": tenv, "signed_text": tt, "sig": b64(sign(ik, tt))}]

    v["seal"] = [{
        "priv": b64(dk_bob), "pub": b64(x_pub(dk_bob)), "label": "link", "eph": b64(det("eph 2")),
        "nonce": b64(det("seal nonce", 12)), "plaintext": b64(ik),
        "out": b64(seal(x_pub(dk_bob), ik, "link", det("eph 2"), det("seal nonce", 12))),
    }]
    out = Path(__file__).resolve().parents[2] / "docs" / "e2e-vectors.json"
    out.write_text(json.dumps(v, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
