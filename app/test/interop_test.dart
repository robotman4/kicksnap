// End-to-end against a real Kiks server: two (then three) simulated devices sign up, link,
// friend each other and exchange encrypted snaps and texts through the actual API.
// The server checks the signed device lists and report proofs with its own (Python) crypto,
// so this also proves the Dart client interoperates with it.
//
// Skipped unless KIKS_TEST_SERVER is set, e.g.:
//   (cd backend && DATA_DIR=$(mktemp -d) uvicorn app.main:app --port 8765) &
//   KIKS_TEST_SERVER=http://127.0.0.1:8765 KIKS_TEST_DATA=<that dir> flutter test test/interop_test.dart
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:kiks/api.dart';
import 'package:kiks/crypto.dart' as c;
import 'package:kiks/e2e.dart' as e2e;
import 'package:kiks/models.dart';
import 'package:kiks/store.dart';

class Dev {
  Dev(this.name);
  final String name;
  final mem = <String, String>{};
  String? token;
}

final server = Platform.environment['KIKS_TEST_SERVER'];

Future<void> use(Dev d) async {
  Store.memory = d.mem;
  api.token = d.token;
  await e2e.switchDevice();
}

void keep(Dev d) => d.token = api.token;

Future<void> signUp(Dev d) async {
  await use(d);
  await api.startFresh();
  keep(d);
  await api.pickName(d.name);
  final k = await e2e.ensure(d.name);
  expect(k.ready, isTrue);
}

void main() {
  final skip = server == null ? 'set KIKS_TEST_SERVER to run' : null;
  final tag = DateTime.now().millisecondsSinceEpoch % 100000;
  final alice = Dev('alice$tag'), bob = Dev('bob$tag'), alice2 = Dev('alice$tag');

  setUpAll(() {
    api.server = server ?? '';
  });

  test('sign up two accounts with keys', () async {
    await signUp(alice);
    await signUp(bob);
    await use(alice);
    final me = await api.keysMe();
    expect(me.identityKey, isNotNull);
    expect(me.deviceList, isNotNull);
  }, skip: skip);

  test('friends', () async {
    await use(alice);
    expect((await api.addFriend(bob.name)).status, 'requested');
    await use(bob);
    expect((await api.addFriend(alice.name)).status, 'friends');
  }, skip: skip);

  test('snap: alice -> bob, decrypted and verified on bob', () async {
    final media = Uint8List.fromList(utf8.encode('not really a jpeg ${DateTime.now()}'));
    final overlay = Uint8List.fromList([1, 2, 3, 4]);
    await use(alice);
    final s = await e2e.sealSnap(media, overlay, 'image/jpeg', ['u:${bob.name}'], 5);
    expect(s.skipped, isEmpty);
    await api.sendSnap(file: s.file, overlay: s.overlay, envelope: s.envelope, keys: s.keys, kind: s.kind, to: s.to, seconds: 5);

    await use(bob);
    final chat = (await api.chats()).firstWhere((x) => x.key == 'u:${alice.name}');
    expect(chat.snaps, hasLength(1));
    final o = await e2e.openSnap(chat.snaps.first, chat);
    expect(o.ok, isTrue, reason: o.why);
    expect(o.media, media);
    expect(o.overlay, overlay);
    expect(o.seconds, 5);
    expect(e2e.keys.value.contacts[alice.name], isNotNull); // pinned on first sight
  }, skip: skip);

  test('texts both ways, readable on the sender too', () async {
    await use(alice);
    final t = await e2e.sealText('u:${bob.name}', 'hej 👋 åäö');
    await api.say('u:${bob.name}', t.body, t.keys);
    final mine = await e2e.openTexts(Chat(key: 'u:${bob.name}', name: bob.name, color: '#fff', group: false), (await api.messages('u:${bob.name}')).messages);
    expect(mine.last.body, 'hej 👋 åäö');
    expect(mine.last.locked, isNull);

    await use(bob);
    final chat = Chat(key: 'u:${alice.name}', name: alice.name, color: '#fff', group: false);
    final got = await e2e.openTexts(chat, (await api.messages(chat.key)).messages);
    expect(got.last.body, 'hej 👋 åäö');
    expect(got.last.proof, isNotNull);
  }, skip: skip);

  test('group snap and text', () async {
    await use(alice);
    final g = await api.newGroup('crew', [bob.name]);
    final media = Uint8List.fromList(List.generate(300000, (i) => i % 251)); // bigger than one AES block run
    final s = await e2e.sealSnap(media, null, 'video/mp4', [g.key], 0);
    await api.sendSnap(file: s.file, envelope: s.envelope, keys: s.keys, kind: s.kind, to: s.to, seconds: 0);
    final t = await e2e.sealText(g.key, 'group hej');
    await api.say(g.key, t.body, t.keys);

    await use(bob);
    final chat = (await api.chats()).firstWhere((x) => x.key == g.key);
    final o = await e2e.openSnap(chat.snaps.first, chat);
    expect(o.ok, isTrue, reason: o.why);
    expect(o.kind, 'video');
    expect(o.media, media);
    final texts = await e2e.openTexts(chat, (await api.messages(g.key)).messages);
    expect(texts.last.body, 'group hej');
  }, skip: skip);

  test('link a second device by QR: it gets the identity key and can read', () async {
    await use(alice2);
    final key = await e2e.newLinkKey();
    final l = await api.linkStart(key.pub);
    final qr = 'kiks-link:${l.code}#${key.pub}';

    await use(alice);
    expect(await e2e.approve(qr, (_) async => fail('scanned codes need no check')), 'device');

    await use(alice2);
    final r = await api.linkPoll(l.code, l.secret);
    expect(r.approved, isTrue);
    keep(alice2);
    await e2e.adopt(alice.name, key, r.keyBlob);
    final k = await e2e.ensure(alice.name);
    expect(k.ready, isTrue);
    expect(k.locked, isFalse);

    // bob now encrypts to both of alice's devices
    await use(bob);
    final t = await e2e.sealText('u:${alice.name}', 'to both');
    expect(t.keys, hasLength(3)); // alice x2 + bob's own
    await api.say('u:${alice.name}', t.body, t.keys);

    await use(alice2);
    final chat = Chat(key: 'u:${bob.name}', name: bob.name, color: '#fff', group: false);
    final got = await e2e.openTexts(chat, (await api.messages(chat.key)).messages);
    expect(got.last.body, 'to both');
    // sent before this device existed: shown as locked, not as garbage
    expect(got.first.locked, 'nokey');
  }, skip: skip);

  test('report with signed proof is accepted', () async {
    await use(bob);
    final texts = await e2e.openTheirTexts(alice.name, await api.reportTexts(alice.name));
    expect(texts.where((t) => t.proof != null), isNotEmpty);
    await api.report(username: alice.name, reason: 'spam', note: 'interop test', block: false, texts: texts.take(2).toList());
  }, skip: skip);

  test('fingerprints match across devices of one account', () async {
    await use(alice);
    final a = (await e2e.ensure(alice.name)).fingerprint;
    await use(alice2);
    final b = (await e2e.ensure(alice.name)).fingerprint;
    expect(a, b);
    final me = await api.keysMe();
    expect(c.parseDeviceList(me.deviceList!.payload)!.devices, hasLength(2));
  }, skip: skip);

  test("a verified friend's new key holds their texts until you ok it", () async {
    await use(alice);
    final ik = (await api.bundles([bob.name], []))[bob.name]!.identityKey!;
    expect(await e2e.verifyContact(bob.name, ik), isTrue);

    await use(bob);
    await e2e.resetIdentity(bob.name);
    final t = await e2e.sealText('u:${alice.name}', 'new phone who dis');
    await api.say('u:${alice.name}', t.body, t.keys);

    await use(alice);
    final chat = Chat(key: 'u:${bob.name}', name: bob.name, color: '#fff', group: false);
    var got = await e2e.openTexts(chat, (await api.messages(chat.key)).messages);
    expect(got.last.locked, 'changed');
    expect(e2e.keys.value.contacts[bob.name]!.held, isTrue);
    await expectLater(e2e.sealText(chat.key, 'hi?'), throwsA(isA<ApiError>()));

    await e2e.acknowledge(bob.name);
    got = await e2e.openTexts(chat, (await api.messages(chat.key)).messages);
    expect(got.last.body, 'new phone who dis');
  }, skip: skip);
}
