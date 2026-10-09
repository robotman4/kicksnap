/// End-to-end encryption for this device (protocol: docs/e2e.md, primitives: crypto.dart).
/// A port of frontend/src/lib/e2e.ts; keep the two in step.
///
/// This device keeps, in the Keystore/Keychain: its own X25519 device key (never leaves it),
/// the account's identity key seed once it has it, and the identity keys it has seen for
/// friends (pinned on first sight, so a change shows as "key changed").
library;

import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';

import 'api.dart';
import 'crypto.dart' as c;
import 'models.dart';
import 'store.dart';

typedef Bytes = Uint8List;

class Contact {
  Contact(this.ik, {this.verified = false, this.changed = false, this.version = 0});
  final String ik;
  final bool verified, changed;
  final int version;

  Json toJson() => {'ik': ik, 'verified': verified, 'changed': changed, 'version': version};
  factory Contact.fromJson(Json j) =>
      Contact(j['ik'] as String, verified: j['verified'] == true, changed: j['changed'] == true, version: (j['version'] as num?)?.toInt() ?? 0);
  Contact copy({bool? verified, bool? changed, int? version}) =>
      Contact(ik, verified: verified ?? this.verified, changed: changed ?? this.changed, version: version ?? this.version);
}

class KeyState {
  const KeyState({this.ready = false, this.locked = false, this.fingerprint, this.contacts = const {}});

  /// this device can send and open
  final bool ready;

  /// signed in, but this device doesn't have the account's identity key
  final bool locked;

  /// this account's fingerprint (people compare it in person)
  final String? fingerprint;
  final Map<String, Contact> contacts;

  KeyState copy({bool? ready, bool? locked, String? fingerprint, Map<String, Contact>? contacts, bool clearFingerprint = false}) => KeyState(
        ready: ready ?? this.ready,
        locked: locked ?? this.locked,
        fingerprint: clearFingerprint ? null : fingerprint ?? this.fingerprint,
        contacts: contacts ?? this.contacts,
      );
}

class _Local {
  _Local(this.account, this.dk, this.dkPub, {this.ik, this.deviceId});
  final String account;
  final Bytes dk, dkPub;
  Bytes? ik;
  int? deviceId;

  Json toJson() => {'account': account, 'dk': c.b64(dk), 'dkPub': c.b64(dkPub), if (ik != null) 'ik': c.b64(ik!), if (deviceId != null) 'deviceId': deviceId};
  static _Local? fromJson(Json? j) {
    if (j == null) return null;
    return _Local(j['account'] as String, c.unb64(j['dk'] as String), c.unb64(j['dkPub'] as String),
        ik: j['ik'] == null ? null : c.unb64(j['ik'] as String), deviceId: (j['deviceId'] as num?)?.toInt());
  }
}

/// The UI watches this.
final keys = ValueNotifier<KeyState>(const KeyState());

_Local? _local;

Future<_Local?> _loaded() async => _local ??= _Local.fromJson(await Store.readJson('local'));
Future<void> _save() => Store.writeJson('local', _local?.toJson());

Future<void> _setContacts(Map<String, Contact> contacts) async {
  keys.value = keys.value.copy(contacts: contacts);
  await Store.writeJson('contacts', {for (final e in contacts.entries) e.key: e.value.toJson()});
}

Future<Map<String, Contact>> _loadContacts() async {
  final j = await Store.readJson('contacts') ?? {};
  return {for (final e in j.entries) e.key: Contact.fromJson(e.value as Json)};
}

Future<void> _wipe() async {
  await Store.writeJson('local', null);
  await Store.writeJson('contacts', null);
}

/// Tests only: another simulated device took over Store and api; reload from them.
@visibleForTesting
Future<void> switchDevice() async {
  _local = _Local.fromJson(await Store.readJson('local'));
  _cache.clear();
  keys.value = KeyState(contacts: await _loadContacts(), ready: _local?.ik != null);
}

// --- this device ------------------------------------------------------------------------

Future<KeyState>? _syncing;

/// Make sure this device has a device key on the server, the account has an identity key,
/// and the signed device list holds this device and nothing the server no longer has.
/// Runs at start-up, after removing a device, and when another device changed the keys.
Future<KeyState> ensure(String username) => _syncing ??= _sync(username).whenComplete(() => _syncing = null);

Future<KeyState> _sync(String username) async {
  _local = _Local.fromJson(await Store.readJson('local'));
  if (_local == null || _local!.account != username) {
    // a different account on this device: start clean
    await _wipe();
    final k = await c.newX();
    _local = _Local(username, k.priv, k.pub);
    await _save();
  }
  final local = _local!;
  keys.value = keys.value.copy(contacts: await _loadContacts());

  var me = await api.keysMe();
  local.deviceId = me.deviceId;
  if (me.devices[me.deviceId] != c.b64(local.dkPub)) {
    await api.putDevice(c.b64(local.dkPub));
    me = await api.keysMe();
  }
  if (me.identityKey == null) {
    // first device of an account (or one from before E2E): it makes the identity
    local.ik ??= c.newSeed();
    await _save();
    try {
      await api.putIdentity(c.b64(await c.edPub(local.ik!)));
    } on ApiError catch (e) {
      if (e.status != 409) rethrow; // another device of ours won the race
    }
    me = await api.keysMe();
  }
  if (local.ik != null && c.b64(await c.edPub(local.ik!)) != me.identityKey) {
    // the account got a new identity elsewhere; ours is stale
    local.ik = null;
  }
  await _save();
  if (local.ik == null) {
    keys.value = keys.value.copy(ready: false, locked: true, fingerprint: await c.fingerprint(c.unb64(me.identityKey!)));
    return keys.value;
  }
  await _publishList(me, (d) => d[me.deviceId] = local.dkPub);
  keys.value = keys.value.copy(ready: true, locked: false, fingerprint: await c.fingerprint(await c.edPub(local.ik!)));
  return keys.value;
}

/// Re-sign the device list: (signed ∩ still on the server), then `change`. Skips if nothing changed.
Future<void> _publishList(MyKeys me, void Function(Map<int, Bytes>) change, {bool retry = true}) async {
  final local = _local!;
  final ik = local.ik!;
  final pub = await c.edPub(ik);
  var current = <int, Bytes>{};
  var version = me.deviceList?.version ?? 0;
  final dl = me.deviceList;
  if (dl != null && await c.verify(pub, c.unb64(dl.sig), dl.payload)) {
    final parsed = c.parseDeviceList(dl.payload);
    if (parsed != null && parsed.username == local.account) current = parsed.devices;
  }
  final next = {for (final e in current.entries) if (me.devices.containsKey(e.key)) e.key: e.value};
  change(next);
  final same = next.length == current.length && next.entries.every((e) => current[e.key] != null && c.equal(current[e.key]!, e.value));
  if (same && dl != null) return;
  version += 1;
  final payload = c.deviceListText(local.account, version, next);
  try {
    await api.putDevices(payload, c.b64(await c.sign(ik, payload)));
  } on ApiError catch (e) {
    if (retry && e.status == 409) return _publishList(await api.keysMe(), change, retry: false);
    rethrow;
  }
}

/// Signing out here: take this device off the signed list, forget the keys.
Future<void> leave() async {
  try {
    final local = await _loaded();
    if (local?.ik != null && local?.deviceId != null) {
      final id = local!.deviceId!;
      await _publishList(await api.keysMe(), (d) => d.remove(id));
    }
  } catch (_) {
    // signing out still works; other devices prune us when they next start
  }
  await forget();
}

Future<void> forget() async {
  _local = null;
  await _wipe();
  keys.value = const KeyState();
}

/// A brand new identity: friends see "key changed", other devices of yours need approving again.
Future<KeyState> resetIdentity(String username) async {
  final seed = c.newSeed();
  await api.putIdentity(c.b64(await c.edPub(seed)), replace: true);
  final local = (await _loaded())!;
  local.ik = seed;
  await _save();
  return ensure(username);
}

// --- linking: moving the identity key to a new device ------------------------------------

class LinkKey {
  LinkKey(this.priv, this.pub, this.check);
  final Bytes priv;
  final String pub, check;
}

Future<LinkKey> newLinkKey() async {
  final k = await c.newX();
  return LinkKey(k.priv, c.b64(k.pub), await c.checkNumber(k.pub));
}

/// New device: the identity key arrived sealed to our link key. Keep it for `account`.
Future<void> adopt(String account, LinkKey link, String? blob) async {
  if (blob == null) return;
  try {
    final seed = await c.open(link.priv, c.unb64(blob), 'link');
    final prev = _Local.fromJson(await Store.readJson('local'));
    if (prev?.account != account) await _wipe();
    if (prev != null && prev.account == account) {
      _local = prev..ik = seed;
    } else {
      final fresh = await c.newX();
      _local = _Local(account, fresh.priv, fresh.pub, ik: seed);
    }
    await _save();
  } catch (_) {
    // a bad blob just leaves this device locked; it can ask again
  }
}

/// Locked device: show a QR, wait for one of our own devices to send the key.
/// Returns null when the code expired or `stop` says so; the caller starts over.
Future<KeyState?> requestKeys(String username, void Function(String qr, String code, String check) onCode, bool Function() stop) async {
  final link = await newLinkKey();
  final r = await api.keyRequest(link.pub);
  onCode('kiks-keys:${r.code}#${link.pub}', r.code, link.check);
  final until = DateTime.now().add(Duration(seconds: r.expiresIn));
  while (!stop() && DateTime.now().isBefore(until)) {
    await Future.delayed(const Duration(seconds: 2));
    String? blob;
    try {
      blob = await api.keyPoll(r.code, r.secret);
    } catch (_) {}
    if (blob != null) {
      await adopt(username, link, blob);
      return ensure(username);
    }
  }
  return null;
}

final _codeRe = RegExp(r'^(?:(?:kiks|kicksnap)-(link|keys):)?([A-Za-z0-9]{6})(?:#([A-Za-z0-9_-]{43}))?$', caseSensitive: false);

bool isDeviceCode(String raw) => RegExp(r'^(kiks|kicksnap)-(link|keys):', caseSensitive: false).hasMatch(raw.trim());

/// Signed-in device approving another one: a new sign-in (kiks-link:) or one of our own
/// devices asking for the keys (kiks-keys:). Scanned codes carry the link key; typed ones
/// fetch it from the server, so the person compares the check number first.
/// Returns "device" or "keys".
Future<String> approve(String raw, Future<bool> Function(String check) confirmCheck) async {
  final m = _codeRe.firstMatch(raw.trim());
  if (m == null) throw ApiError(400, "that's not a device code");
  var kind = m.group(1)?.toLowerCase();
  final code = m.group(2)!.toUpperCase();
  var pub = m.group(3);
  if (pub == null) {
    // typed: ask the server, then have the person compare
    if (kind != 'keys') {
      try {
        pub = await api.linkKey(code);
        kind = 'link';
      } catch (_) {}
    }
    if (pub == null && kind != 'link') {
      try {
        pub = await api.keyRequestInfo(code);
        kind = 'keys';
      } catch (_) {}
    }
    if (kind == null) throw ApiError(410, 'that code expired, make a new one');
    if (pub != null && !await confirmCheck(await c.checkNumber(c.unb64(pub)))) throw ApiError(400, 'not approved');
  }
  final ik = (await _loaded())?.ik;
  final blob = ik != null && pub != null ? c.b64(await c.seal(c.unb64(pub), ik, 'link')) : null;
  if (kind == 'keys') {
    if (blob == null) throw ApiError(400, "this device doesn't have the keys to share either");
    await api.keyApprove(code, blob);
    return 'keys';
  }
  await api.linkApprove(code, blob);
  return 'device';
}

// --- other people's keys ------------------------------------------------------------------

final _cache = <String, (DateTime, Map<String, KeyBundle>)>{};
void forgetBundles() => _cache.clear();

Future<Map<String, KeyBundle>> _bundles(List<String> users, List<int> groups) async {
  final k = jsonEncode([[...users]..sort(), [...groups]..sort()]);
  final hit = _cache[k];
  if (hit != null && DateTime.now().difference(hit.$1).inSeconds < 15) return hit.$2;
  final got = await api.bundles(users, groups);
  _cache[k] = (DateTime.now(), got);
  return got;
}

/// Pin a friend's identity key the first time, flag it when it changes.
Future<void> observe(String username, String? ik) async {
  final local = _local;
  if (ik == null || local == null || username == local.account) return;
  final known = keys.value.contacts[username];
  if (known?.ik == ik) return;
  await _setContacts({...keys.value.contacts, username: Contact(ik, changed: known != null)});
}

Future<void> acknowledge(String username) async {
  final k = keys.value.contacts[username];
  if (k != null && k.changed) await _setContacts({...keys.value.contacts, username: k.copy(changed: false)});
}

/// Their QR code carried this key: matches what we have = verified.
Future<bool> verifyContact(String username, String ik) async {
  final k = keys.value.contacts[username];
  if (k != null && k.ik != ik) return false;
  await _setContacts({...keys.value.contacts, username: Contact(ik, verified: true, version: k?.version ?? 0)});
  return true;
}

/// `#<identity key>` for the friend QR, empty until this device has the keys.
Future<String> myQr() async {
  final ik = (await _loaded())?.ik;
  return ik == null ? '' : '#${c.b64(await c.edPub(ik))}';
}

/// Device id -> public key, from the list their identity signed, limited to devices the server still has.
Future<Map<int, Bytes>> _targets(String username, KeyBundle? b) async {
  final out = <int, Bytes>{};
  final local = _local!;
  if (b?.identityKey == null || b!.deviceList == null) return out;
  final ik = c.unb64(b.identityKey!);
  if (!await c.verify(ik, c.unb64(b.deviceList!.sig), b.deviceList!.payload)) return out;
  final parsed = c.parseDeviceList(b.deviceList!.payload);
  if (parsed == null || parsed.username != username) return out;
  if (username == local.account) {
    if (!c.equal(ik, await c.edPub(local.ik!))) return out;
  } else {
    await observe(username, b.identityKey);
    final k = keys.value.contacts[username];
    if (k != null && k.ik == b.identityKey) {
      if (parsed.version < k.version) return out; // an older list than we've already seen: refuse
      if (parsed.version > k.version) await _setContacts({...keys.value.contacts, username: k.copy(version: parsed.version)});
    }
  }
  for (final e in parsed.devices.entries) {
    if (b.devices.containsKey(e.key)) out[e.key] = e.value;
  }
  return out;
}

Bytes _needKeys() {
  final ik = _local?.ik;
  if (ik == null) throw ApiError(0, "this device can't send yet: approve it from your other device (tap your face)");
  return ik;
}

Future<void> _wrapAll(Bytes ck, Bytes sig, Map<int, Bytes> devices, Map<String, String> into) async {
  for (final e in devices.entries) {
    into['${e.key}'] = c.b64(await c.seal(e.value, c.concat([ck, sig]), 'wrap'));
  }
}

int _nowSec() => DateTime.now().millisecondsSinceEpoch ~/ 1000;

// --- snaps ---------------------------------------------------------------------------------

class SealedSnap {
  SealedSnap(this.file, this.overlay, this.envelope, this.keys, this.kind, this.to, this.skipped);
  final Bytes file;
  final Bytes? overlay;
  final String envelope, kind;
  final Map<String, Map<String, String>> keys;

  /// chat keys that will actually get it
  final List<String> to;

  /// direct recipients whose app has no keys yet
  final List<String> skipped;
}

/// Encrypt a snap for chat keys ("u:name", "g:id"). Direct recipients whose app has no keys yet
/// are left out and returned in `skipped`.
Future<SealedSnap> sealSnap(Bytes media, Bytes? overlay, String mime, List<String> to, int seconds) async {
  final ik = _needKeys();
  final local = _local!;
  final users = [for (final k in to) if (k.startsWith('u:')) k.substring(2)];
  final groups = [for (final k in to) if (k.startsWith('g:')) int.parse(k.substring(2))];
  final b = await _bundles(users, groups);
  final kind = mime.startsWith('video') ? 'video' : 'photo';
  final env = c.SnapEnvelope(
    from: local.account,
    ik: c.b64(await c.edPub(ik)),
    sentAt: _nowSec(),
    nonce: c.b64(c.random(16)),
    kind: kind,
    mime: mime,
    seconds: seconds,
    media: await c.shaB64(media),
    overlay: overlay == null ? null : await c.shaB64(overlay),
  );
  final ck = c.random(32);
  final wraps = <String, Map<String, String>>{};
  final skipped = <String>[];
  for (final u in users) {
    final devs = await _targets(u, b[u]);
    if (devs.isEmpty) {
      skipped.add(u);
      continue;
    }
    await _wrapAll(ck, await c.sign(ik, c.snapText(env, 'u:$u')), devs, wraps.putIfAbsent('u', () => {}));
  }
  for (final g in groups) {
    final sig = await c.sign(ik, c.snapText(env, 'g:$g'));
    final into = wraps['g:$g'] = {};
    // the server keeps only the wraps for this group's members
    for (final e in b.entries) {
      if (e.key != local.account) await _wrapAll(ck, sig, await _targets(e.key, e.value), into);
    }
  }
  return SealedSnap(
    await c.aeadSeal(await c.sym(ck, 'media'), media),
    overlay == null ? null : await c.aeadSeal(await c.sym(ck, 'overlay'), overlay),
    c.b64(await c.aeadSeal(await c.sym(ck, 'envelope'), c.utf8Bytes(jsonEncode(env.toJson())))),
    wraps,
    kind,
    [for (final k in to) if (!(k.startsWith('u:') && skipped.contains(k.substring(2)))) k],
    skipped,
  );
}

class OpenedSnap {
  OpenedSnap.ok(this.media, this.overlay, this.kind, this.mime, this.seconds, this.proof) : why = null;
  OpenedSnap.fail(this.why)
      : media = null,
        overlay = null,
        kind = 'photo',
        mime = '',
        seconds = 0,
        proof = null;
  final Bytes? media, overlay;
  final String kind, mime;
  final int seconds;

  /// what a report needs to prove the sender signed it
  final Map<String, dynamic>? proof;

  /// "nokey" (sent before this device was set up) or "bad"
  final String? why;
  bool get ok => why == null;
}

/// Fetch, decrypt and check a snap. `chat` says which conversation it came in, for the signature.
Future<OpenedSnap> openSnap(SnapMeta snap, Chat chat) async {
  final k = await api.snapKey(snap.id);
  if (k['e2e'] != true) {
    // from before E2E; still readable until it burns
    final media = await api.media(snap.id);
    Bytes? overlay;
    if (snap.hasOverlay) {
      try {
        overlay = await api.overlay(snap.id);
      } catch (_) {}
    }
    return OpenedSnap.ok(media, overlay, snap.kind, snap.kind == 'video' ? 'video/mp4' : 'image/jpeg', snap.seconds, null);
  }
  final local = await _loaded();
  if (k['key'] == null || local == null) return OpenedSnap.fail('nokey');
  try {
    final pt = await c.open(local.dk, c.unb64(k['key'] as String), 'wrap');
    final ck = pt.sublist(0, 32);
    final sig = pt.sublist(32);
    final env = c.SnapEnvelope.fromJson(jsonDecode(c.fromUtf8(await c.aeadOpen(await c.sym(ck, 'envelope'), c.unb64(k['envelope'] as String)))) as Json);
    final to = chat.group ? chat.key : 'u:${local.account}';
    if (env == null || env.from != k['sender'] || !await c.verify(c.unb64(env.ik), sig, c.snapText(env, to))) return OpenedSnap.fail('bad');
    await observe(env.from, env.ik);
    final media = await c.aeadOpen(await c.sym(ck, 'media'), await api.media(snap.id));
    if (await c.shaB64(media) != env.media) return OpenedSnap.fail('bad');
    Bytes? overlay;
    if (env.overlay != null) {
      overlay = await c.aeadOpen(await c.sym(ck, 'overlay'), await api.overlay(snap.id));
      if (await c.shaB64(overlay) != env.overlay) return OpenedSnap.fail('bad');
    }
    return OpenedSnap.ok(media, overlay, env.kind, env.mime, env.seconds, {
      'snap_id': snap.id,
      'sent_at': env.sentAt,
      'nonce': env.nonce,
      'kind': env.kind,
      'mime': env.mime,
      'seconds': env.seconds,
      'overlay': env.overlay,
      'sig': c.b64(sig),
    });
  } catch (_) {
    return OpenedSnap.fail('bad');
  }
}

// --- texts ---------------------------------------------------------------------------------

/// Encrypt a text for a chat ("u:name" or "g:id"): their devices and all of mine.
Future<({String body, Map<String, String> keys})> sealText(String chatKey, String body) async {
  final ik = _needKeys();
  final local = _local!;
  final kind = chatKey.substring(0, 1);
  final ident = chatKey.substring(2);
  final b = await _bundles(kind == 'u' ? [ident, local.account] : [local.account], kind == 'g' ? [int.parse(ident)] : []);
  final env = c.TextEnvelope(from: local.account, ik: c.b64(await c.edPub(ik)), sentAt: _nowSec(), nonce: c.b64(c.random(16)), body: body);
  final ck = c.random(32);
  final sig = await c.sign(ik, await c.textText(env, chatKey));
  final wraps = <String, String>{};
  for (final e in b.entries) {
    final devs = await _targets(e.key, e.value);
    if (kind == 'u' && e.key == ident && devs.isEmpty) throw ApiError(0, '@$ident needs to update Kiks before you can chat');
    await _wrapAll(ck, sig, devs, wraps);
  }
  return (body: c.b64(await c.aeadSeal(await c.sym(ck, 'envelope'), c.utf8Bytes(jsonEncode(env.toJson())))), keys: wraps);
}

/// (body, proof) or throws.
Future<(String, TextProof)> _openText(String body, String? key, String from, String to) async {
  final local = _local!;
  final pt = await c.open(local.dk, c.unb64(key!), 'wrap');
  final ck = pt.sublist(0, 32);
  final sig = pt.sublist(32);
  final env = c.TextEnvelope.fromJson(jsonDecode(c.fromUtf8(await c.aeadOpen(await c.sym(ck, 'envelope'), c.unb64(body)))) as Json);
  if (env == null || env.from != from || !await c.verify(c.unb64(env.ik), sig, await c.textText(env, to))) throw const FormatException('bad');
  await observe(env.from, env.ik);
  return (env.body, TextProof(env.sentAt, env.nonce, c.b64(sig)));
}

/// Decrypt a thread. In a 1:1 the signature names the recipient; in a group, the group.
Future<List<Message>> openTexts(Chat chat, List<Message> messages) async {
  if (messages.any((m) => m.e2e)) await _loaded();
  return Future.wait(messages.map((m) async {
    if (!m.e2e) return m;
    if (m.key == null || _local == null) return m.lock('nokey');
    final to = chat.group ? chat.key : (m.mine ? chat.key : 'u:${_local!.account}');
    try {
      final (body, proof) = await _openText(m.body, m.key, m.from, to);
      return m.opened(body, proof);
    } catch (_) {
      return m.lock('bad');
    }
  }));
}

/// Their texts offered as proof in a report; the server says which conversation each was in.
Future<List<TheirText>> openTheirTexts(String from, List<TheirText> texts) async {
  await _loaded();
  final out = <TheirText>[];
  for (final t in texts) {
    if (!t.e2e) {
      out.add(t);
      continue;
    }
    if (t.key == null || _local == null) continue;
    try {
      final (body, proof) = await _openText(t.body, t.key, from, t.to ?? '');
      out.add(t.opened(body, proof));
    } catch (_) {}
  }
  return out;
}
