/// What the server sends back, as in frontend/src/lib/api.ts.
library;

typedef Json = Map<String, dynamic>;

int _int(Object? v) => v == null ? 0 : (v as num).toInt();

class User {
  User({required this.username, required this.color, this.admin = false, this.suspendedUntil});
  final String? username;
  final String color;
  final bool admin;

  /// set while suspended; 0 = until an admin lifts it
  final int? suspendedUntil;

  factory User.fromJson(Json j) {
    if (j['limits'] is Map) Limits.current = Limits.fromJson((j['limits'] as Map).cast<String, dynamic>());
    return User(
        username: j['username'] as String?,
        color: (j['color'] as String?) ?? '#C6FF3D',
        admin: j['admin'] == true,
        suspendedUntil: j['suspended_until'] == null ? null : _int(j['suspended_until']),
      );
  }

  User copyWith({String? color}) =>
      User(username: username, color: color ?? this.color, admin: admin, suspendedUntil: suspendedUntil);
}

/// The server's upload limits (MAX_UPLOAD_MB etc., docs/deploy.md), from /me.
class Limits {
  const Limits({this.uploadMb = 50, this.videoSeconds = 30, this.videoKbps = 6000, this.dailyMb = 500});
  final int uploadMb, videoSeconds, videoKbps, dailyMb;

  /// what this server allows; the defaults hold until /me says otherwise
  static Limits current = const Limits();

  factory Limits.fromJson(Json j) => Limits(
        uploadMb: _int(j['upload_mb'] ?? 50),
        videoSeconds: _int(j['video_seconds'] ?? 30),
        videoKbps: _int(j['video_kbps'] ?? 6000),
        dailyMb: _int(j['daily_mb'] ?? 500),
      );
}

class Friend {
  Friend(this.username, this.color, this.key);
  final String username;
  final String color;

  /// their identity key (E2E), null until their app has made one
  final String? key;

  factory Friend.fromJson(Json j) => Friend(j['username'] as String, (j['color'] as String?) ?? '#888888', j['key'] as String?);
}

class FriendLists {
  FriendLists(this.friends, this.incoming, this.outgoing);
  final List<Friend> friends, incoming, outgoing;
  static final empty = FriendLists(const [], const [], const []);

  factory FriendLists.fromJson(Json j) {
    List<Friend> l(String k) => ((j[k] as List?) ?? []).map((e) => Friend.fromJson(e as Json)).toList();
    return FriendLists(l('friends'), l('incoming'), l('outgoing'));
  }
}

class SnapMeta {
  SnapMeta({required this.id, required this.kind, required this.seconds, required this.hasOverlay, required this.createdAt, required this.sender, required this.e2e});
  final String id, kind, sender;
  final int seconds, createdAt;
  final bool hasOverlay, e2e;

  factory SnapMeta.fromJson(Json j) => SnapMeta(
        id: j['id'] as String,
        kind: j['kind'] as String,
        seconds: _int(j['seconds']),
        hasOverlay: _int(j['has_overlay']) != 0,
        createdAt: _int(j['created_at']),
        sender: (j['sender'] as String?) ?? '',
        e2e: _int(j['e2e']) != 0,
      );
}

/// key is `u:<username>` for a friend, `g:<id>` for a group.
class Chat {
  Chat({
    required this.key,
    required this.name,
    required this.color,
    required this.group,
    this.away = false,
    this.state = 'none',
    this.kind = 'chat',
    this.at = 0,
    this.snaps = const [],
    this.unread = 0,
  });
  final String key, name, color, state, kind;
  final bool group, away;
  final int at, unread;
  final List<SnapMeta> snaps;

  factory Chat.fromJson(Json j) => Chat(
        key: j['key'] as String,
        name: j['name'] as String,
        color: (j['color'] as String?) ?? '#888888',
        group: j['group'] == true,
        away: j['away'] == true,
        state: (j['state'] as String?) ?? 'none',
        kind: (j['kind'] as String?) ?? 'chat',
        at: _int(j['at']),
        snaps: ((j['snaps'] as List?) ?? []).map((e) => SnapMeta.fromJson(e as Json)).toList(),
        unread: _int(j['unread']),
      );

  String get title => group ? name : '@$name';
}

/// What a report needs to prove the sender signed a text.
class TextProof {
  TextProof(this.sentAt, this.nonce, this.sig);
  final int sentAt;
  final String nonce, sig;
}

class Message {
  Message({
    required this.id,
    required this.body,
    required this.at,
    required this.from,
    required this.color,
    required this.mine,
    this.e2e = false,
    this.key,
    this.locked,
    this.proof,
  });
  final int id, at;
  final String body, from, color;
  final bool mine, e2e;
  final String? key;

  /// couldn't be opened here: "nokey" = sent before this device was set up, "bad" = didn't check out
  final String? locked;
  final TextProof? proof;

  factory Message.fromJson(Json j) => Message(
        id: _int(j['id']),
        body: (j['body'] as String?) ?? '',
        at: _int(j['at']),
        from: (j['from'] as String?) ?? '',
        color: (j['color'] as String?) ?? '#888888',
        mine: j['mine'] == true,
        e2e: j['e2e'] == true || j['e2e'] == 1,
        key: j['key'] as String?,
      );

  Message opened(String body, TextProof proof) =>
      Message(id: id, body: body, at: at, from: from, color: color, mine: mine, e2e: e2e, key: key, proof: proof);

  Message lock(String why) => Message(id: id, body: '', at: at, from: from, color: color, mine: mine, e2e: e2e, key: key, locked: why);
}

/// One of their texts, offered as proof when reporting them.
class TheirText {
  TheirText({required this.id, required this.body, required this.at, this.group, this.e2e = false, this.key, this.to, this.proof});
  final int id, at;
  final String body;
  final String? group, key, to;
  final bool e2e;
  final TextProof? proof;

  factory TheirText.fromJson(Json j) => TheirText(
        id: _int(j['id']),
        body: (j['body'] as String?) ?? '',
        at: _int(j['at']),
        group: j['group'] as String?,
        e2e: j['e2e'] == true || j['e2e'] == 1,
        key: j['key'] as String?,
        to: j['to'] as String?,
      );

  TheirText opened(String body, TextProof proof) =>
      TheirText(id: id, body: body, at: at, group: group, e2e: e2e, key: key, to: to, proof: proof);
}

class DeviceListJson {
  DeviceListJson(this.payload, this.sig, this.version);
  final String payload, sig;
  final int version;
  static DeviceListJson? fromJson(Object? j) {
    if (j is! Map) return null;
    return DeviceListJson(j['payload'] as String, j['sig'] as String, _int(j['version']));
  }
}

class KeyBundle {
  KeyBundle(this.identityKey, this.deviceList, this.devices);
  final String? identityKey;
  final DeviceListJson? deviceList;

  /// device id -> enc_key (b64)
  final Map<int, String> devices;

  factory KeyBundle.fromJson(Json j) => KeyBundle(
        j['identity_key'] as String?,
        DeviceListJson.fromJson(j['device_list']),
        {for (final d in (j['devices'] as List? ?? [])) _int((d as Json)['id']): d['enc_key'] as String? ?? ''},
      );
}

class MyKeys extends KeyBundle {
  MyKeys(this.deviceId, super.identityKey, super.deviceList, super.devices);
  final int deviceId;

  factory MyKeys.fromJson(Json j) {
    final b = KeyBundle.fromJson(j);
    return MyKeys(_int(j['device_id']), b.identityKey, b.deviceList, b.devices);
  }
}

class GroupMember {
  GroupMember(this.username, this.color, this.admin);
  final String username, color;
  final bool admin;
}

class Group {
  Group({required this.id, required this.key, required this.name, required this.color, required this.inviteMode, required this.admin, required this.canInvite, required this.code, required this.members});
  final int id;
  final String key, name, color, inviteMode;
  final bool admin, canInvite;
  final String? code;
  final List<GroupMember> members;

  factory Group.fromJson(Json j) => Group(
        id: _int(j['id']),
        key: j['key'] as String,
        name: j['name'] as String,
        color: (j['color'] as String?) ?? '#888888',
        inviteMode: (j['invite_mode'] as String?) ?? 'admin',
        admin: j['admin'] == true,
        canInvite: j['can_invite'] == true,
        code: j['code'] as String?,
        members: [
          for (final m in (j['members'] as List? ?? []))
            GroupMember((m as Json)['username'] as String, (m['color'] as String?) ?? '#888888', m['admin'] == true),
        ],
      );
}

class Device {
  Device(this.id, this.label, this.createdAt, this.seenAt, this.isThis);
  final int id, createdAt, seenAt;
  final String label;
  final bool isThis;
  factory Device.fromJson(Json j) => Device(_int(j['id']), (j['label'] as String?) ?? 'device', _int(j['created_at']), _int(j['seen_at']), j['this'] == true);
}

class Suspension {
  Suspension({required this.suspended, this.until = 0, this.reason = '', this.appealBody, this.appealOutcome, this.appealReply = ''});
  final bool suspended;
  final int until;
  final String reason;
  final String? appealBody, appealOutcome;
  final String appealReply;

  factory Suspension.fromJson(Json j) {
    final a = j['appeal'] as Json?;
    return Suspension(
      suspended: j['suspended'] == true,
      until: _int(j['until']),
      reason: (j['reason'] as String?) ?? '',
      appealBody: a?['body'] as String?,
      appealOutcome: a?['outcome'] as String?,
      appealReply: (a?['reply'] as String?) ?? '',
    );
  }
}
