/**
 * End-to-end encryption for this device (protocol: docs/e2e.md, primitives: crypto.ts).
 *
 * This device keeps, in IndexedDB: its own X25519 device key (never leaves it), the
 * account's identity key seed once it has it, and the identity keys it has seen for
 * friends (pinned on first sight, so a change shows as "key changed").
 */
import { useSyncExternalStore } from "react";
import { api, ApiError, Chat, KeyBundle, Message, SnapMeta, TheirText } from "./api";
import * as c from "./crypto";

type Bytes = c.Bytes;
type Local = { account: string; dk: Bytes; dkPub: Bytes; ik?: Bytes; deviceId?: number };
/** `held`: the key changed from one you'd verified; their snaps and texts stay locked until you tap ok or re-scan. */
export type Contact = { ik: string; verified: boolean; changed: boolean; version: number; held?: boolean };

// --- storage --------------------------------------------------------------------------

const DB = "kiks-e2e";
let dbp: Promise<IDBDatabase> | null = null;

function idb(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((ok, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  }));
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await idb();
  return new Promise((ok, fail) => {
    const t = db.transaction("kv", mode);
    const r = run(t.objectStore("kv"));
    t.oncomplete = () => ok((r ? r.result : undefined) as T);
    t.onerror = () => fail(t.error);
  });
}

const load = <T>(k: string) => tx<T | undefined>("readonly", (s) => s.get(k));
const save = (k: string, v: unknown) => tx<void>("readwrite", (s) => void s.put(v, k));
const wipe = () => tx<void>("readwrite", (s) => void s.clear());

// --- state the UI watches ---------------------------------------------------------------

export type KeyState = {
  /** this device can send and open */
  ready: boolean;
  /** signed in, but this device doesn't have the account's identity key */
  locked: boolean;
  /** this account's fingerprint (people compare it in person) */
  fingerprint: string | null;
  contacts: Record<string, Contact>;
};

let state: KeyState = { ready: false, locked: false, fingerprint: null, contacts: {} };
const listeners = new Set<() => void>();
const set = (patch: Partial<KeyState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export const useKeys = () => useSyncExternalStore(subscribe, () => state);
export const keyState = () => state;

let local: Local | null = null;

/** Opening something before ensure() finished (a snap tapped right at start-up): read the keys we have. */
async function loaded() {
  local ??= (await load<Local>("local").catch(() => undefined)) ?? null;
  return local;
}

async function setContacts(contacts: Record<string, Contact>) {
  set({ contacts });
  await save("contacts", contacts);
}

/** False while that friend's key change waits on you (see `held`). */
const trusted = (username: string) => !state.contacts[username]?.held;

// "<from> <conversation> <nonce>" -> [snap or text id, first seen]; another id with the same ones is a replay.
// (One snap sent to two groups is two ids with one nonce, so the conversation is part of the key.)
type Seen = Record<string, [string, number]>;
const SEEN_DAYS = 7;
let seenP: Promise<Seen> | null = null;

async function fresh(from: string, to: string, nonce: string, id: string): Promise<boolean> {
  const seen = await (seenP ??= load<Seen>("seen").then((v): Seen => v ?? {}, (): Seen => ({})));
  const k = `${from} ${to} ${nonce}`;
  if (seen[k]) return seen[k][0] === id;
  const now = Date.now();
  for (const [key, [, at]] of Object.entries(seen)) if (now - at > SEEN_DAYS * 86400_000) delete seen[key];
  seen[k] = [id, now];
  await save("seen", seen).catch(() => {});
  return true;
}

// --- this device ------------------------------------------------------------------------

let syncing: Promise<KeyState> | null = null;

/**
 * Make sure this device has a device key on the server, the account has an identity key,
 * and the signed device list holds this device and nothing the server no longer has.
 * Runs at start-up, after removing a device, and when another device changed the keys.
 */
export function ensure(username: string): Promise<KeyState> {
  return (syncing ??= sync(username).finally(() => (syncing = null)));
}

async function sync(username: string): Promise<KeyState> {
  local = (await load<Local>("local")) ?? null;
  if (!local || local.account !== username) {
    // a different account on this browser: start clean
    await wipe();
    seenP = null;
    const k = c.newX();
    local = { account: username, dk: k.priv, dkPub: k.pub };
    await save("local", local);
  }
  set({ contacts: (await load<Record<string, Contact>>("contacts")) ?? {} });
  navigator.storage?.persist?.().catch(() => {});

  let me = await api.keys.me();
  local.deviceId = me.device_id;
  if (!me.devices.some((d) => d.id === me.device_id && d.enc_key === c.b64(local!.dkPub))) {
    await api.keys.device(c.b64(local.dkPub));
    me = await api.keys.me();
  }
  if (!me.identity_key) {
    // first device of an account (or one from before E2E): it makes the identity
    local.ik ??= c.newSeed();
    await save("local", local);
    await api.keys.identity(c.b64(c.edPub(local.ik))).catch((e) => {
      if (!(e instanceof ApiError && e.status === 409)) throw e; // another device of ours won the race
    });
    me = await api.keys.me();
  }
  if (local.ik && c.b64(c.edPub(local.ik)) !== me.identity_key) {
    // the account got a new identity elsewhere; ours is stale
    delete local.ik;
    await save("local", local);
  }
  if (!local.ik) {
    set({ ready: false, locked: true, fingerprint: await c.fingerprint(c.unb64(me.identity_key!)) });
    return state;
  }
  await publishList(me, (devices) => devices.set(me.device_id, local!.dkPub));
  set({ ready: true, locked: false, fingerprint: await c.fingerprint(c.edPub(local.ik)) });
  return state;
}

/** Re-sign the device list: (signed ∩ still on the server), then `change`. Skips if nothing changed. */
async function publishList(me: KeyBundle & { device_id: number }, change: (d: Map<number, Bytes>) => void, retry = true) {
  const ik = local!.ik!;
  const pub = c.edPub(ik);
  let current = new Map<number, Bytes>();
  let version = me.device_list?.version ?? 0;
  if (me.device_list && c.verify(pub, c.unb64(me.device_list.sig), me.device_list.payload)) {
    const parsed = c.parseDeviceList(me.device_list.payload);
    if (parsed && parsed.username === local!.account) current = parsed.devices;
  }
  const active = new Set(me.devices.map((d) => d.id));
  const next = new Map([...current].filter(([id]) => active.has(id)));
  change(next);
  const same = next.size === current.size && [...next].every(([id, k]) => current.has(id) && c.equal(current.get(id)!, k));
  if (same && me.device_list) return;
  version += 1;
  const payload = c.deviceListText(local!.account, version, next);
  try {
    await api.keys.devices(payload, c.b64(c.sign(ik, payload)));
  } catch (e) {
    if (retry && e instanceof ApiError && e.status === 409) return publishList(await api.keys.me(), change, false);
    throw e;
  }
}

/** Signing out here: take this device off the signed list, forget the keys. */
export async function leave() {
  try {
    if (local?.ik && local.deviceId) {
      const id = local.deviceId;
      await publishList(await api.keys.me(), (d) => d.delete(id));
    }
  } catch {
    // signing out still works; other devices prune us when they next start
  }
  await forget();
}

export async function forget() {
  local = null;
  seenP = null;
  await wipe().catch(() => {});
  set({ ready: false, locked: false, fingerprint: null, contacts: {} });
}

/** A brand new identity: friends see "key changed", other devices of yours need approving again. */
export async function resetIdentity(username: string) {
  const seed = c.newSeed();
  await api.keys.identity(c.b64(c.edPub(seed)), true);
  local = { ...(local ?? (await load<Local>("local"))!), ik: seed };
  await save("local", local);
  return ensure(username);
}

// --- linking: moving the identity key to a new device ------------------------------------

export type LinkKey = { priv: Bytes; pub: string; check: string };

export async function newLinkKey(): Promise<LinkKey> {
  const k = c.newX();
  return { priv: k.priv, pub: c.b64(k.pub), check: await c.checkNumber(k.pub) };
}

/** New device: the identity key arrived sealed to our link key. Keep it for `account`. */
export async function adopt(account: string, link: LinkKey, blob: string | null | undefined) {
  if (!blob) return;
  try {
    const seed = await c.open(link.priv, c.unb64(blob), "link");
    const prev = await load<Local>("local");
    const fresh = c.newX();
    if (prev?.account !== account) await wipe();
    local = { ...(prev?.account === account ? prev : { account, dk: fresh.priv, dkPub: fresh.pub }), ik: seed };
    await save("local", local);
  } catch {
    // a bad blob just leaves this device locked; it can ask again
  }
}

/** Locked device: show a QR, wait for one of our own devices to send the key. */
export async function requestKeys(username: string, onCode: (qr: string, code: string, check: string) => void, stop: () => boolean) {
  const link = await newLinkKey();
  const r = await api.keys.request(link.pub);
  onCode(`kiks-keys:${r.code}#${link.pub}`, r.code, link.check);
  const until = Date.now() + r.expires_in * 1000;
  while (!stop() && Date.now() < until) {
    await new Promise((ok) => setTimeout(ok, 2000));
    const p = await api.keys.poll(r.code, r.secret).catch(() => null);
    if (p?.key_blob) {
      await adopt(username, link, p.key_blob);
      return ensure(username);
    }
  }
  return null; // expired or cancelled; the caller starts over
}

/**
 * Signed-in device approving another one: a new sign-in (kiks-link:) or one of our own
 * devices asking for the keys (kiks-keys:). Scanned codes carry the link key; typed ones
 * fetch it from the server, so the person compares the check number first.
 */
export async function approve(raw: string, confirmCheck: (check: string) => Promise<boolean>): Promise<"device" | "keys"> {
  const m = raw.trim().match(/^(?:(?:kiks|kicksnap)-(link|keys):)?([A-Za-z0-9]{6})(?:#([A-Za-z0-9_-]{43}))?$/i);
  if (!m) throw new Error("that's not a device code");
  let kind = (m[1]?.toLowerCase() as "link" | "keys" | undefined) ?? null;
  const code = m[2].toUpperCase();
  let pub: string | null = m[3] ?? null;
  if (!pub) {
    // typed: ask the server, then have the person compare
    if (kind !== "keys") pub = await api.linkKey(code).then((r) => ((kind = "link"), r.link_key), () => null);
    if (!pub && kind !== "link") pub = await api.keys.requestInfo(code).then((r) => ((kind = "keys"), r.link_key), () => null);
    if (!kind) throw new Error("that code expired, make a new one");
    if (pub && !(await confirmCheck(await c.checkNumber(c.unb64(pub))))) throw new Error("not approved");
  }
  const ik = local?.ik;
  const blob = ik && pub ? c.b64(await c.seal(c.unb64(pub), ik, "link")) : undefined;
  if (kind === "keys") {
    if (!blob) throw new Error("this device doesn't have the keys to share either");
    await api.keys.approve(code, blob);
    return "keys";
  }
  await api.linkApprove(code, blob);
  return "device";
}

// --- other people's keys ------------------------------------------------------------------

const cache = new Map<string, { at: number; users: Record<string, KeyBundle> }>();
export const forgetBundles = () => cache.clear();

async function bundles(users: string[], groups: number[]) {
  const k = JSON.stringify([[...users].sort(), [...groups].sort()]);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 15000) return hit.users;
  const { users: got } = await api.keys.bundles(users, groups);
  cache.set(k, { at: Date.now(), users: got });
  return got;
}

/** Pin a friend's identity key the first time, flag it when it changes. */
export async function observe(username: string, ik: string | null | undefined) {
  if (!ik || !local || username === local.account) return;
  const known = state.contacts[username];
  if (known?.ik === ik) return;
  await setContacts({
    ...state.contacts,
    [username]: known
      ? { ik, verified: false, changed: true, version: 0, held: known.verified || !!known.held }
      : { ik, verified: false, changed: false, version: 0 },
  });
}

export async function acknowledge(username: string) {
  const k = state.contacts[username];
  if (k?.changed || k?.held) await setContacts({ ...state.contacts, [username]: { ...k, changed: false, held: false } });
}

/** Their QR code carried this key: matches what we have = verified. */
export async function verifyContact(username: string, ik: string): Promise<boolean> {
  const k = state.contacts[username];
  if (k && k.ik !== ik) return false;
  await setContacts({ ...state.contacts, [username]: { ik, verified: true, changed: false, version: k?.version ?? 0 } });
  return true;
}

export const myQr = () => (local?.ik ? `#${c.b64(c.edPub(local.ik))}` : "");

/** Device id -> public key, from the list their identity signed, limited to devices the server still has. */
async function targets(username: string, b: KeyBundle | undefined): Promise<Map<number, Bytes>> {
  const out = new Map<number, Bytes>();
  if (!b?.identity_key || !b.device_list) return out;
  const ik = c.unb64(b.identity_key);
  if (!c.verify(ik, c.unb64(b.device_list.sig), b.device_list.payload)) return out;
  const parsed = c.parseDeviceList(b.device_list.payload);
  if (!parsed || parsed.username !== username) return out;
  if (username === local!.account) {
    if (!c.equal(ik, c.edPub(local!.ik!))) return out;
  } else {
    await observe(username, b.identity_key);
    if (!trusted(username)) return out; // a verified friend's key changed: nothing goes to the new key until you ok it
    const k = state.contacts[username];
    if (k && k.ik === b.identity_key) {
      if (parsed.version < k.version) return out; // an older list than we've already seen: refuse
      if (parsed.version > k.version) await setContacts({ ...state.contacts, [username]: { ...k, version: parsed.version } });
    }
  }
  const active = new Set(b.devices.map((d) => d.id));
  for (const [id, key] of parsed.devices) if (active.has(id)) out.set(id, key);
  return out;
}

function needKeys() {
  if (!local?.ik) throw new Error("this device can't send yet: approve it from your other device (tap your face)");
  return local.ik;
}

async function wrapAll(ck: Bytes, sig: Bytes, devices: Map<number, Bytes>, into: Record<string, string>) {
  for (const [id, pub] of devices) into[String(id)] = c.b64(await c.seal(pub, c.concat(ck, sig), "wrap"));
}

// --- snaps ---------------------------------------------------------------------------------

export type SealedSnap = { file: Blob; overlay: Blob | null; envelope: string; keys: Record<string, Record<string, string>>; kind: string };

/**
 * Encrypt a snap for chat keys ("u:name", "g:id"). Direct recipients whose app has no keys yet
 * are left out and returned in `skipped`.
 */
export async function sealSnap(file: Blob, overlay: Blob | null, to: string[], seconds: number) {
  const ik = needKeys();
  const users = to.filter((k) => k.startsWith("u:")).map((k) => k.slice(2));
  const groups = to.filter((k) => k.startsWith("g:")).map((k) => Number(k.slice(2)));
  const b = await bundles(users, groups);
  const media = new Uint8Array(await file.arrayBuffer());
  const layer = overlay ? new Uint8Array(await overlay.arrayBuffer()) : null;
  const kind = file.type.startsWith("video") ? "video" : "photo";
  const env: c.SnapEnvelope = {
    v: 1,
    type: "snap",
    from: local!.account,
    ik: c.b64(c.edPub(ik)),
    sent_at: Math.floor(Date.now() / 1000),
    nonce: c.b64(c.random(16)),
    kind,
    mime: file.type || "application/octet-stream",
    seconds,
    media: await c.shaB64(media),
    overlay: layer ? await c.shaB64(layer) : null,
  };
  const ck = c.random(32);
  const keys: SealedSnap["keys"] = {};
  const skipped: string[] = [];
  for (const u of users) {
    const devs = await targets(u, b[u]);
    if (!devs.size) {
      skipped.push(u);
      continue;
    }
    await wrapAll(ck, c.sign(ik, c.snapText(env, `u:${u}`)), devs, (keys.u ??= {}));
  }
  for (const g of groups) {
    const sig = c.sign(ik, c.snapText(env, `g:${g}`));
    keys[`g:${g}`] = {};
    // the server keeps only the wraps for this group's members
    for (const [name, bundle] of Object.entries(b)) if (name !== local!.account) await wrapAll(ck, sig, await targets(name, bundle), keys[`g:${g}`]);
  }
  const sealed: SealedSnap = {
    file: new Blob([(await c.aeadSeal(await c.sym(ck, "media"), media)) as BlobPart]),
    overlay: layer ? new Blob([(await c.aeadSeal(await c.sym(ck, "overlay"), layer)) as BlobPart]) : null,
    envelope: c.b64(await c.aeadSeal(await c.sym(ck, "envelope"), c.utf8(JSON.stringify(env)))),
    keys,
    kind,
  };
  return { sealed, to: to.filter((k) => !(k.startsWith("u:") && skipped.includes(k.slice(2)))), skipped };
}

export type SnapProof = { snap_id: string; sent_at: number; nonce: string; kind: string; mime: string; seconds: number; overlay: string | null; sig: string };
export type OpenedSnap =
  | { ok: true; media: Blob; overlay: Blob | null; kind: "photo" | "video"; seconds: number; proof: SnapProof | null }
  | { ok: false; why: "nokey" | "bad" | "changed" };

/** Fetch, decrypt and check a snap. `chat` says which conversation it came in, for the signature. */
export async function openSnap(snap: SnapMeta, chat: Chat): Promise<OpenedSnap> {
  const k = await api.snapKey(snap.id);
  if (!k.e2e) {
    const [media, overlay] = await Promise.all([api.media(snap.id), snap.has_overlay ? api.overlay(snap.id).catch(() => null) : null]);
    return { ok: true, media, overlay, kind: snap.kind, seconds: snap.seconds, proof: null };
  }
  if (!k.key || !(await loaded())) return { ok: false, why: "nokey" };
  try {
    const pt = await c.open(local!.dk, c.unb64(k.key), "wrap");
    const ck = pt.subarray(0, 32);
    const sig = pt.subarray(32);
    const env = JSON.parse(c.fromUtf8(await c.aeadOpen(await c.sym(ck, "envelope"), c.unb64(k.envelope!)))) as c.SnapEnvelope;
    const to = chat.group ? chat.key : `u:${local!.account}`;
    if (env.type !== "snap" || env.from !== k.sender || !c.verify(c.unb64(env.ik), sig, c.snapText(env, to))) return { ok: false, why: "bad" };
    await observe(env.from, env.ik);
    if (!trusted(env.from)) return { ok: false, why: "changed" };
    if (!(await fresh(env.from, to, env.nonce, snap.id))) return { ok: false, why: "bad" }; // the same snap delivered again
    const media = await c.aeadOpen(await c.sym(ck, "media"), new Uint8Array(await (await api.media(snap.id)).arrayBuffer()));
    if ((await c.shaB64(media)) !== env.media) return { ok: false, why: "bad" };
    let overlay: Bytes | null = null;
    if (env.overlay) {
      overlay = await c.aeadOpen(await c.sym(ck, "overlay"), new Uint8Array(await (await api.overlay(snap.id)).arrayBuffer()));
      if ((await c.shaB64(overlay)) !== env.overlay) return { ok: false, why: "bad" };
    }
    const { sent_at, nonce, kind, mime, seconds } = env;
    return {
      ok: true,
      media: new Blob([media as BlobPart], { type: env.mime }),
      overlay: overlay ? new Blob([overlay as BlobPart], { type: "image/png" }) : null,
      kind: env.kind,
      seconds: env.seconds,
      proof: { snap_id: snap.id, sent_at, nonce, kind, mime, seconds, overlay: env.overlay, sig: c.b64(sig) },
    };
  } catch {
    return { ok: false, why: "bad" };
  }
}

// --- texts ---------------------------------------------------------------------------------

/** Encrypt a text for a chat ("u:name" or "g:id"): their devices and all of mine. */
export async function sealText(chatKey: string, body: string) {
  const ik = needKeys();
  const [kind, ident] = [chatKey.slice(0, 1), chatKey.slice(2)];
  const b = await bundles(kind === "u" ? [ident, local!.account] : [local!.account], kind === "g" ? [Number(ident)] : []);
  const env: c.TextEnvelope = {
    v: 1,
    type: "text",
    from: local!.account,
    ik: c.b64(c.edPub(ik)),
    sent_at: Math.floor(Date.now() / 1000),
    nonce: c.b64(c.random(16)),
    body,
  };
  const ck = c.random(32);
  const sig = c.sign(ik, await c.textText(env, chatKey));
  const keys: Record<string, string> = {};
  for (const [name, bundle] of Object.entries(b)) {
    const devs = await targets(name, bundle);
    if (kind === "u" && name === ident && !trusted(ident)) throw new Error(`@${ident}'s key changed: check it's them, then tap ok`);
    if (kind === "u" && name === ident && !devs.size) throw new Error(`@${ident} needs to update Kiks before you can chat`);
    await wrapAll(ck, sig, devs, keys);
  }
  return { body: c.b64(await c.aeadSeal(await c.sym(ck, "envelope"), c.utf8(JSON.stringify(env)))), keys };
}

async function openText<T extends { id: number; body: string; e2e?: boolean; key?: string | null }>(m: T, from: string, to: string) {
  if (!m.e2e) return m;
  if (!m.key || !local) return { ...m, body: "", locked: "nokey" as const };
  try {
    const pt = await c.open(local.dk, c.unb64(m.key), "wrap");
    const ck = pt.subarray(0, 32);
    const sig = pt.subarray(32);
    const env = JSON.parse(c.fromUtf8(await c.aeadOpen(await c.sym(ck, "envelope"), c.unb64(m.body)))) as c.TextEnvelope;
    if (env.type !== "text" || env.from !== from || !c.verify(c.unb64(env.ik), sig, await c.textText(env, to))) throw new Error();
    await observe(env.from, env.ik);
    if (!trusted(env.from)) return { ...m, body: "", locked: "changed" as const };
    if (!(await fresh(env.from, to, env.nonce, `t${m.id}`))) throw new Error(); // the same text delivered again
    return { ...m, body: env.body, proof: { sent_at: env.sent_at, nonce: env.nonce, sig: c.b64(sig) } };
  } catch {
    return { ...m, body: "", locked: "bad" as const };
  }
}

/** Decrypt a thread. In a 1:1 the signature names the recipient; in a group, the group. */
export async function openTexts(chat: Chat, messages: Message[]): Promise<Message[]> {
  if (messages.some((m) => m.e2e)) await loaded();
  return Promise.all(messages.map((m) => openText(m, m.from, chat.group ? chat.key : m.mine ? chat.key : `u:${local?.account}`)));
}

/** Their texts offered as proof in a report; the server says which conversation each was in. */
export async function openTheirTexts(from: string, texts: TheirText[]): Promise<TheirText[]> {
  await loaded();
  const out = await Promise.all(texts.map((t) => openText(t, from, t.to ?? "")));
  return out.filter((t) => !("locked" in t && t.locked)) as TheirText[];
}
