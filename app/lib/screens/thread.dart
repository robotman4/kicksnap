import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../e2e.dart' as e2e;
import '../models.dart';
import '../ui.dart';
import 'groups.dart';
import 'home.dart';
import 'report.dart';

/// Characters as people count them: one emoji is one.
const maxChars = 160;

final _clip = TextInputFormatter.withFunction((o, n) {
  final chars = n.text.characters;
  if (chars.length <= maxChars) return n;
  final t = chars.take(maxChars).toString();
  return TextEditingValue(text: t, selection: TextSelection.collapsed(offset: t.length));
});

/// A conversation: short texts, plus a camera button to snap them. Pops with the chat key
/// when the camera button is tapped.
class Thread extends StatefulWidget {
  const Thread({super.key, required this.chat, required this.model});
  final Chat chat;
  final HomeModel model;
  @override
  State<Thread> createState() => _ThreadState();
}

class _ThreadState extends State<Thread> {
  List<Message> messages = [];
  int seenAt = 0;
  final text = TextEditingController();
  final focus = FocusNode();
  final scroll = ScrollController();
  bool busy = false;
  late int tick = widget.model.tick;

  Chat get chat => widget.model.chats.where((c) => c.key == widget.chat.key).firstOrNull ?? widget.chat;
  String get who => widget.chat.key.substring(2);

  @override
  void initState() {
    super.initState();
    load();
    widget.model.addListener(_onModel);
  }

  @override
  void dispose() {
    widget.model.removeListener(_onModel);
    super.dispose();
  }

  void _onModel() {
    if (widget.model.tick != tick) {
      tick = widget.model.tick;
      load();
    }
  }

  Future<void> load() async {
    try {
      final r = await api.messages(chat.key);
      final opened = await e2e.openTexts(chat, r.messages);
      if (!mounted) return;
      setState(() {
        messages = opened;
        seenAt = r.seenAt;
      });
      api.read(chat.key).catchError((_) {});
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (scroll.hasClients) scroll.jumpTo(scroll.position.maxScrollExtent);
      });
    } on ApiError catch (e) {
      // closed group, unfriended...
      if (e.status == 404 || e.status == 403) {
        if (mounted) Navigator.pop(context);
      }
    }
  }

  Future<void> send() async {
    final body = text.text.trim();
    if (body.isEmpty || busy) return;
    setState(() => busy = true);
    try {
      final s = await e2e.sealText(chat.key, body);
      await api.say(chat.key, s.body, s.keys);
      buzz(8);
      text.clear();
      await load();
    } on ApiError catch (e) {
      if (mounted) toast(context, e.message);
    } finally {
      if (mounted) setState(() => busy = false);
      focus.requestFocus();
    }
  }

  Future<void> act(Future<void> Function() call, String done) async {
    try {
      await call();
      buzz(10);
      widget.model.say(done);
      if (mounted) {
        Navigator.pop(context); // the sheet
        Navigator.pop(context); // the thread
      }
    } on ApiError catch (e) {
      if (mounted) toast(context, e.message);
    }
  }

  void friendMenu() {
    var confirm = false;
    sheet(context, (ctx) => StatefulBuilder(
          builder: (ctx, set) {
            final them = e2e.keys.value.contacts[who];
            return ListView(shrinkWrap: true, padding: EdgeInsets.fromLTRB(24, 0, 24, MediaQuery.paddingOf(ctx).bottom + 24), children: [
              Row(children: [
                Avatar(name: chat.name, color: chat.color, size: 56),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('@${chat.name}', overflow: TextOverflow.ellipsis, style: font(28, weight: FontWeight.w900)),
                    Text(
                      them?.verified == true ? '✓ verified in person' : them?.changed == true ? '🔑 key changed' : 'not verified · scan their code to verify',
                      style: font(14, color: Colors.white38),
                    ),
                  ]),
                ),
              ]),
              const SizedBox(height: 20),
              Pill(icon: Icons.person_remove_rounded, label: 'remove friend', onTap: () => act(() => api.removeFriend(who), 'removed @$who')),
              const SizedBox(height: 12),
              Pill(
                icon: Icons.block_rounded,
                label: confirm ? 'tap again to block' : 'block @$who',
                color: Colors.red.withValues(alpha: .15),
                textColor: Colors.redAccent,
                onTap: () => confirm ? act(() => api.block(who), 'blocked @$who') : set(() => confirm = true),
              ),
              const SizedBox(height: 4),
              Pill(
                icon: Icons.flag_rounded,
                label: 'report @$who',
                color: Colors.transparent,
                textColor: Colors.white54,
                onTap: () {
                  Navigator.pop(ctx);
                  report(who);
                },
              ),
              Text('Blocking unfriends you both and stops them finding you again.', textAlign: TextAlign.center, style: font(14, weight: FontWeight.w600, color: Colors.white38)),
            ]);
          },
        ));
  }

  Future<void> report(String name, {int? textId}) async {
    final blocked = await sheet<bool>(context, (_) => ReportSheet(username: name, model: widget.model, text: textId), full: true);
    // blocking someone in a group keeps you in the group
    if (blocked == true && !chat.group && mounted) Navigator.pop(context);
  }

  Future<void> groupInfo() async {
    final r = await sheet(context, (_) => GroupInfo(id: int.parse(chat.key.substring(2)), model: widget.model), full: true);
    if (!mounted) return;
    if (r == 'gone') return Navigator.pop(context);
    load();
  }

  void tapped(Message m) => sheet(context, (ctx) => Padding(
        padding: EdgeInsets.fromLTRB(24, 0, 24, MediaQuery.paddingOf(ctx).bottom + 24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            decoration: BoxDecoration(color: Colors.white10, borderRadius: BorderRadius.circular(24)),
            child: Text(m.body, maxLines: 3, overflow: TextOverflow.ellipsis, style: font(18, weight: FontWeight.w700)),
          ),
          const SizedBox(height: 12),
          Pill(
            icon: Icons.flag_rounded,
            label: 'report this text from @${m.from}',
            color: Colors.red.withValues(alpha: .15),
            textColor: Colors.redAccent,
            onTap: () {
              Navigator.pop(ctx);
              report(m.from, textId: m.id);
            },
          ),
        ]),
      ));

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    final c = chat;
    final lastMine = messages.lastWhere((m) => m.mine, orElse: () => Message(id: -1, body: '', at: 0, from: '', color: '', mine: true));
    final left = maxChars - text.text.characters.length;
    return Scaffold(
      body: ValueListenableBuilder(
        valueListenable: accent,
        builder: (_, a, _) => Column(children: [
          Container(
            padding: EdgeInsets.fromLTRB(8, pad.top + 8, 12, 8),
            decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Colors.white10))),
            child: Row(children: [
              Press(onTap: () => Navigator.pop(context), child: const Padding(padding: EdgeInsets.all(8), child: Icon(Icons.chevron_left_rounded, size: 34))),
              Expanded(
                child: Press(
                  scale: .98,
                  onTap: () => c.group
                      ? groupInfo()
                      : friendMenu(),
                  child: Row(children: [
                    Avatar(name: c.name, color: c.color, size: 42, group: c.group),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(c.name, overflow: TextOverflow.ellipsis, style: font(19, weight: FontWeight.w900)),
                        Text(c.group ? 'tap for group info' : 'tap for options', style: font(12, weight: FontWeight.w700, color: Colors.white38)),
                      ]),
                    ),
                  ]),
                ),
              ),
              RoundButton(icon: Icons.photo_camera_rounded, size: 50, tint: a, onTap: () => Navigator.pop(context, c.key)),
            ]),
          ),
          Expanded(
            child: ValueListenableBuilder(
              valueListenable: e2e.keys,
              builder: (_, keys, _) {
                final them = c.group ? null : keys.contacts[who];
                return ListView(controller: scroll, padding: const EdgeInsets.fromLTRB(16, 16, 16, 16), children: [
                  Text('🔒 end-to-end encrypted · chats disappear after 24h', textAlign: TextAlign.center, style: font(12, weight: FontWeight.w700, color: Colors.white30)),
                  const SizedBox(height: 12),
                  if (them?.changed == true)
                    Container(
                      margin: const EdgeInsets.only(bottom: 12),
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(color: Colors.white10, borderRadius: BorderRadius.circular(24)),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text("🔑 @$who's key changed", style: font(17, weight: FontWeight.w900)),
                        const SizedBox(height: 4),
                        Text("They probably got a new phone or reset Kiks. If you weren't expecting that, scan their code in person to check it's them.",
                            style: font(14, weight: FontWeight.w600, color: Colors.white60)),
                        const SizedBox(height: 10),
                        Pill(label: 'ok', color: Colors.white, textColor: Colors.black, pad: 8, size: 16, onTap: () => e2e.acknowledge(who)),
                      ]),
                    ),
                  if (messages.isEmpty)
                    Padding(padding: const EdgeInsets.only(top: 64), child: Text('say hi 👋', textAlign: TextAlign.center, style: font(26, weight: FontWeight.w900, color: Colors.white30))),
                  for (final (i, m) in messages.indexed) _bubble(m, i == 0 || messages[i - 1].from != m.from, a, identical(m, lastMine) && !c.group),
                ]);
              },
            ),
          ),
          Padding(
            padding: EdgeInsets.fromLTRB(12, 8, 12, (MediaQuery.viewInsetsOf(context).bottom > 0 ? 0 : pad.bottom) + 12),
            child: Row(children: [
              Expanded(
                child: Stack(alignment: Alignment.centerRight, children: [
                  Field(
                    controller: text,
                    hint: 'chat',
                    focusNode: focus,
                    formatters: [_clip],
                    onChanged: (_) => setState(() {}),
                    onSubmit: (_) => send(),
                    action: TextInputAction.send,
                  ),
                  if (left <= 30)
                    Padding(
                      padding: const EdgeInsets.only(right: 18),
                      child: Text('$left', style: font(14, weight: FontWeight.w900, color: left <= 0 ? Colors.redAccent : Colors.white38)),
                    ),
                ]),
              ),
              const SizedBox(width: 8),
              Press(
                onTap: text.text.trim().isEmpty || busy ? null : send,
                scale: .9,
                child: Container(
                  width: 56,
                  height: 56,
                  decoration: BoxDecoration(color: a, shape: BoxShape.circle),
                  child: Icon(Icons.arrow_upward_rounded, size: 30, color: onColor(a)),
                ),
              ),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _bubble(Message m, bool firstOfRun, Color a, bool showSeen) {
    final c = chat;
    return Padding(
      padding: EdgeInsets.only(top: firstOfRun ? 12 : 4),
      child: Column(crossAxisAlignment: m.mine ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [
        if (firstOfRun && c.group && !m.mine)
          Padding(padding: const EdgeInsets.only(left: 12, bottom: 4), child: Text(m.from, style: font(12, weight: FontWeight.w900, color: hex(m.color)))),
        ConstrainedBox(
          constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * .8),
          child: m.locked != null
              ? Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  decoration: BoxDecoration(border: Border.all(color: Colors.white24, width: 2), borderRadius: BorderRadius.circular(24)),
                  child: Text('🔒 ${m.locked == 'nokey' ? 'sent before this device was set up' : "couldn't be verified"}',
                      style: font(14, weight: FontWeight.w700, color: Colors.white38)),
                )
              : GestureDetector(
                  onTap: m.mine ? null : () => tapped(m),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                    decoration: BoxDecoration(color: m.mine ? a : Colors.white10, borderRadius: BorderRadius.circular(24)),
                    child: SelectableText(m.body, style: font(18, weight: FontWeight.w700, color: m.mine ? onColor(a) : Colors.white, height: 1.25)),
                  ),
                ),
        ),
        if (showSeen)
          Padding(
            padding: const EdgeInsets.only(right: 8, top: 4),
            child: Text(seenAt >= m.at ? 'seen' : 'delivered', style: font(12, weight: FontWeight.w800, color: Colors.white38)),
          ),
      ]),
    );
  }
}
