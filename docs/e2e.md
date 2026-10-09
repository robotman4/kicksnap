# Kiks end-to-end encryption, protocol v1

Status: implemented in the web app and server. The Flutter app must implement exactly this.
Test vectors: [`e2e-vectors.json`](e2e-vectors.json). A Python reference implementation lives in
[`backend/tests/e2e_ref.py`](../backend/tests/e2e_ref.py); the web implementation is
[`frontend/src/lib/crypto.ts`](../frontend/src/lib/crypto.ts).

The server stores and forwards ciphertext. It never holds a private key and can't read snaps or texts.
It still sees metadata: who talks to whom and when, snap kind (photo/video), timer, sizes.

## Primitives

| Use | Primitive |
|---|---|
| Key agreement | X25519 (RFC 7748) |
| Signatures | Ed25519 (RFC 8032), private key = 32-byte seed |
| KDF | HKDF-SHA256 (RFC 5869) |
| AEAD | AES-256-GCM, 12-byte random nonce, 16-byte tag, no AAD |
| Hash | SHA-256 |

Encoding: every binary value in JSON or in signed text is **base64url without padding** (`b64` below).
Text is UTF-8. "Lines" means joined with `\n` (0x0A), no trailing newline.

Dart: `package:cryptography` (`X25519`, `Ed25519`, `Hkdf(hmac: Hmac.sha256())`, `AesGcm.with256bits()`) has all of
them; use `cryptography_flutter` for native speed on big videos.

### Building blocks

```
hkdf(ikm, salt, info)  = HKDF-SHA256(ikm, salt, info as UTF-8, length 32)
                         (empty salt = HKDF's default: 32 zero bytes)

aead_seal(key, pt)     = nonce(12, random) || AES-256-GCM(key, nonce, pt)      // ciphertext includes the tag
aead_open(key, blob)   = AES-256-GCM-decrypt(key, blob[0:12], blob[12:])

sym(ck, label)         = hkdf(ck, empty, "kiks/1 " + label)

seal(pub, pt, label):                      // anonymous box to an X25519 public key
    e      = new X25519 key pair
    shared = X25519(e.priv, pub)           // reject if all 32 bytes are zero
    key    = hkdf(shared, e.pub || pub, "kiks/1 " + label)
    return e.pub(32) || aead_seal(key, pt)

open(priv, pub, blob, label):              // pub = the recipient's own public key
    shared = X25519(priv, blob[0:32])
    key    = hkdf(shared, blob[0:32] || pub, "kiks/1 " + label)
    return aead_open(key, blob[32:])
```

Labels in use: `wrap`, `link`, `envelope`, `media`, `overlay`.

## Keys

| Key | Type | Where the private half lives | Server stores |
|---|---|---|---|
| **Identity key (IK)** | Ed25519 | every signed-in device of the account (copied during linking) | `users.identity_key` (public) |
| **Device key (DK)** | X25519 | only that device, never exported | `devices.enc_key` (public) |
| **Content key (CK)** | 32 random bytes | per snap / per text, inside the wraps | nothing in clear |
| **Link key** | X25519, one-time | the new device, for the length of a link | public half, 5 minutes, in memory |

### Signed device list

The account's identity key signs the list of its devices. Senders only encrypt to devices that are in this list
**and** that the server says still exist. So the server can drop a device (denial of service) but can't add one.

Signed text (lines):

```
kiks/1 devices
<username>
<version>                       decimal, strictly increasing per identity key
<device id> <b64 DK public>     one line per device, sorted by device id ascending (numeric)
...
```

Stored as `{payload: <that text>, sig: b64(Ed25519 signature over the UTF-8 payload)}`.
The server verifies the signature with the account's identity key and refuses versions that don't go up.
Clients verify it too and remember the highest version seen per (contact, identity key) to spot rollbacks.

Every device keeps the list right on start-up (and after removing a device):
`new list = (signed list ∩ devices the server lists as active) ∪ {this device}`, re-signed with version + 1 if it
changed. That is the only way a device gets added: by a device that holds the identity key.

### Fingerprints and verification

- Fingerprint (shown to people): hex of `SHA-256(IK public)[0:10]` in groups of 4: `a1b2 c3d4 e5f6 0718 293a`.
- Friend QR code: `kiks:<username>#<b64 IK public>`. Scanning it adds the friend **and** marks their key verified
  when it matches the server's; a mismatch warns.
- Clients pin each contact's identity key on first sight (TOFU). When it changes, they show "key changed"
  (and drop "verified") but keep working, like Signal.

## Sending

### Content key and signature per conversation

For each snap or text the sender makes a fresh `ck`. The signature is per **conversation**, written `to`:

- `u:<recipient username>` for a 1:1 conversation (for a text, also used on the sender's own devices)
- `g:<group id>` for a group

Signed text for a snap (lines):

```
kiks/1 snap
<from username>
<to>
<sent_at>          unix seconds
<nonce>            b64 of 16 random bytes
<kind>             photo | video
<mime>             of the plaintext media, e.g. image/jpeg
<seconds>          view time, 0 = until closed
<b64 SHA-256 of plaintext media>
<b64 SHA-256 of plaintext overlay, or "-">
```

Signed text for a text message (lines):

```
kiks/1 text
<from username>
<to>
<sent_at>
<nonce>
<b64 SHA-256 of the UTF-8 body>
```

`sig = Ed25519(IK, signed text)`. The signature binds content, sender and conversation, so neither the server nor a
recipient can forward it into another conversation as if the sender had sent it there.

### Envelope

JSON encrypted once per snap/text: `envelope = b64(aead_seal(sym(ck, "envelope"), utf8(json)))`.

```json
{"v": 1, "type": "snap", "from": "alice", "ik": "<b64 IK public>", "sent_at": 1760000000,
 "nonce": "<b64>", "kind": "photo", "mime": "image/jpeg", "seconds": 5,
 "media": "<b64 sha256>", "overlay": "<b64 sha256>" | null}

{"v": 1, "type": "text", "from": "alice", "ik": "<b64>", "sent_at": 1760000000, "nonce": "<b64>", "body": "hej"}
```

Media files: `aead_seal(sym(ck, "media"), plaintext)` and `aead_seal(sym(ck, "overlay"), overlay png)`.
Uploaded as `application/octet-stream`.

### Key wraps

For every target device `d` (DK public `pk`, from the verified device list):
`wrap = b64(seal(pk, ck(32) || sig(64), "wrap"))` (96 bytes of plaintext).

Target devices:
- snap: all devices of each recipient (none of the sender's own, snaps have no sent history)
- text: all devices of the recipients **and** all of the sender's own devices, including the sending one

A recipient with no identity key or no listed devices can't receive. The web app skips direct recipients like that
and tells the sender ("hasn't updated yet"); group members like that just don't get a wrap.

### Receiving

1. Take the wrap for this device. None = sent before this device was set up: show "open it on your other device"
   and **don't** mark the snap opened.
2. `ck || sig = open(DK, wrap, "wrap")`, decrypt the envelope with `sym(ck, "envelope")`.
3. Check `envelope.from` is the sender the server says, rebuild the signed text with the `to` this device expects
   (`u:<me>` for a 1:1 from someone else, `u:<peer>` for my own text in a 1:1, `g:<id>` in a group), verify `sig`
   with `envelope.ik`.
4. Compare `envelope.ik` with the pinned key for that sender: pin on first sight, flag "key changed" otherwise.
5. Snaps: decrypt media/overlay, check their SHA-256 against the envelope. Use `kind`, `mime` and `seconds` from the
   envelope, not from the server.

Any failure: show it as unreadable, never as content.

## Device linking (identity key transfer)

New device N, signed-in device A:

1. N makes a one-time X25519 link key `L`, calls `POST /link/start {link_key: b64(L.pub)}`.
   It shows the QR `kiks-link:<CODE>#<b64 L.pub>` and a 6-digit check number:
   `check = (first 3 bytes of SHA-256(L.pub) as big-endian int) mod 1000000`, zero-padded.
2. A scans the QR (so `L.pub` comes from N's screen, not from the server). If the code was typed instead, A fetches
   `L.pub` from `GET /link/<CODE>/key` and asks the person to compare the check number on both screens first.
3. A calls `POST /link/<CODE>/approve {key_blob: b64(seal(L.pub, IK seed(32), "link"))}`.
4. N's poll `GET /link/<CODE>?secret=…` returns its session plus `key_blob`. N opens it, checks the seed's public key
   equals the account's `identity_key`, makes its DK, publishes it, adds itself to the signed device list.

A device that is signed in but has no identity key (passkey sign-in, cleared storage, an account from before E2E
on its second device) does the same with `POST /keys/requests` and the QR `kiks-keys:<CODE>#<b64 L.pub>`;
only another device of the same account can approve it. Or it starts a **new identity**
(`PUT /keys/identity {replace: true}`): friends see "key changed" and the account's other devices have to be
approved again from it.

## Reports

The server can't see content, so the reporter's client sends the decrypted proof plus what's needed to check it:

- Snap: the plaintext media (and overlay) and `snap_proof = {snap_id, sent_at, nonce, kind, mime, seconds, overlay, sig}`.
- Texts: `text_proofs = [{id, body, sent_at, nonce, sig}]`.

The server rebuilds the signed text (it knows the sender, the conversation and the hash of what it was given) and
verifies the signature with the reported user's identity key. Admins see "signed by @x" (verified) or "not verified"
(the reporter's word only, e.g. the sender reset their key since). Nothing else about reporting changes.

## Server API (all under `/api/v1`, signed-in)

| Call | Body / result |
|---|---|
| `GET /keys/me` | `{device_id, identity_key, device_list: {payload, sig, version} \| null, devices: [{id, enc_key}]}` |
| `PUT /keys/identity` | `{identity_key, replace: false}`; 409 if one exists and `replace` is false. `replace` clears the device list. |
| `PUT /keys/device` | `{enc_key}` for the calling device |
| `PUT /keys/devices` | `{payload, sig}`; 400 bad signature or format, 409 version not higher |
| `GET /keys?users=a,b&groups=1,2` | `{users: {name: {identity_key, device_list, devices: [{id, enc_key}]}}}`, only you, friends and co-members |
| `POST /keys/requests` | `{link_key}` → `{code, secret}` |
| `GET /keys/requests/<code>` | approver (same account) reads `{link_key}` |
| `POST /keys/requests/<code>/approve` | `{key_blob}` |
| `GET /keys/requests/<code>/poll?secret=` | `{key_blob \| null}` |
| `POST /link/start` | optional `{link_key}` |
| `GET /link/<code>/key` | `{link_key}` (signed-in approver, typed-code path) |
| `POST /link/<code>/approve` | optional `{key_blob}` |
| `GET /link/<code>?secret=` | adds `key_blob` |
| `POST /snaps` | multipart: `file` (encrypted), `overlay` (encrypted, optional), `envelope`, `keys` = JSON `{"u": {device_id: wrap}, "g:<id>": {…}}`, `kind`, `seconds`, `to`, `groups` |
| `GET /snaps/<id>/key` | `{envelope, key, sender, to}`; `key` null if this device has no wrap |
| `GET /chats/<key>/messages` | each message adds `e2e`, `key` (`body` is the envelope when `e2e`) |
| `POST /chats/<key>/messages` | `{body: envelope, keys: {device_id: wrap}}` |
| `GET /reports/texts/<name>` | adds `e2e`, `key`, `to` per text |
| `POST /reports` | adds `snap_proof`, `overlay` (file), `text_proofs` |

Uploads without an envelope (clients from before E2E) get `426 update Kiks`. Snaps and texts stored before the
upgrade stay readable (`e2e: 0`) until they burn.

## Known limits

- A recipient can always keep what they see (screenshots, a modified client). E2E doesn't change that.
- Metadata (who, when, kind, timer, size) is visible to the server.
- No forward secrecy beyond burning: a stolen device key opens snaps that are still waiting for that device.
  Snaps burn within 24 h, which bounds it.
- On the web, the private keys sit in IndexedDB for the site, so code served by the site could use them. That's true
  of every web E2E app; the native apps keep them in the Keychain/Keystore.
- The server could in theory serve a modified web app. Use the native app or a server you trust for the strongest
  guarantee.
