/**
 * The E2E building blocks from docs/e2e.md: pure functions over bytes, no app state.
 * X25519/Ed25519 from @noble/curves (audited, same result on every browser),
 * AES-256-GCM, HKDF and SHA-256 from WebCrypto.
 * Checked against docs/e2e-vectors.json by test/crypto.test.mjs.
 */
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

export type Bytes = Uint8Array;

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s: string): Bytes => enc.encode(s);
export const fromUtf8 = (b: Bytes): string => dec.decode(b);
export const random = (n: number): Bytes => globalThis.crypto.getRandomValues(new Uint8Array(n));

export function b64(b: Bytes): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64(s: string): Bytes {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const equal = (a: Bytes, b: Bytes) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle().digest("SHA-256", data as BufferSource));
}

export const shaB64 = async (data: Bytes) => b64(await sha256(data));

export async function hkdf(ikm: Bytes, salt: Bytes, info: string): Promise<Bytes> {
  const key = await subtle().importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: utf8(info) as BufferSource }, key, 256);
  return new Uint8Array(bits);
}

const aesKey = (raw: Bytes, use: KeyUsage) => subtle().importKey("raw", raw as BufferSource, "AES-GCM", false, [use]);

/** nonce(12) || AES-256-GCM ciphertext+tag */
export async function aeadSeal(key: Bytes, pt: Bytes, nonce: Bytes = random(12)): Promise<Bytes> {
  const ct = await subtle().encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, await aesKey(key, "encrypt"), pt as BufferSource);
  return concat(nonce, new Uint8Array(ct));
}

export async function aeadOpen(key: Bytes, blob: Bytes): Promise<Bytes> {
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: blob.subarray(0, 12) as BufferSource }, await aesKey(key, "decrypt"), blob.subarray(12) as BufferSource);
  return new Uint8Array(pt);
}

export const sym = (ck: Bytes, label: string) => hkdf(ck, new Uint8Array(0), `kiks/1 ${label}`);

// --- keys -------------------------------------------------------------------------

export const newX = () => {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
};
export const xPub = (priv: Bytes) => x25519.getPublicKey(priv);
export const newSeed = () => random(32);
export const edPub = (seed: Bytes) => ed25519.getPublicKey(seed);
export const sign = (seed: Bytes, text: string) => ed25519.sign(utf8(text), seed);
export function verify(pub: Bytes, sig: Bytes, text: string): boolean {
  try {
    return ed25519.verify(sig, utf8(text), pub, { zip215: false });
  } catch {
    return false;
  }
}

function shared(priv: Bytes, pub: Bytes): Bytes {
  const s = x25519.getSharedSecret(priv, pub);
  if (s.every((x) => x === 0)) throw new Error("bad key");
  return s;
}

/** Anonymous box to an X25519 public key: eph.pub(32) || nonce || ciphertext. */
export async function seal(pub: Bytes, pt: Bytes, label: string, eph: Bytes = x25519.utils.randomSecretKey(), nonce?: Bytes): Promise<Bytes> {
  const ePub = xPub(eph);
  const key = await hkdf(shared(eph, pub), concat(ePub, pub), `kiks/1 ${label}`);
  return concat(ePub, await aeadSeal(key, pt, nonce));
}

export async function open(priv: Bytes, blob: Bytes, label: string): Promise<Bytes> {
  const ePub = blob.subarray(0, 32);
  const key = await hkdf(shared(priv, ePub), concat(ePub, xPub(priv)), `kiks/1 ${label}`);
  return aeadOpen(key, blob.subarray(32));
}

// --- signed texts -------------------------------------------------------------------

export type SnapEnvelope = {
  v: 1;
  type: "snap";
  from: string;
  ik: string;
  sent_at: number;
  nonce: string;
  kind: "photo" | "video";
  mime: string;
  seconds: number;
  media: string;
  overlay: string | null;
};
export type TextEnvelope = { v: 1; type: "text"; from: string; ik: string; sent_at: number; nonce: string; body: string };

export const deviceListText = (username: string, version: number, devices: Map<number, Bytes>) =>
  ["kiks/1 devices", username, String(version), ...[...devices.keys()].sort((a, b) => a - b).map((id) => `${id} ${b64(devices.get(id)!)}`)].join("\n");

export function parseDeviceList(payload: string): { username: string; version: number; devices: Map<number, Bytes> } | null {
  const lines = payload.split("\n");
  if (lines.length < 3 || lines[0] !== "kiks/1 devices" || !/^\d+$/.test(lines[2])) return null;
  const devices = new Map<number, Bytes>();
  for (const line of lines.slice(3)) {
    const [id, key] = line.split(" ");
    if (!/^\d+$/.test(id) || !key) return null;
    const k = unb64(key);
    if (k.length !== 32) return null;
    devices.set(Number(id), k);
  }
  return { username: lines[1], version: Number(lines[2]), devices };
}

export const snapText = (e: SnapEnvelope, to: string) =>
  ["kiks/1 snap", e.from, to, String(e.sent_at), e.nonce, e.kind, e.mime, String(e.seconds), e.media, e.overlay ?? "-"].join("\n");

export const textText = async (e: TextEnvelope, to: string) =>
  ["kiks/1 text", e.from, to, String(e.sent_at), e.nonce, await shaB64(utf8(e.body))].join("\n");

/** Six digits both screens show while linking, for when the code was typed instead of scanned. */
export async function checkNumber(linkPub: Bytes): Promise<string> {
  const h = await sha256(linkPub);
  return String(((h[0] << 16) | (h[1] << 8) | h[2]) % 1_000_000).padStart(6, "0");
}

export async function fingerprint(ikPub: Bytes): Promise<string> {
  const hex = [...(await sha256(ikPub)).subarray(0, 10)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return hex.match(/.{4}/g)!.join(" ");
}

export { equal };
