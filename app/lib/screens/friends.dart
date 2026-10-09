import 'dart:async';

import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../api.dart';
import '../e2e.dart' as e2e;
import '../ui.dart';
import 'home.dart';
import 'keys.dart';
import 'scanner.dart';

final _group = RegExp(r'^(kiks|kicksnap)-group:', caseSensitive: false);

/// Whatever a QR scan in friends turns up: a friend, a group invite, or a device to approve.
Future<void> handleCode(BuildContext context, HomeModel model, String code) async {
  if (_group.hasMatch(code)) {
    try {
      final g = await api.joinGroup(code);
      buzz(12);
      model.say("you're in ${g.name} 🎉");
      model.refresh();
    } on ApiError catch (e) {
      model.say(e.message);
    }
  } else if (e2e.isDeviceCode(code)) {
    if (context.mounted) await approveCode(context, model, code);
  } else {
    await addFriend(model, code);
  }
}

/// Add by name, or by their QR: `kiks:<name>#<identity key>`. Scanned in person = verified.
Future<void> addFriend(HomeModel model, String raw) async {
  final parts = raw.trim().split('#');
  final key = parts.length > 1 ? parts[1] : null;
  final n = parts[0].toLowerCase().replaceFirst(RegExp(r'^(kiks|kicksnap):'), '').replaceFirst('@', '');
  if (n.isEmpty) return;
  try {
    final r = await api.addFriend(n);
    buzz(12);
    if (key != null) {
      // their key from the code must match what the server hands out
      final lists = await api.friends();
      final server = [...lists.friends, ...lists.outgoing].where((f) => f.username == r.username).firstOrNull?.key;
      if ((server != null && server != key) || !await e2e.verifyContact(r.username, key)) {
        model.say("⚠️ @${r.username}'s code doesn't match their key on the server");
        model.refresh();
        return;
      }
    }
    model.say((r.status == 'friends' ? 'you and @${r.username} are friends' : 'request sent to @${r.username}') + (key != null ? ' · verified ✓' : ''));
    model.refresh();
  } on ApiError catch (e) {
    model.say(e.message);
  }
}

class Friends extends StatefulWidget {
  const Friends({super.key, required this.model, required this.onSnap});
  final HomeModel model;
  final void Function(String) onSnap;
  @override
  State<Friends> createState() => _FriendsState();
}

class _FriendsState extends State<Friends> {
  final name = TextEditingController();
  String qr = '';

  HomeModel get model => widget.model;

  @override
  void initState() {
    super.initState();
    _qr();
    e2e.keys.addListener(_qr);
  }

  @override
  void dispose() {
    e2e.keys.removeListener(_qr);
    super.dispose();
  }

  // the code carries your identity key, so adding in person also verifies you
  Future<void> _qr() async {
    final q = 'kiks:${model.username}${await e2e.myQr()}';
    if (mounted && q != qr) setState(() => qr = q);
  }

  Future<void> add() async {
    await addFriend(model, name.text);
    name.clear();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    final l = model.lists;
    return ColoredBox(
      color: Colors.black,
      child: ValueListenableBuilder(
        valueListenable: accent,
        builder: (_, a, _) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: EdgeInsets.fromLTRB(20, pad.top + 18, 20, 12), child: Text('friends', style: font(38, weight: FontWeight.w900, spacing: -.5))),
          Expanded(
            child: RefreshIndicator(
              color: Colors.black,
              backgroundColor: a,
              onRefresh: model.refresh,
              child: ListView(physics: const AlwaysScrollableScrollPhysics(), padding: EdgeInsets.fromLTRB(20, 0, 20, pad.bottom + 96), children: [
                // your code
                Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(color: a, borderRadius: BorderRadius.circular(32)),
                  child: Row(children: [
                    SizedBox(
                      width: 112,
                      height: 112,
                      child: qr.isEmpty
                          ? null
                          : QrImageView(
                              data: qr,
                              padding: EdgeInsets.zero,
                              eyeStyle: const QrEyeStyle(color: Colors.black, eyeShape: QrEyeShape.square),
                              dataModuleStyle: const QrDataModuleStyle(color: Colors.black, dataModuleShape: QrDataModuleShape.square),
                            ),
                    ),
                    const SizedBox(width: 20),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('your code', style: font(14, color: Colors.black54)),
                        Text('@${model.username}', overflow: TextOverflow.ellipsis, style: font(24, weight: FontWeight.w900, color: Colors.black)),
                        const SizedBox(height: 4),
                        Text('friends scan this to add you', style: font(14, weight: FontWeight.w700, color: Colors.black54)),
                      ]),
                    ),
                  ]),
                ),
                const SizedBox(height: 16),
                // add by name or scan
                Row(children: [
                  Expanded(
                    child: Field(
                      controller: name,
                      prefix: '@',
                      hint: 'add by name',
                      formatters: [nameFormatter],
                      onChanged: (_) => setState(() {}),
                      onSubmit: (_) => add(),
                      action: TextInputAction.go,
                    ),
                  ),
                  const SizedBox(width: 8),
                  name.text.isNotEmpty
                      ? RoundButton(icon: Icons.add_rounded, tint: a, onTap: add)
                      : RoundButton(
                          icon: Icons.qr_code_scanner_rounded,
                          tint: Colors.white10,
                          onTap: () async {
                            final code = await scan(context, "point at a friend's code");
                            if (code != null && context.mounted) await handleCode(context, model, code);
                          },
                        ),
                ]),
                if (l.incoming.isNotEmpty) ...[
                  const Label('added you'),
                  for (final f in l.incoming)
                    _Row(name: f.username, color: f.color, children: [
                      Pill(
                        label: 'block',
                        pad: 9,
                        size: 15,
                        textColor: Colors.white60,
                        onTap: () async {
                          try {
                            await api.block(f.username);
                            model.say('blocked @${f.username}');
                            model.refresh();
                          } on ApiError catch (e) {
                            model.say(e.message);
                          }
                        },
                      ),
                      const SizedBox(width: 8),
                      Pill(label: 'accept', pad: 9, size: 15, color: a, textColor: onColor(a), onTap: () => addFriend(model, f.username)),
                    ]),
                ],
                if (l.friends.isNotEmpty) ...[
                  const Label('your people'),
                  for (final f in l.friends)
                    _Row(name: f.username, color: f.color, onTap: () => widget.onSnap(f.username), children: [
                      Text('tap to snap', style: font(14, weight: FontWeight.w600, color: Colors.white38)),
                    ]),
                ],
                if (l.outgoing.isNotEmpty) ...[
                  const Label('waiting on them'),
                  for (final f in l.outgoing)
                    _Row(name: f.username, color: f.color, children: [Text('pending', style: font(14, weight: FontWeight.w600, color: Colors.white38))]),
                ],
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.name, required this.color, this.onTap, required this.children});
  final String name, color;
  final VoidCallback? onTap;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) {
    final row = Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(children: [
        Avatar(name: name, color: color, size: 48),
        const SizedBox(width: 16),
        Expanded(child: Text(name, overflow: TextOverflow.ellipsis, style: font(18, weight: FontWeight.w800))),
        ...children,
      ]),
    );
    return onTap == null ? row : Press(onTap: onTap, scale: .98, child: row);
  }
}
