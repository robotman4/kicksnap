import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../api.dart';
import '../e2e.dart' as e2e;
import '../models.dart';
import '../ui.dart';
import 'home.dart';

const _maxTexts = 10, _maxShots = 3;

const _reasons = [
  ('harassment', 'bullying or harassment'),
  ('nudity', 'nudity or sexual stuff'),
  ('violence', 'violence or threats'),
  ('spam', 'spam or scam'),
  ('other', 'something else'),
];

/// Report someone to this server's admins. Blocks them too unless you untick it.
/// Pops with true when they got blocked.
class ReportSheet extends StatefulWidget {
  const ReportSheet({super.key, required this.username, this.snap, this.text, this.model});
  final String username;

  /// the snap being looked at, sent along as evidence with its signature
  final e2e.OpenedSnap? snap;

  /// a text of theirs to start with ticked (reporting from a chat bubble)
  final int? text;
  final HomeModel? model;
  @override
  State<ReportSheet> createState() => _ReportSheetState();
}

class _ReportSheetState extends State<ReportSheet> {
  String? reason;
  final note = TextEditingController();
  bool block = true, attach = true, busy = false;
  List<TheirText> texts = [];
  late final picked = <int>[?widget.text];
  final shots = <Uint8List>[];

  @override
  void initState() {
    super.initState();
    // E2E texts come encrypted; only the ones this device can open can be picked
    api.reportTexts(widget.username).then((t) => e2e.openTheirTexts(widget.username, t)).then((t) {
      if (mounted) setState(() => texts = t);
    }, onError: (_) {});
  }

  Future<void> addShots() async {
    final files = await ImagePicker().pickMultiImage(limit: _maxShots - shots.length, requestFullMetadata: false);
    for (final f in files.take(_maxShots - shots.length)) {
      shots.add(await f.readAsBytes());
    }
    if (mounted) setState(() {});
  }

  Future<void> send() async {
    if (reason == null) return;
    setState(() => busy = true);
    final s = widget.snap;
    try {
      await api.report(
        username: widget.username,
        reason: reason!,
        note: note.text,
        block: block,
        snap: attach && s != null && s.ok ? s.media : null,
        snapMime: s?.mime,
        snapOverlay: attach ? s?.overlay : null,
        snapProof: attach ? s?.proof : null,
        texts: texts.where((t) => picked.contains(t.id)).toList(),
        shots: shots,
      );
      buzz(10);
      final msg = block ? 'reported and blocked @${widget.username}' : 'reported @${widget.username}';
      if (widget.model != null) {
        widget.model!.say(msg);
      } else if (mounted) {
        toast(context, msg);
      }
      if (mounted) Navigator.pop(context, block);
    } on ApiError catch (e) {
      if (mounted) toast(context, e.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Widget _toggle(bool on, ValueChanged<bool> set, String label, Color a) => Press(
        onTap: () => setState(() => set(!on)),
        scale: .98,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Row(children: [
            Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(color: on ? a : Colors.white10, borderRadius: BorderRadius.circular(8)),
              child: on ? Icon(Icons.check_rounded, size: 20, color: onColor(a)) : null,
            ),
            const SizedBox(width: 12),
            Expanded(child: Text(label, style: font(16, weight: FontWeight.w800))),
          ]),
        ),
      );

  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
        valueListenable: accent,
        builder: (_, a, _) => ListView(shrinkWrap: true, padding: EdgeInsets.fromLTRB(24, 0, 24, MediaQuery.paddingOf(context).bottom + 24), children: [
          Row(children: [
            const Icon(Icons.flag_rounded, size: 26),
            const SizedBox(width: 8),
            Expanded(child: Text('report @${widget.username}', overflow: TextOverflow.ellipsis, style: font(28, weight: FontWeight.w900))),
          ]),
          const SizedBox(height: 4),
          Text("Goes to the people who run this server. They don't tell @${widget.username} who reported.", style: font(15, weight: FontWeight.w600, color: Colors.white54)),
          const SizedBox(height: 18),
          for (final (r, label) in _reasons)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Pill(label: label, pad: 14, color: reason == r ? a : null, textColor: reason == r ? onColor(a) : null, onTap: () => setState(() => reason = r)),
            ),
          const SizedBox(height: 8),
          Field(controller: note, hint: 'anything they should know (optional)', maxLines: 3),
          const SizedBox(height: 18),
          Text.rich(TextSpan(children: [
            const TextSpan(text: 'proof '),
            TextSpan(text: '(optional)', style: font(16, weight: FontWeight.w700, color: Colors.white38)),
          ]), style: font(18, weight: FontWeight.w900)),
          if (texts.isNotEmpty) ...[
            Text("Tick their texts to send a copy. Texts disappear after 24h, so this is what's left.", style: font(14, weight: FontWeight.w600, color: Colors.white54)),
            const SizedBox(height: 8),
            Container(
              constraints: const BoxConstraints(maxHeight: 224),
              decoration: BoxDecoration(color: Colors.white.withValues(alpha: .05), borderRadius: BorderRadius.circular(24)),
              child: ListView(shrinkWrap: true, padding: const EdgeInsets.all(8), children: [
                for (final t in texts)
                  Press(
                    scale: .98,
                    haptic: 4,
                    onTap: () => setState(() => picked.contains(t.id) ? picked.remove(t.id) : picked.length < _maxTexts ? picked.add(t.id) : null),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      decoration: BoxDecoration(color: picked.contains(t.id) ? a.withValues(alpha: .15) : null, borderRadius: BorderRadius.circular(16)),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Container(
                          width: 24,
                          height: 24,
                          margin: const EdgeInsets.only(top: 2),
                          decoration: BoxDecoration(color: picked.contains(t.id) ? a : Colors.white10, borderRadius: BorderRadius.circular(6)),
                          child: picked.contains(t.id) ? Icon(Icons.check_rounded, size: 16, color: onColor(a)) : null,
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(t.body, style: font(16, weight: FontWeight.w700)),
                            Text('${t.group != null ? 'in ${t.group}' : 'to you'} · ${ago(t.at)}', style: font(12, weight: FontWeight.w600, color: Colors.white38)),
                          ]),
                        ),
                      ]),
                    ),
                  ),
              ]),
            ),
          ],
          const SizedBox(height: 12),
          Row(children: [
            for (final (n, s) in shots.indexed)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: Stack(children: [
                  ClipRRect(borderRadius: BorderRadius.circular(12), child: Image.memory(s, width: 64, height: 96, fit: BoxFit.cover)),
                  Positioned(
                    right: 4,
                    top: 4,
                    child: Press(
                      onTap: () => setState(() => shots.removeAt(n)),
                      child: Container(
                        width: 24,
                        height: 24,
                        decoration: const BoxDecoration(color: Colors.black87, shape: BoxShape.circle),
                        child: const Icon(Icons.close_rounded, size: 14),
                      ),
                    ),
                  ),
                ]),
              ),
            if (shots.length < _maxShots)
              Expanded(
                child: Press(
                  onTap: addShots,
                  scale: .98,
                  child: Container(
                    height: 96,
                    decoration: BoxDecoration(border: Border.all(color: Colors.white24, width: 2), borderRadius: BorderRadius.circular(12)),
                    child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                      const Icon(Icons.add_photo_alternate_rounded, color: Colors.white60),
                      const SizedBox(width: 8),
                      Text('add screenshot', style: font(16, color: Colors.white60)),
                    ]),
                  ),
                ),
              ),
          ]),
          const SizedBox(height: 8),
          if (widget.snap?.ok == true) _toggle(attach, (v) => attach = v, 'send this snap with the report', a),
          _toggle(block, (v) => block = v, 'block @${widget.username} too', a),
          const SizedBox(height: 12),
          Pill(label: 'report', color: Colors.red, size: 20, onTap: reason == null || busy ? null : send),
        ]),
      );
}
