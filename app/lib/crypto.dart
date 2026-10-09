/// The E2E building blocks from docs/e2e.md: pure functions over bytes, no app state.
/// Same protocol as frontend/src/lib/crypto.ts, checked against docs/e2e-vectors.json
/// by test/crypto_test.dart.
library;

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

typedef Bytes = Uint8List;

final _rng = Random.secure();
final _x = X25519();
final _ed = Ed25519();
final _aes = AesGcm.with256bits();
final _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);

Bytes utf8Bytes(String s) => Uint8List.fromList(utf8.encode(s));
String fromUtf8(List<int> b) => utf8.decode(b);

Bytes random(int n) => Uint8List.fromList(List<int>.generate(n, (_) => _rng.nextInt(256)));

/// base64url without padding, everywhere in the protocol.
String b64(List<int> b) => base64Url.encode(b).replaceAll('=', '');

Bytes unb64(String s) => base64Url.decode(s + '=' * ((4 - s.length % 4) % 4));

Bytes concat(List<List<int>> parts) {
  final out = BytesBuilder(copy: false);
  for (final p in parts) {
    out.add(p);
  }
  return out.toBytes();
}

bool equal(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) {
    d |= a[i] ^ b[i];
  }
  return d == 0;
}

Future<Bytes> sha256(List<int> data) async => Uint8List.fromList((await Sha256().hash(data)).bytes);

Future<String> shaB64(List<int> data) async => b64(await sha256(data));

/// HKDF-SHA256, 32 bytes. An empty salt is HKDF's default (HMAC pads the key with zeros).
Future<Bytes> hkdf(List<int> ikm, List<int> salt, String info) async {
  final k = await _hkdf.deriveKey(secretKey: SecretKey(ikm), nonce: salt, info: utf8Bytes(info));
  return Uint8List.fromList(await k.extractBytes());
}

/// nonce(12) || AES-256-GCM ciphertext || tag(16)
Future<Bytes> aeadSeal(List<int> key, List<int> pt, {List<int>? nonce}) async {
  final box = await _aes.encrypt(pt, secretKey: SecretKey(key), nonce: nonce ?? random(12));
  return concat([box.nonce, box.cipherText, box.mac.bytes]);
}

Future<Bytes> aeadOpen(List<int> key, Bytes blob) async {
  if (blob.length < 28) throw const FormatException('too short');
  final box = SecretBox(
    blob.sublist(12, blob.length - 16),
    nonce: blob.sublist(0, 12),
    mac: Mac(blob.sublist(blob.length - 16)),
  );
  return Uint8List.fromList(await _aes.decrypt(box, secretKey: SecretKey(key)));
}

Future<Bytes> sym(List<int> ck, String label) => hkdf(ck, const [], 'kiks/1 $label');

// --- keys --------------------------------------------------------------------------

class XKey {
  XKey(this.priv, this.pub);
  final Bytes priv;
  final Bytes pub;
}

Future<Bytes> xPub(List<int> priv) async {
  final kp = await _x.newKeyPairFromSeed(priv);
  return Uint8List.fromList((await kp.extractPublicKey()).bytes);
}

Future<XKey> newX() async {
  final priv = random(32);
  return XKey(priv, await xPub(priv));
}

Bytes newSeed() => random(32);

Future<Bytes> edPub(List<int> seed) async {
  final kp = await _ed.newKeyPairFromSeed(seed);
  return Uint8List.fromList((await kp.extractPublicKey()).bytes);
}

Future<Bytes> sign(List<int> seed, String text) async {
  final kp = await _ed.newKeyPairFromSeed(seed);
  return Uint8List.fromList((await _ed.sign(utf8Bytes(text), keyPair: kp)).bytes);
}

Future<bool> verify(List<int> pub, List<int> sig, String text) async {
  if (pub.length != 32 || sig.length != 64) return false;
  try {
    return await _ed.verify(
      utf8Bytes(text),
      signature: Signature(sig, publicKey: SimplePublicKey(pub, type: KeyPairType.ed25519)),
    );
  } catch (_) {
    return false;
  }
}

Future<Bytes> _shared(List<int> priv, List<int> pub) async {
  final kp = await _x.newKeyPairFromSeed(priv);
  final s = await _x.sharedSecretKey(keyPair: kp, remotePublicKey: SimplePublicKey(pub, type: KeyPairType.x25519));
  final out = Uint8List.fromList(await s.extractBytes());
  if (out.every((b) => b == 0)) throw const FormatException('bad key');
  return out;
}

/// Anonymous box to an X25519 public key: eph.pub(32) || nonce || ciphertext || tag.
Future<Bytes> seal(List<int> pub, List<int> pt, String label, {List<int>? eph, List<int>? nonce}) async {
  final e = eph ?? random(32);
  final ePub = await xPub(e);
  final key = await hkdf(await _shared(e, pub), concat([ePub, pub]), 'kiks/1 $label');
  return concat([ePub, await aeadSeal(key, pt, nonce: nonce)]);
}

Future<Bytes> open(List<int> priv, Bytes blob, String label) async {
  final ePub = blob.sublist(0, 32);
  final key = await hkdf(await _shared(priv, ePub), concat([ePub, await xPub(priv)]), 'kiks/1 $label');
  return aeadOpen(key, blob.sublist(32));
}

// --- signed texts ------------------------------------------------------------------

String deviceListText(String username, int version, Map<int, Bytes> devices) {
  final ids = devices.keys.toList()..sort();
  return ['kiks/1 devices', username, '$version', for (final id in ids) '$id ${b64(devices[id]!)}'].join('\n');
}

class DeviceList {
  DeviceList(this.username, this.version, this.devices);
  final String username;
  final int version;
  final Map<int, Bytes> devices;
}

final _digits = RegExp(r'^\d+$');

DeviceList? parseDeviceList(String payload) {
  final lines = payload.split('\n');
  if (lines.length < 3 || lines[0] != 'kiks/1 devices' || !_digits.hasMatch(lines[2])) return null;
  final devices = <int, Bytes>{};
  for (final line in lines.skip(3)) {
    final parts = line.split(' ');
    if (parts.length < 2 || !_digits.hasMatch(parts[0]) || parts[1].isEmpty) return null;
    final Bytes k;
    try {
      k = unb64(parts[1]);
    } catch (_) {
      return null;
    }
    if (k.length != 32) return null;
    devices[int.parse(parts[0])] = k;
  }
  return DeviceList(lines[1], int.parse(lines[2]), devices);
}

/// A snap's envelope (docs/e2e.md). Encrypted as JSON, signed as lines.
class SnapEnvelope {
  SnapEnvelope({
    required this.from,
    required this.ik,
    required this.sentAt,
    required this.nonce,
    required this.kind,
    required this.mime,
    required this.seconds,
    required this.media,
    required this.overlay,
  });
  final String from, ik, nonce, kind, mime, media;
  final int sentAt, seconds;
  final String? overlay;

  Map<String, dynamic> toJson() => {
        'v': 1,
        'type': 'snap',
        'from': from,
        'ik': ik,
        'sent_at': sentAt,
        'nonce': nonce,
        'kind': kind,
        'mime': mime,
        'seconds': seconds,
        'media': media,
        'overlay': overlay,
      };

  static SnapEnvelope? fromJson(Map<String, dynamic> j) {
    if (j['v'] != 1 || j['type'] != 'snap') return null;
    return SnapEnvelope(
      from: j['from'] as String,
      ik: j['ik'] as String,
      sentAt: (j['sent_at'] as num).toInt(),
      nonce: j['nonce'] as String,
      kind: j['kind'] as String,
      mime: j['mime'] as String,
      seconds: (j['seconds'] as num).toInt(),
      media: j['media'] as String,
      overlay: j['overlay'] as String?,
    );
  }
}

class TextEnvelope {
  TextEnvelope({required this.from, required this.ik, required this.sentAt, required this.nonce, required this.body});
  final String from, ik, nonce, body;
  final int sentAt;

  Map<String, dynamic> toJson() =>
      {'v': 1, 'type': 'text', 'from': from, 'ik': ik, 'sent_at': sentAt, 'nonce': nonce, 'body': body};

  static TextEnvelope? fromJson(Map<String, dynamic> j) {
    if (j['v'] != 1 || j['type'] != 'text') return null;
    return TextEnvelope(
      from: j['from'] as String,
      ik: j['ik'] as String,
      sentAt: (j['sent_at'] as num).toInt(),
      nonce: j['nonce'] as String,
      body: j['body'] as String,
    );
  }
}

String snapText(SnapEnvelope e, String to) => [
      'kiks/1 snap',
      e.from,
      to,
      '${e.sentAt}',
      e.nonce,
      e.kind,
      e.mime,
      '${e.seconds}',
      e.media,
      e.overlay ?? '-',
    ].join('\n');

Future<String> textText(TextEnvelope e, String to) async =>
    ['kiks/1 text', e.from, to, '${e.sentAt}', e.nonce, await shaB64(utf8Bytes(e.body))].join('\n');

/// Six digits both screens show while linking, for when the code was typed instead of scanned.
Future<String> checkNumber(List<int> linkPub) async {
  final h = await sha256(linkPub);
  return (((h[0] << 16) | (h[1] << 8) | h[2]) % 1000000).toString().padLeft(6, '0');
}

Future<String> fingerprint(List<int> ikPub) async {
  final hex = (await sha256(ikPub)).sublist(0, 10).map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return [for (var i = 0; i < hex.length; i += 4) hex.substring(i, i + 4)].join(' ');
}
