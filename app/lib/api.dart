/// The Kiks server API (/api/v1, bearer auth). Same calls as frontend/src/lib/api.ts.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/io.dart';

import 'models.dart';
import 'store.dart';

class ApiError implements Exception {
  ApiError(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => message;
}

/// A file part for multipart uploads.
class Part {
  Part(this.field, this.bytes, this.filename, {this.type = 'application/octet-stream'});
  final String field, filename, type;
  final List<int> bytes;
}

/// Plain http is only for a server on your own network: the device token would cross the internet in the clear.
bool cleartextOk(String server) {
  final u = Uri.tryParse(server);
  if (u == null || u.scheme != 'http') return u?.scheme == 'https';
  final h = u.host.toLowerCase();
  if (h == 'localhost' || h.endsWith('.local') || h == '::1' || h == '10.0.2.2') return true;
  final ip = h.split('.').map(int.tryParse).toList();
  if (ip.length != 4 || ip.any((n) => n == null || n < 0 || n > 255)) return false;
  final (a, b) = (ip[0]!, ip[1]!);
  return a == 10 || a == 127 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 100 && b >= 64 && b <= 127);
}

/// "kiks.example.com" -> "https://kiks.example.com". Plain http only when typed out (LAN testing).
String normalizeServer(String raw) {
  var s = raw.trim();
  if (s.isEmpty) return s;
  if (!s.startsWith('http://') && !s.startsWith('https://')) s = 'https://$s';
  return s.replaceAll(RegExp(r'/+$'), '');
}

class Api {
  final _client = http.Client();
  String server = '';
  String? token;

  static const agent = 'Kiks/1.0 (Android; Flutter)';

  Uri _uri(String path, [Map<String, String>? query]) => Uri.parse('$server/api/v1$path').replace(queryParameters: query);

  Map<String, String> _headers({bool json = false, bool wantToken = false}) => {
        'User-Agent': Platform.isIOS ? 'Kiks/1.0 (iPhone; Flutter)' : agent,
        if (token != null) 'Authorization': 'Bearer $token',
        if (json) 'Content-Type': 'application/json',
        // sign-in calls hand the device secret back in the body instead of a cookie
        if (wantToken) 'X-Kiks-Auth': 'bearer',
      };

  Future<dynamic> _send(String method, String path,
      {Object? body, Map<String, String>? query, Map<String, String>? headers, bool wantToken = false, bool raw = false}) async {
    final req = http.Request(method, _uri(path, query))
      ..headers.addAll(_headers(json: body != null, wantToken: wantToken))
      ..headers.addAll(headers ?? const {});
    if (body != null) req.body = jsonEncode(body);
    final http.StreamedResponse res;
    try {
      res = await _client.send(req).timeout(const Duration(seconds: 30));
    } on TimeoutException {
      throw ApiError(0, "can't reach the server");
    } on SocketException {
      throw ApiError(0, "can't reach the server");
    } on HandshakeException {
      throw ApiError(0, "the server's certificate isn't valid");
    }
    final bytes = await res.stream.toBytes();
    return _decode(res.statusCode, res.headers['content-type'] ?? '', bytes, raw);
  }

  dynamic _decode(int status, String type, Uint8List bytes, bool raw) {
    if (status >= 400) {
      var msg = 'something broke';
      try {
        final d = jsonDecode(utf8.decode(bytes))['detail'];
        if (d is String) msg = d;
      } catch (_) {}
      if (status == 401 && msg == 'something broke') msg = 'not signed in';
      throw ApiError(status, msg);
    }
    if (raw) return bytes;
    if (type.contains('json')) return jsonDecode(utf8.decode(bytes));
    return bytes;
  }

  Future<dynamic> get(String path, [Map<String, String>? query]) => _send('GET', path, query: query);
  Future<dynamic> post(String path, [Object? body]) => _send('POST', path, body: body ?? const {});
  Future<dynamic> put(String path, Object body) => _send('PUT', path, body: body);
  Future<dynamic> patch(String path, Object body) => _send('PATCH', path, body: body);
  Future<dynamic> delete(String path, [Object? body]) => _send('DELETE', path, body: body);

  Future<dynamic> multipart(String path, Map<String, String> fields, List<Part> files, {List<MapEntry<String, String>> repeated = const []}) async {
    final req = http.MultipartRequest('POST', _uri(path))..headers.addAll(_headers());
    req.fields.addAll(fields);
    for (final f in files) {
      req.files.add(http.MultipartFile.fromBytes(f.field, f.bytes, filename: f.filename));
    }
    // repeated text fields (message_ids): a part without a filename is a plain form field
    for (final e in repeated) {
      req.files.add(http.MultipartFile.fromBytes(e.key, utf8.encode(e.value)));
    }
    final res = await _client.send(req).timeout(const Duration(minutes: 3));
    return _decode(res.statusCode, res.headers['content-type'] ?? '', await res.stream.toBytes(), false);
  }

  // --- sign-in --------------------------------------------------------------------

  Future<User> me() async => User.fromJson(await get('/me'));

  /// "I'm new": a fresh account for this device. Keeps the bearer token it hands back.
  Future<User> startFresh() async {
    final r = await _send('POST', '/devices/new', body: const {}, wantToken: true) as Json;
    await _keepToken(r);
    return User.fromJson(r);
  }

  Future<void> _keepToken(Json r) async {
    final t = r['token'] as String?;
    if (t == null) throw ApiError(500, "the server didn't hand out a device token (is it older than 1.0?)");
    token = t;
    await Store.setToken(t);
  }

  // Passkeys: the server checks the origin a passkey signed for, so these send this server's address as
  // Origin the way a browser would (the signature itself carries the app's own origin).
  Map<String, String> get _origin => {'Origin': Uri.parse(server).origin};

  Future<({String id, String options})> passkeyBegin(String what) async {
    final r = await _send('POST', '/passkeys/$what/begin', body: const {}, headers: _origin) as Json;
    return (id: r['challenge_id'] as String, options: r['options'] as String);
  }

  Future<void> passkeyRegisterFinish(String id, Object credential) =>
      _send('POST', '/passkeys/register/finish', body: {'challenge_id': id, 'credential': credential}, headers: _origin);

  Future<User> passkeyLoginFinish(String id, Object credential) async {
    final r = await _send('POST', '/passkeys/login/finish', body: {'challenge_id': id, 'credential': credential}, headers: _origin, wantToken: true) as Json;
    await _keepToken(r);
    return User.fromJson(r);
  }

  Future<({bool free, bool valid})> nameFree(String name) async {
    final r = await get('/names/${Uri.encodeComponent(name)}');
    return (free: r['free'] == true, valid: r['valid'] == true);
  }

  Future<User> pickName(String username) async => User.fromJson(await post('/me/name', {'username': username}));
  Future<void> logout() async => post('/auth/logout');
  Future<User> setColor(String color) async => User.fromJson(await patch('/me', {'color': color}));

  Future<({String code, String secret, int expiresIn})> linkStart(String linkKey) async {
    final r = await post('/link/start', {'link_key': linkKey});
    return (code: r['code'] as String, secret: r['secret'] as String, expiresIn: (r['expires_in'] as num).toInt());
  }

  /// The new device's poll. Once approved it carries the sign-in and the sealed identity key.
  Future<({bool approved, User? user, String? keyBlob})> linkPoll(String code, String secret) async {
    // the poll secret goes in a header, so it stays out of proxy access logs
    final r = await _send('GET', '/link/$code', headers: {'X-Kiks-Secret': secret}, wantToken: true) as Json;
    if (r['approved'] != true) return (approved: false, user: null, keyBlob: null);
    await _keepToken(r);
    return (approved: true, user: User.fromJson(r['user'] as Json), keyBlob: r['key_blob'] as String?);
  }

  Future<String?> linkKey(String code) async => (await get('/link/${Uri.encodeComponent(code)}/key'))['link_key'] as String?;
  Future<void> linkApprove(String code, String? keyBlob) => post('/link/${Uri.encodeComponent(code)}/approve', {'key_blob': keyBlob});

  // --- keys ---------------------------------------------------------------------------

  Future<MyKeys> keysMe() async => MyKeys.fromJson(await get('/keys/me'));
  Future<void> putIdentity(String identityKey, {bool replace = false}) => put('/keys/identity', {'identity_key': identityKey, 'replace': replace});
  Future<void> putDevice(String encKey) => put('/keys/device', {'enc_key': encKey});
  Future<void> putDevices(String payload, String sig) => put('/keys/devices', {'payload': payload, 'sig': sig});

  Future<Map<String, KeyBundle>> bundles(List<String> users, List<int> groups) async {
    final r = await get('/keys', {'users': users.join(','), 'groups': groups.join(',')});
    return {for (final e in (r['users'] as Map).entries) e.key as String: KeyBundle.fromJson(e.value as Json)};
  }

  Future<({String code, String secret, int expiresIn})> keyRequest(String linkKey) async {
    final r = await post('/keys/requests', {'link_key': linkKey});
    return (code: r['code'] as String, secret: r['secret'] as String, expiresIn: (r['expires_in'] as num).toInt());
  }

  Future<String> keyRequestInfo(String code) async => (await get('/keys/requests/${Uri.encodeComponent(code)}'))['link_key'] as String;
  Future<void> keyApprove(String code, String blob) => post('/keys/requests/${Uri.encodeComponent(code)}/approve', {'key_blob': blob});
  Future<String?> keyPoll(String code, String secret) async =>
      (await _send('GET', '/keys/requests/${Uri.encodeComponent(code)}/poll', headers: {'X-Kiks-Secret': secret}))['key_blob'] as String?;

  // --- devices, friends, blocks ---------------------------------------------------------

  Future<({List<Device> devices, int passkeys})> devices() async {
    final r = await get('/devices') as Json;
    return (devices: (r['devices'] as List).map((d) => Device.fromJson(d as Json)).toList(), passkeys: (r['passkeys'] as int?) ?? 0);
  }
  Future<void> removeDevice(int id) => delete('/devices/$id');

  Future<FriendLists> friends() async => FriendLists.fromJson(await get('/friends'));
  Future<({String username, String status})> addFriend(String username) async {
    final r = await post('/friends', {'username': username});
    return (username: r['username'] as String, status: r['status'] as String);
  }

  Future<void> removeFriend(String u) => delete('/friends/${Uri.encodeComponent(u)}');
  Future<List<Friend>> blocks() async => ((await get('/blocks')) as List).map((f) => Friend.fromJson(f as Json)).toList();
  Future<void> block(String u) => post('/blocks', {'username': u});
  Future<void> unblock(String u) => delete('/blocks/${Uri.encodeComponent(u)}');
  Future<void> deleteAccount(String username) => delete('/me', {'username': username});

  Future<Suspension> suspension() async => Suspension.fromJson(await get('/appeal'));
  Future<void> appeal(String body) => post('/appeal', {'body': body});

  // --- chats, snaps, texts ------------------------------------------------------------

  Future<List<Chat>> chats() async => ((await get('/chats')) as List).map((c) => Chat.fromJson(c as Json)).toList();

  /// An encrypted snap. `to` holds chat keys: friends and groups in one list.
  Future<void> sendSnap({required List<int> file, List<int>? overlay, required String envelope, required Object keys, required String kind, required List<String> to, required int seconds}) =>
      multipart('/snaps', {
        'to': to.where((k) => k.startsWith('u:')).map((k) => k.substring(2)).join(','),
        'groups': to.where((k) => k.startsWith('g:')).map((k) => k.substring(2)).join(','),
        'seconds': '$seconds',
        'kind': kind,
        'envelope': envelope,
        'keys': jsonEncode(keys),
      }, [
        Part('file', file, 'snap'),
        if (overlay != null) Part('overlay', overlay, 'overlay'),
      ]);

  Future<Json> snapKey(String id) async => await get('/snaps/$id/key') as Json;
  Future<Uint8List> media(String id) async => await _send('GET', '/snaps/$id/media', raw: true) as Uint8List;
  Future<Uint8List> overlay(String id) async => await _send('GET', '/snaps/$id/overlay', raw: true) as Uint8List;
  Future<void> openSnap(String id) => post('/snaps/$id/open');

  Future<({List<Message> messages, int seenAt})> messages(String key) async {
    final r = await get('/chats/${Uri.encodeComponent(key)}/messages');
    return (
      messages: (r['messages'] as List).map((m) => Message.fromJson(m as Json)).toList(),
      seenAt: ((r['seen_at'] as num?) ?? 0).toInt(),
    );
  }

  Future<void> say(String key, String body, Map<String, String> keys) => post('/chats/${Uri.encodeComponent(key)}/messages', {'body': body, 'keys': keys});
  Future<void> read(String key) => post('/chats/${Uri.encodeComponent(key)}/read');

  // --- groups ----------------------------------------------------------------------------

  Future<Group> newGroup(String name, List<String> members) async => Group.fromJson(await post('/groups', {'name': name, 'members': members}));
  Future<Group> group(int id) async => Group.fromJson(await get('/groups/$id'));
  Future<Group> updateGroup(int id, Map<String, String> patchBody) async => Group.fromJson(await patch('/groups/$id', patchBody));
  Future<Group> invite(int id, List<String> usernames) async => Group.fromJson(await post('/groups/$id/members', {'usernames': usernames}));
  Future<Group> joinGroup(String code) async => Group.fromJson(await post('/groups/join', {'code': code}));
  Future<void> removeMember(int id, String username) => delete('/groups/$id/members/${Uri.encodeComponent(username)}');
  Future<void> closeGroup(int id) => delete('/groups/$id');

  // --- reports ---------------------------------------------------------------------------

  Future<List<TheirText>> reportTexts(String username) async =>
      ((await get('/reports/texts/${Uri.encodeComponent(username)}')) as List).map((t) => TheirText.fromJson(t as Json)).toList();

  Future<void> report({
    required String username,
    required String reason,
    required String note,
    required bool block,
    Uint8List? snap,
    String? snapMime,
    Uint8List? snapOverlay,
    Map<String, dynamic>? snapProof,
    List<TheirText> texts = const [],
    List<Uint8List> shots = const [],
  }) {
    final proofs = [
      for (final t in texts)
        if (t.e2e && t.proof != null) {'id': t.id, 'body': t.body, 'sent_at': t.proof!.sentAt, 'nonce': t.proof!.nonce, 'sig': t.proof!.sig},
    ];
    return multipart(
      '/reports',
      {
        'username': username,
        'reason': reason,
        'note': note,
        'block': '$block',
        if (snap != null && snapProof != null) 'snap_proof': jsonEncode(snapProof),
        if (proofs.isNotEmpty) 'text_proofs': jsonEncode(proofs),
      },
      [
        if (snap != null) Part('file', snap, (snapMime ?? '').startsWith('video') ? 'snap.mp4' : 'snap.jpg'),
        if (snap != null && snapOverlay != null) Part('overlay', snapOverlay, 'overlay.png'),
        for (final (i, s) in shots.indexed) Part('shots', s, 'screenshot$i.jpg'),
      ],
      repeated: [for (final t in texts) MapEntry('message_ids', '${t.id}')],
    );
  }

  // --- realtime --------------------------------------------------------------------------

  /// WebSocket with dumb exponential reconnect, like the web app. Returns a stop function.
  void Function() live(void Function() onReconnect, void Function(Json e) onEvent) {
    var closed = false;
    var retry = 1;
    var connects = 0;
    IOWebSocketChannel? ch;
    Timer? ping;

    void connect() {
      if (closed || server.isEmpty) return;
      final uri = Uri.parse('${server.replaceFirst('http', 'ws')}/api/v1/ws');
      final c = IOWebSocketChannel.connect(uri, headers: _headers(), pingInterval: const Duration(seconds: 25));
      ch = c;
      c.ready.then((_) {
        // anything that happened while we were disconnected
        if (connects++ > 0) onReconnect();
        retry = 1;
        ping = Timer.periodic(const Duration(seconds: 25), (_) => c.sink.add('ping'));
      }, onError: (_) {});
      c.stream.listen(
        (m) {
          try {
            onEvent(jsonDecode(m as String) as Json);
          } catch (_) {}
        },
        onDone: () {
          ping?.cancel();
          if (!closed) Future.delayed(Duration(seconds: retry = (retry * 2).clamp(1, 30)), connect);
        },
        onError: (_) {},
        cancelOnError: false,
      );
    }

    connect();
    return () {
      closed = true;
      ping?.cancel();
      ch?.sink.close();
    };
  }
}

final api = Api();
