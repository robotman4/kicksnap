import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../api.dart';
import '../e2e.dart' as e2e;
import '../models.dart';
import '../store.dart';
import '../ui.dart';
import 'camera.dart';
import 'chats.dart';
import 'friends.dart';
import 'groups.dart';
import 'keys.dart';
import 'preview.dart';
import 'settings.dart';
import 'thread.dart';
import 'viewer.dart';

/// A finished snap, ready to encrypt: media bytes, optional drawing layer (videos), mime.
typedef Made = ({Uint8List media, Uint8List? overlay, String mime});

class Outgoing {
  Outgoing(this.id, this.to, this.seconds, this.made);
  final int id;
  final List<String> to;
  final int seconds;
  final Future<Made> made;
  bool failed = false;
}

/// Everything the three pages share: chats, friends, uploads in flight, live events.
class HomeModel extends ChangeNotifier {
  HomeModel(this.me, this.onMe);
  User me;
  final void Function(User) onMe;
  List<Chat> chats = [];
  FriendLists lists = FriendLists.empty;
  final outbox = <Outgoing>[];

  /// bumps on every live event so open screens refetch
  int tick = 0;
  String? toastText;
  void Function()? _stopLive;
  var _jobs = 0;

  String get username => me.username!;
  int get unread => chats.fold(0, (n, c) => n + c.snaps.length);

  Future<void> refresh() async {
    await Future.wait([
      api.chats().then((c) {
        chats = c;
        notifyListeners();
      }, onError: (e) {
        // suspended while the app was open: show it
        if (e is ApiError && (e.status == 403 || e.status == 401)) api.me().then(onMe, onError: (_) {});
      }),
      api.friends().then((l) {
        lists = l;
        notifyListeners();
        // pin friends' identity keys; a change shows as "key changed"
        for (final f in l.friends) {
          e2e.observe(f.username, f.key);
        }
      }, onError: (_) {}),
    ]);
  }

  void syncKeys() => e2e.ensure(username).catchError((_) => e2e.keys.value);

  void start() {
    refresh();
    syncKeys();
    // sign-in responses are minimal; pick up the admin flag etc.
    api.me().then(onMe, onError: (_) {});
    _stopLive = api.live(refresh, (e) {
      refresh();
      if (e['type'] == 'keys') {
        e2e.forgetBundles();
        if (e['user'] == username) syncKeys(); // another device of ours changed the keys
      }
      tick++;
      if (e['type'] == 'snap' || e['type'] == 'message') buzz(12);
      notifyListeners();
    });
  }

  @override
  void dispose() {
    _stopLive?.call();
    super.dispose();
  }

  void say(String t) {
    toastText = t;
    notifyListeners();
  }

  /// Sends run in the background: the editor closes straight away and the chat rows show
  /// "sending" until the upload lands. Failed ones stay on the row to retry.
  void send(Future<Made> made, List<String> to, int seconds) {
    final job = Outgoing(_jobs++, to, seconds, made);
    made.catchError((_) => (media: Uint8List(0), overlay: null, mime: ''));
    outbox.add(job);
    notifyListeners();
    upload(job);
  }

  Future<void> upload(Outgoing job) async {
    job.failed = false;
    notifyListeners();
    try {
      final m = await job.made;
      final s = await e2e.sealSnap(m.media, m.overlay, m.mime, job.to, job.seconds);
      if (s.skipped.isNotEmpty) say('@${s.skipped.join(', @')} needs to update Kiks first');
      if (s.to.isNotEmpty) {
        await api.sendSnap(file: s.file, overlay: s.overlay, envelope: s.envelope, keys: s.keys, kind: s.kind, to: s.to, seconds: job.seconds);
      }
      buzz(12);
      outbox.remove(job);
      await refresh();
    } catch (e) {
      job.failed = true;
      if (e is ApiError && e.status != 0) say(e.message);
      if (e is! ApiError) say('$e');
    }
    notifyListeners();
  }

  /// chat key -> (failed, retry) while a snap to it is in flight
  Map<String, Outgoing> get outgoing => {for (final j in outbox) for (final k in j.to) k: j};
}

const _chats = 0, _camera = 1, _friends = 2;

class Home extends StatefulWidget {
  const Home({super.key, required this.me, required this.onMe, required this.onSignOut, required this.onDeleted});
  final User me;
  final void Function(User) onMe;
  final VoidCallback onSignOut, onDeleted;
  @override
  State<Home> createState() => _HomeState();
}

class _HomeState extends State<Home> with WidgetsBindingObserver {
  late final model = HomeModel(widget.me, widget.onMe);
  // a big even multiple of 3 either side, so swiping loops chats -> camera -> friends -> chats
  static const _base = 3 * 10000;
  final pager = PageController(initialPage: _base + _camera);
  int page = _camera;
  String? replyTo;

  /// something full-screen is on top of the pager (editor, viewer, thread...)
  int covered = 0;

  /// two fingers on the camera: it's a zoom, so the pager holds still
  bool pinching = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    model.start();
    model.addListener(_onModel);
  }

  @override
  void didUpdateWidget(Home old) {
    super.didUpdateWidget(old);
    model.me = widget.me;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    model.removeListener(_onModel);
    model.dispose();
    super.dispose();
  }

  // phones drop the socket in the background, so catch up on return
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) model.refresh();
  }

  void _onModel() {
    final t = model.toastText;
    if (t != null) {
      model.toastText = null;
      toast(context, t);
    }
  }

  void go(int p) {
    final cur = pager.page?.round() ?? _base + page;
    var target = cur - (cur % 3) + p;
    // take the short way round the loop
    if (target - cur > 1) target -= 3;
    if (cur - target > 1) target += 3;
    pager.animateToPage(target, duration: const Duration(milliseconds: 320), curve: Curves.easeOutCubic);
  }

  Future<T?> cover<T>(Route<T> route) async {
    setState(() => covered++);
    try {
      return await Navigator.of(context).push(route);
    } finally {
      if (mounted) setState(() => covered--);
    }
  }

  /// Open the camera aimed at a chat ("u:name" or "g:id").
  void snapAt(String key) {
    setState(() => replyTo = key);
    go(_camera);
  }

  String nameOf(String key) {
    for (final c in model.chats) {
      if (c.key == key) return c.title;
    }
    return '@${key.substring(2)}';
  }

  Future<void> captured(Capture cap) async {
    final to = replyTo;
    await cover(PageRouteBuilder(
      opaque: true,
      transitionDuration: const Duration(milliseconds: 200),
      pageBuilder: (_, _, _) => Preview(
        capture: cap,
        targets: model.chats,
        preselect: to == null ? const [] : [to],
        onAddFriends: () => go(_friends),
        onSend: (made, recipients, seconds) {
          model.send(made, recipients, seconds);
          setState(() => replyTo = null);
          go(_chats);
        },
      ),
      transitionsBuilder: (_, a, _, child) => FadeTransition(opacity: a, child: child),
    ));
  }

  Future<void> view(Chat c) async {
    final back = await cover<String>(MaterialPageRoute(fullscreenDialog: true, builder: (_) => Viewer(chat: c)));
    model.refresh();
    if (back != null) snapAt(back);
  }

  Future<void> talk(Chat c) async {
    final snap = await cover<String>(MaterialPageRoute(builder: (_) => Thread(chat: c, model: model)));
    model.refresh();
    if (snap != null) snapAt(snap);
  }

  void settings() => sheet(context, (_) => Settings(model: model, onSignOut: widget.onSignOut, onDeleted: widget.onDeleted), full: true);

  @override
  Widget build(BuildContext context) => Scaffold(
        resizeToAvoidBottomInset: false,
        body: ListenableBuilder(
          listenable: model,
          builder: (context, _) => Stack(children: [
            PageView.builder(
              controller: pager,
              physics: pinching ? const NeverScrollableScrollPhysics() : null,
              onPageChanged: (i) => setState(() => page = i % 3),
              itemBuilder: (_, i) => switch (i % 3) {
                _chats => Chats(
                    model: model,
                    onOpen: view,
                    onTalk: talk,
                    onSnapBack: snapAt,
                    onFriends: () => go(_friends),
                    onNewGroup: () async {
                      final g = await sheet<Group>(context, (_) => NewGroup(friends: model.lists.friends));
                      if (g == null) return;
                      await model.refresh();
                      talk(Chat(key: g.key, name: g.name, color: g.color, group: true));
                    },
                  ),
                _camera => Camera(
                    me: model.me,
                    active: page == _camera && covered == 0,
                    unread: model.unread,
                    onCapture: captured,
                    onChats: () => go(_chats),
                    onFriends: () => go(_friends),
                    onSettings: settings,
                    onPinch: (on) => setState(() => pinching = on),
                  ),
                _ => Friends(model: model, onSnap: (n) => snapAt('u:$n')),
              },
            ),
            if (replyTo != null && page == _camera)
              Positioned(
                top: MediaQuery.paddingOf(context).top + 14,
                left: 0,
                right: 0,
                child: Center(
                  child: ValueListenableBuilder(
                    valueListenable: accent,
                    builder: (_, a, _) => Press(
                      onTap: () => setState(() => replyTo = null),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
                        decoration: BoxDecoration(color: a, borderRadius: BorderRadius.circular(99), boxShadow: const [BoxShadow(blurRadius: 20, color: Colors.black45)]),
                        child: Text('snapping ${nameOf(replyTo!)} ✕', style: font(15, weight: FontWeight.w900, color: onColor(a))),
                      ),
                    ),
                  ),
                ),
              ),
            ValueListenableBuilder(
              valueListenable: e2e.keys,
              builder: (_, k, _) => !k.locked
                  ? const SizedBox()
                  : Positioned(
                      top: MediaQuery.paddingOf(context).top + 76,
                      left: 16,
                      right: 16,
                      child: Press(
                        onTap: () => sheet(context, (_) => KeysSheet(me: model.username)),
                        child: Container(
                          padding: const EdgeInsets.fromLTRB(20, 12, 12, 12),
                          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(99), boxShadow: const [BoxShadow(blurRadius: 30, color: Colors.black54)]),
                          child: Row(children: [
                            const Text('🔒', style: TextStyle(fontSize: 20)),
                            const SizedBox(width: 10),
                            Expanded(child: Text("this device can't open snaps yet", style: font(16, weight: FontWeight.w900, color: Colors.black))),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                              decoration: BoxDecoration(color: Colors.black, borderRadius: BorderRadius.circular(99)),
                              child: Text('fix', style: font(14, weight: FontWeight.w900, color: accent.value)),
                            ),
                          ]),
                        ),
                      ),
                    ),
            ),
          ]),
        ),
      );
}

/// Remembered across launches, like the web app's localStorage prefs.
int get defaultSeconds => int.tryParse(Store.pref('seconds', '5')) ?? 5;
