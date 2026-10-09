// The Dart crypto against docs/e2e-vectors.json (made by the Python reference in backend/tests).
// Run: flutter test
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:kiks/crypto.dart' as c;

void main() {
  final v = jsonDecode(File('../docs/e2e-vectors.json').readAsStringSync()) as Map<String, dynamic>;
  final u = c.unb64;
  List<Map<String, dynamic>> all(String k) => (v[k] as List).cast<Map<String, dynamic>>();

  test('x25519 public keys', () async {
    for (final k in all('x25519')) {
      expect(c.b64(await c.xPub(u(k['priv']))), k['pub']);
    }
  });

  test('hkdf', () async {
    for (final k in all('hkdf')) {
      expect(c.b64(await c.hkdf(u(k['ikm']), u(k['salt']), k['info'])), k['out']);
    }
  });

  test('ed25519', () async {
    for (final k in all('sign')) {
      expect(c.b64(await c.edPub(u(k['seed']))), k['pub']);
      expect(c.b64(await c.sign(u(k['seed']), k['text'])), k['sig']);
      expect(await c.verify(u(k['pub']), u(k['sig']), k['text']), isTrue);
      expect(await c.verify(u(k['pub']), u(k['sig']), '${k['text']}!'), isFalse);
    }
  });

  test('seal / open', () async {
    for (final k in all('seal')) {
      final out = await c.seal(u(k['pub']), u(k['plaintext']), k['label'], eph: u(k['eph']), nonce: u(k['nonce']));
      expect(c.b64(out), k['out']);
      expect(c.b64(await c.open(u(k['priv']), u(k['out']), k['label'])), k['plaintext']);
    }
  });

  test('device list', () async {
    for (final k in all('device_list')) {
      expect(await c.verify(u(k['identity_key']), u(k['sig']), k['payload']), isTrue);
      final p = c.parseDeviceList(k['payload'])!;
      expect(c.deviceListText(p.username, p.version, p.devices), k['payload']);
    }
  });

  test('snap: unwrap, envelope, signature, media', () async {
    for (final k in all('snap')) {
      final pt = await c.open(u(k['device_priv']), u(k['wrap']), 'wrap');
      final ck = pt.sublist(0, 32), sig = pt.sublist(32);
      expect(c.b64(ck), k['content_key']);
      expect(c.b64(sig), k['sig']);
      final json = jsonDecode(c.fromUtf8(await c.aeadOpen(await c.sym(ck, 'envelope'), u(k['envelope_cipher']))));
      expect(json, k['envelope']);
      final env = c.SnapEnvelope.fromJson(json)!;
      expect(c.snapText(env, k['to']), k['signed_text']);
      expect(await c.verify(u(env.ik), sig, c.snapText(env, k['to'])), isTrue);
      expect(await c.verify(u(env.ik), sig, c.snapText(env, 'u:mallory')), isFalse);
      final media = await c.aeadOpen(await c.sym(ck, 'media'), u(k['media_cipher']));
      expect(c.b64(media), k['media_plain']);
      expect(await c.shaB64(media), env.media);
      // what we send has to round-trip through the same JSON shape
      expect(env.toJson(), k['envelope']);
    }
  });

  test('text signed text', () async {
    for (final k in all('text')) {
      final env = c.TextEnvelope.fromJson(k['envelope'])!;
      expect(await c.textText(env, k['to']), k['signed_text']);
      expect(await c.verify(u(env.ik), u(k['sig']), k['signed_text']), isTrue);
    }
  });

  test('check number and fingerprint', () async {
    for (final k in all('check_number')) {
      expect(await c.checkNumber(u(k['link_key'])), k['check']);
    }
    for (final k in all('fingerprint')) {
      expect(await c.fingerprint(u(k['identity_key'])), k['fingerprint']);
    }
  });

  test('roundtrip with fresh keys', () async {
    final d = await c.newX();
    final blob = await c.seal(d.pub, c.utf8Bytes('hej'), 'wrap');
    expect(c.fromUtf8(await c.open(d.priv, blob, 'wrap')), 'hej');
    final other = await c.newX();
    expect(() => c.open(other.priv, blob, 'wrap'), throwsA(anything));
  });
}
