// The web crypto against docs/e2e-vectors.json (made by the Python reference in backend/tests).
// Run: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as c from "../src/lib/crypto.ts";

const v = JSON.parse(readFileSync(new URL("../../docs/e2e-vectors.json", import.meta.url)));
const u = c.unb64;

test("x25519 public keys", () => {
  for (const k of v.x25519) assert.equal(c.b64(c.xPub(u(k.priv))), k.pub);
});

test("hkdf", async () => {
  for (const k of v.hkdf) assert.equal(c.b64(await c.hkdf(u(k.ikm), u(k.salt), k.info)), k.out);
});

test("ed25519", () => {
  for (const k of v.sign) {
    assert.equal(c.b64(c.edPub(u(k.seed))), k.pub);
    assert.equal(c.b64(c.sign(u(k.seed), k.text)), k.sig);
    assert.ok(c.verify(u(k.pub), u(k.sig), k.text));
    assert.ok(!c.verify(u(k.pub), u(k.sig), k.text + "!"));
  }
});

test("seal / open", async () => {
  for (const k of v.seal) {
    assert.equal(c.b64(await c.seal(u(k.pub), u(k.plaintext), k.label, u(k.eph), u(k.nonce))), k.out);
    assert.equal(c.b64(await c.open(u(k.priv), u(k.out), k.label)), k.plaintext);
  }
});

test("device list", () => {
  for (const k of v.device_list) {
    assert.ok(c.verify(u(k.identity_key), u(k.sig), k.payload));
    const parsed = c.parseDeviceList(k.payload);
    assert.equal(c.deviceListText(parsed.username, parsed.version, parsed.devices), k.payload);
  }
});

test("snap: unwrap, envelope, signature, media", async () => {
  for (const k of v.snap) {
    const pt = await c.open(u(k.device_priv), u(k.wrap), "wrap");
    const ck = pt.subarray(0, 32), sig = pt.subarray(32);
    assert.equal(c.b64(ck), k.content_key);
    assert.equal(c.b64(sig), k.sig);
    const env = JSON.parse(c.fromUtf8(await c.aeadOpen(await c.sym(ck, "envelope"), u(k.envelope_cipher))));
    assert.deepEqual(env, k.envelope);
    assert.equal(c.snapText(env, k.to), k.signed_text);
    assert.ok(c.verify(u(env.ik), sig, c.snapText(env, k.to)));
    assert.ok(!c.verify(u(env.ik), sig, c.snapText(env, "u:mallory")));
    const media = await c.aeadOpen(await c.sym(ck, "media"), u(k.media_cipher));
    assert.equal(c.b64(media), k.media_plain);
    assert.equal(await c.shaB64(media), env.media);
  }
});

test("text signed text", async () => {
  for (const k of v.text) {
    assert.equal(await c.textText(k.envelope, k.to), k.signed_text);
    assert.ok(c.verify(u(k.envelope.ik), u(k.sig), k.signed_text));
  }
});

test("check number and fingerprint", async () => {
  for (const k of v.check_number) assert.equal(await c.checkNumber(u(k.link_key)), k.check);
  for (const k of v.fingerprint) assert.equal(await c.fingerprint(u(k.identity_key)), k.fingerprint);
});

test("roundtrip with fresh keys", async () => {
  const d = c.newX();
  const blob = await c.seal(d.pub, c.utf8("hej"), "wrap");
  assert.equal(c.fromUtf8(await c.open(d.priv, blob, "wrap")), "hej");
  await assert.rejects(c.open(c.newX().priv, blob, "wrap"));
});
