import 'package:flutter/material.dart';

import '../e2e.dart' as e2e;
import '../models.dart';
import '../ui.dart';
import 'home.dart';

const _labels = {'new': 'new snap', 'received': 'received', 'delivered': 'delivered', 'opened': 'opened', 'none': 'tap to snap'};

String _status(Chat c) {
  if (c.state == 'new' && c.kind == 'chat') return c.unread > 1 ? '${c.unread} new chats' : 'new chat';
  if (c.state == 'new') return c.snaps.length > 1 ? '${c.snaps.length} new snaps' : 'new snap';
  return _labels[c.state] ?? c.state;
}

/// Snapchat's marks: filled square = new, outline = received, arrow = delivered, outline arrow = opened.
class _Mark extends StatelessWidget {
  const _Mark(this.state, this.color);
  final String state;
  final Color color;
  @override
  Widget build(BuildContext context) => switch (state) {
        'new' => Container(width: 14, height: 14, decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(4))),
        'received' => Container(width: 14, height: 14, decoration: BoxDecoration(border: Border.all(color: color, width: 2), borderRadius: BorderRadius.circular(4))),
        'delivered' || 'opened' => CustomPaint(size: const Size(14, 14), painter: _Arrow(color, state == 'delivered')),
        _ => const SizedBox(),
      };
}

class _Arrow extends CustomPainter {
  _Arrow(this.color, this.fill, [this.t = 1]);
  final Color color;
  final bool fill;
  final double t;
  @override
  void paint(Canvas canvas, Size s) {
    final p = Path()
      ..moveTo(2, 1.5)
      ..lineTo(12.5, 7)
      ..lineTo(2, 12.5)
      ..lineTo(4.5, 7)
      ..close();
    canvas.drawPath(p, Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..strokeJoin = StrokeJoin.round);
    if (fill) canvas.drawPath(p, Paint()..color = color.withValues(alpha: t));
  }

  @override
  bool shouldRepaint(_Arrow o) => o.t != t || o.color != color;
}

/// Outline arrow that keeps filling in while the snap uploads.
class _Sending extends StatefulWidget {
  const _Sending(this.color);
  final Color color;
  @override
  State<_Sending> createState() => _SendingState();
}

class _SendingState extends State<_Sending> with SingleTickerProviderStateMixin {
  late final a = AnimationController(vsync: this, duration: const Duration(seconds: 1))..repeat(reverse: true);
  @override
  void dispose() {
    a.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(animation: a, builder: (_, _) => CustomPaint(size: const Size(14, 14), painter: _Arrow(widget.color, true, a.value)));
}

class Chats extends StatelessWidget {
  const Chats({super.key, required this.model, required this.onOpen, required this.onTalk, required this.onSnapBack, required this.onFriends, required this.onNewGroup});
  final HomeModel model;
  final void Function(Chat) onOpen, onTalk;
  final void Function(String) onSnapBack;
  final VoidCallback onFriends, onNewGroup;

  @override
  Widget build(BuildContext context) {
    final out = model.outgoing;
    final chats = [...model.chats.where((c) => out.containsKey(c.key)), ...model.chats.where((c) => !out.containsKey(c.key))];
    final pad = MediaQuery.paddingOf(context);
    return ColoredBox(
      color: Colors.black,
      child: Column(children: [
        Padding(
          padding: EdgeInsets.fromLTRB(20, pad.top + 18, 20, 12),
          child: Row(children: [
            Expanded(child: Text('chats', style: font(38, weight: FontWeight.w900, spacing: -.5))),
            Press(
              onTap: onNewGroup,
              child: Container(
                padding: const EdgeInsets.fromLTRB(12, 10, 16, 10),
                decoration: BoxDecoration(color: Colors.white10, borderRadius: BorderRadius.circular(99)),
                child: Row(children: [const Icon(Icons.add_rounded, size: 22), const SizedBox(width: 4), Text('group', style: font(16, weight: FontWeight.w800))]),
              ),
            ),
          ]),
        ),
        Expanded(
          child: ValueListenableBuilder(
            valueListenable: accent,
            builder: (_, a, _) => RefreshIndicator(
              color: Colors.black,
              backgroundColor: a,
              onRefresh: model.refresh,
              child: ValueListenableBuilder(
                valueListenable: e2e.keys,
                builder: (_, keys, _) => ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: EdgeInsets.only(bottom: pad.bottom + 96),
                  children: [
                    if (chats.isEmpty)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(40, 96, 40, 0),
                        child: Column(children: [
                          Text('quiet in here', style: font(26, weight: FontWeight.w900)),
                          const SizedBox(height: 8),
                          Text('Add a friend and send the first snap.', style: font(16, weight: FontWeight.w600, color: Colors.white54)),
                          const SizedBox(height: 18),
                          Pill(label: 'add friends', color: a, textColor: onColor(a), pad: 12, onTap: onFriends),
                        ]),
                      ),
                    for (final c in chats) _row(c, out[c.key], a, keys),
                  ],
                ),
              ),
            ),
          ),
        ),
      ]),
    );
  }

  Widget _row(Chat c, Outgoing? o, Color a, e2e.KeyState keys) {
    final isNew = c.state == 'new';
    final color = c.kind == 'chat' ? chatBlue : a;
    Widget status;
    if (c.away) {
      status = Text('unavailable', style: font(14, weight: FontWeight.w600, color: Colors.white38));
    } else if (o != null) {
      status = o.failed
          ? Text("didn't send · tap to retry", style: font(14, weight: FontWeight.w800, color: Colors.redAccent))
          : Row(children: [_Sending(a), const SizedBox(width: 8), Text('sending…', style: font(14, weight: FontWeight.w800, color: a))]);
    } else {
      status = Row(children: [
        _Mark(c.state, color),
        if (c.state != 'none') const SizedBox(width: 8),
        Flexible(
          child: Text(_status(c),
              overflow: TextOverflow.ellipsis, style: font(14, weight: isNew ? FontWeight.w900 : FontWeight.w600, color: isNew ? color : Colors.white54)),
        ),
        if (c.at > 0 && c.state != 'none') Text(' · ${ago(c.at)}', style: font(14, weight: FontWeight.w600, color: Colors.white38)),
      ]);
    }
    return Padding(
      padding: const EdgeInsets.only(right: 12),
      child: Row(children: [
        Expanded(
          child: Press(
            scale: .98,
            // new snaps play first; otherwise straight to the camera, aimed at them
            onTap: c.away ? null : () => o?.failed == true ? model.upload(o!) : c.snaps.isNotEmpty ? onOpen(c) : onSnapBack(c.key),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
              child: Row(children: [
                Avatar(name: c.name, color: c.color, size: 54, group: c.group),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Flexible(child: Text(c.name, overflow: TextOverflow.ellipsis, style: font(18, weight: FontWeight.w800))),
                      if (!c.group && keys.contacts[c.name]?.changed == true)
                        Text('  🔑 key changed', style: font(13, weight: FontWeight.w900, color: Colors.amber)),
                    ]),
                    const SizedBox(height: 2),
                    status,
                  ]),
                ),
              ]),
            ),
          ),
        ),
        Press(
          onTap: () => onTalk(c),
          scale: .88,
          child: SizedBox(
            width: 48,
            height: 48,
            child: Stack(alignment: Alignment.center, children: [
              const Icon(Icons.chat_bubble_outline_rounded, size: 25, color: Colors.white60),
              if (c.unread > 0)
                Positioned(
                  right: 8,
                  top: 8,
                  child: Container(width: 12, height: 12, decoration: BoxDecoration(color: chatBlue, shape: BoxShape.circle, border: Border.all(color: Colors.black, width: 2))),
                ),
            ]),
          ),
        ),
      ]),
    );
  }
}
