import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import '../models.dart';
import '../store.dart';
import '../ui.dart';
import 'camera.dart';
import 'compose.dart';
import 'home.dart';

/// After the shutter: doodle, add text, pick people, send.
class Preview extends StatefulWidget {
  const Preview({super.key, required this.capture, required this.targets, required this.preselect, required this.onSend, required this.onAddFriends});
  final Capture capture;

  /// friends and groups, as chats
  final List<Chat> targets;
  final List<String> preselect;

  /// Called right away; `made` renders the final file after the editor has closed.
  final void Function(Future<Made> made, List<String> to, int seconds) onSend;
  final VoidCallback onAddFriends;
  @override
  State<Preview> createState() => _PreviewState();
}

class _PreviewState extends State<Preview> {
  late int seconds = int.tryParse(Store.pref('seconds', '5')) ?? 5;
  String mode = 'look'; // look | draw | text
  Color ink = defaultInk;
  final strokes = <Stroke>[];
  Stroke? drawing;
  TextLabel? label;
  final text = TextEditingController();
  final focus = FocusNode();
  Size dims = Size.zero;
  VideoPlayerController? video;
  bool sending = false;
  Offset? drag;
  bool dragged = false;

  bool get isVideo => widget.capture.kind == 'video';

  @override
  void initState() {
    super.initState();
    focus.addListener(() {
      if (!focus.hasFocus && mode == 'text') finishText();
    });
    if (isVideo) {
      final v = VideoPlayerController.file(File(widget.capture.path));
      video = v;
      v.initialize().then((_) {
        v.setLooping(true);
        v.play();
        if (mounted) setState(() => dims = v.value.size);
      });
    } else {
      FileImage(File(widget.capture.path)).resolve(ImageConfiguration.empty).addListener(ImageStreamListener((info, _) {
        if (mounted) setState(() => dims = Size(info.image.width.toDouble(), info.image.height.toDouble()));
      }));
    }
  }

  @override
  void dispose() {
    video?.dispose();
    text.dispose();
    focus.dispose();
    super.dispose();
  }

  Offset rel(Offset p, Size s) => Offset(p.dx / s.width, p.dy / s.height);

  void tapText(Size screen) {
    buzz(6);
    if (mode == 'text' && label != null) {
      // second tap on T flips the style, like Snapchat
      setState(() => label!.big = !label!.big);
      return;
    }
    // start text in the lower part of the picture itself
    final r = containRect(dims, screen);
    label ??= TextLabel(color: ink, y: (r.top + r.height * .75) / screen.height);
    text.text = label!.text;
    setState(() => mode = 'text');
    focus.requestFocus();
  }

  void finishText() {
    setState(() {
      mode = 'look';
      if (label != null && label!.text.trim().isEmpty) label = null;
    });
    focus.unfocus();
  }

  void cycleTimer() {
    buzz(5);
    setState(() => seconds = timers[(timers.indexOf(seconds) + 1) % timers.length]);
  }

  void send(List<String> to, Size screen) {
    if (to.isEmpty || sending) return;
    sending = true;
    video?.pause();
    final made = compose(widget.capture, dims, screen, List.of(strokes), label);
    Navigator.of(context).pop();
    widget.onSend(made, to, isVideo ? 0 : seconds);
  }

  Future<void> pickTargets(Size screen) async {
    final to = await sheet<List<String>>(context, (_) => _SendTo(targets: widget.targets, onAddFriends: () {
          Navigator.pop(context);
          Navigator.pop(context);
          widget.onAddFriends();
        }));
    if (to != null && to.isNotEmpty) send(to, screen);
  }

  String nameOf(String key) {
    for (final t in widget.targets) {
      if (t.key == key) return t.title;
    }
    return key.substring(2);
  }

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    final kb = MediaQuery.viewInsetsOf(context).bottom;
    return Scaffold(
      backgroundColor: Colors.black,
      // the keyboard floats over the snap; nothing moves
      resizeToAvoidBottomInset: false,
      body: LayoutBuilder(builder: (context, box) {
        final screen = box.biggest;
        final r = containRect(dims, screen);
        return Stack(children: [
          Positioned.fill(child: _media()),
          // drawing layer
          Positioned.fill(
            child: IgnorePointer(
              ignoring: mode != 'draw',
              child: Listener(
                onPointerDown: (e) => setState(() => drawing = Stroke(ink, brush, [rel(e.localPosition, screen)])),
                onPointerMove: (e) => setState(() => drawing?.pts.add(rel(e.localPosition, screen))),
                onPointerUp: (_) => setState(() {
                  if (drawing != null) strokes.add(drawing!);
                  drawing = null;
                }),
                child: CustomPaint(painter: _Ink([...strokes, ?drawing], screen), size: screen),
              ),
            ),
          ),
          // tap the picture to start typing
          if (mode == 'look') Positioned.fill(child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: () => tapText(screen))),
          if (mode == 'text') Positioned.fill(child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: finishText)),
          if (label != null) _label(screen, r, kb),
          // top-left: close / undo
          Positioned(
            left: 16,
            top: pad.top + 14,
            child: Row(children: [
              RoundButton(icon: Icons.close_rounded, onTap: () => Navigator.pop(context)),
              if (mode == 'draw' && strokes.isNotEmpty) ...[
                const SizedBox(width: 12),
                RoundButton(icon: Icons.undo_rounded, onTap: () => setState(strokes.removeLast)),
              ],
            ]),
          ),
          // right rail: tools
          Positioned(
            right: 16,
            top: pad.top + 14,
            child: Column(children: [
              RoundButton(icon: Icons.title_rounded, on: mode == 'text', onTap: () => tapText(screen)),
              const SizedBox(height: 12),
              RoundButton(icon: Icons.edit_rounded, on: mode == 'draw', tint: mode == 'draw' ? ink : null, onTap: () {
                buzz(6);
                if (mode == 'text') finishText();
                setState(() => mode = mode == 'draw' ? 'look' : 'draw');
              }),
              if (mode == 'draw') ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(color: Colors.black38, borderRadius: BorderRadius.circular(99)),
                  child: Column(children: [
                    for (final c in inks)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Press(
                          onTap: () => setState(() => ink = c),
                          haptic: 4,
                          child: AnimatedScale(
                            scale: c == ink ? 1.25 : 1,
                            duration: const Duration(milliseconds: 150),
                            child: Container(
                              width: 32,
                              height: 32,
                              decoration: BoxDecoration(color: c, shape: BoxShape.circle, border: Border.all(color: c == ink ? Colors.white : Colors.white30, width: 3)),
                            ),
                          ),
                        ),
                      ),
                  ]),
                ),
              ],
              if (mode != 'draw' && !isVideo) ...[
                const SizedBox(height: 12),
                RoundButton(
                  icon: Icons.timer_rounded,
                  onTap: cycleTimer,
                  child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                    const Icon(Icons.timer_rounded, size: 22, color: Colors.white),
                    Text(timerLabel(seconds), style: font(12, weight: FontWeight.w900, color: Colors.white, height: 1)),
                  ]),
                ),
              ],
            ]),
          ),
          if (mode == 'look')
            Positioned(
              right: 16,
              bottom: pad.bottom + 20,
              child: ValueListenableBuilder(
                valueListenable: accent,
                builder: (_, a, _) => Press(
                  onTap: sending ? null : () => widget.preselect.isNotEmpty ? send(widget.preselect, screen) : pickTargets(screen),
                  scale: .95,
                  haptic: 8,
                  child: Container(
                    padding: const EdgeInsets.fromLTRB(32, 20, 24, 20),
                    decoration: BoxDecoration(color: a, borderRadius: BorderRadius.circular(99), boxShadow: const [BoxShadow(color: Colors.black38, offset: Offset(0, 6))]),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      ConstrainedBox(
                        constraints: BoxConstraints(maxWidth: screen.width * .55),
                        child: Text(widget.preselect.isNotEmpty ? nameOf(widget.preselect.first) : 'send to',
                            overflow: TextOverflow.ellipsis, style: font(24, weight: FontWeight.w900, color: onColor(a))),
                      ),
                      const SizedBox(width: 12),
                      Icon(Icons.send_rounded, size: 26, color: onColor(a)),
                    ]),
                  ),
                ),
              ),
            ),
          if (mode == 'draw')
            Positioned(
              left: 0,
              right: 0,
              bottom: pad.bottom + 24,
              child: Center(child: Pill(label: 'done', color: Colors.white, textColor: Colors.black, size: 20, pad: 16, onTap: () => setState(() => mode = 'look'))),
            ),
        ]);
      }),
    );
  }

  Widget _media() {
    if (isVideo) {
      final v = video;
      if (v == null || !v.value.isInitialized) return const SizedBox();
      return FittedBox(fit: BoxFit.contain, child: SizedBox(width: v.value.size.width, height: v.value.size.height, child: VideoPlayer(v)));
    }
    final img = Image.file(File(widget.capture.path), fit: BoxFit.contain, width: double.infinity, height: double.infinity);
    return widget.capture.mirror ? Transform.flip(flipX: true, child: img) : img;
  }

  /// While typing, the text sits just above the keyboard (Snapchat-style) and drops back to its
  /// spot when done. The snap itself never moves.
  Widget _label(Size screen, Rect r, double kb) {
    final l = label!;
    final typing = mode == 'text';
    final size = (l.big ? fontBig : fontBar) * screen.height;
    final style = labelStyle(l, size);
    final y = typing && kb > 0 ? screen.height - kb - 24 - size : l.y * screen.height;

    Widget content = typing
        ? IntrinsicWidth(
            child: TextField(
              controller: text,
              focusNode: focus,
              maxLength: 80,
              textAlign: TextAlign.center,
              style: style,
              cursorColor: Colors.white,
              onChanged: (t) => l.text = t,
              onSubmitted: (_) => finishText(),
              decoration: const InputDecoration(border: InputBorder.none, counterText: '', isDense: true, contentPadding: EdgeInsets.zero),
            ),
          )
        : (l.big
            ? Stack(children: [
                Text(l.text, style: labelStyle(l, size, stroke: Paint()
                  ..style = PaintingStyle.stroke
                  ..strokeWidth = size * .14
                  ..strokeJoin = StrokeJoin.round
                  ..color = l.color == Colors.black ? Colors.white : Colors.black)),
                Text(l.text, style: style),
              ])
            : Text(l.text, style: style, maxLines: 1, overflow: TextOverflow.ellipsis));

    final child = GestureDetector(
      onPanStart: typing
          ? null
          : (d) {
              drag = d.globalPosition;
              dragged = false;
            },
      onPanUpdate: typing
          ? null
          : (d) => setState(() {
                dragged = true;
                l.x = (l.x + d.delta.dx / screen.width).clamp(.05, .95);
                l.y = (l.y + d.delta.dy / screen.height).clamp(.08, .92);
              }),
      onTap: typing ? null : () => tapText(screen),
      child: l.big
          ? Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: content)
          : Container(
              width: r.width,
              color: const Color(0x8C000000),
              padding: EdgeInsets.symmetric(vertical: size * .5, horizontal: 12),
              alignment: Alignment.center,
              child: content,
            ),
    );

    if (l.big) {
      return Positioned(
        top: y - size * .6,
        left: 0,
        right: 0,
        child: Align(alignment: Alignment(typing ? 0 : (l.x * 2 - 1), 0), child: child),
      );
    }
    return Positioned(top: y - size, left: r.left, child: child);
  }
}

class _Ink extends CustomPainter {
  _Ink(this.strokes, this.screen);
  final List<Stroke> strokes;
  final Size screen;
  @override
  void paint(Canvas canvas, Size size) => paintStrokes(canvas, strokes, screen);
  @override
  bool shouldRepaint(_Ink old) => true;
}

/// Grid of friends and groups to tick, with a send bar that slides up.
class _SendTo extends StatefulWidget {
  const _SendTo({required this.targets, required this.onAddFriends});
  final List<Chat> targets;
  final VoidCallback onAddFriends;
  @override
  State<_SendTo> createState() => _SendToState();
}

class _SendToState extends State<_SendTo> {
  final to = <String>[];

  @override
  Widget build(BuildContext context) {
    final targets = widget.targets.where((t) => !t.away).toList();
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(padding: const EdgeInsets.fromLTRB(24, 0, 24, 8), child: Text('send to', style: font(30, weight: FontWeight.w900))),
      if (targets.isEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(32, 16, 32, 48),
          child: Column(children: [
            Text("No friends yet. Share your code and you're set.", textAlign: TextAlign.center, style: font(18, weight: FontWeight.w600, color: Colors.white60)),
            const SizedBox(height: 16),
            ValueListenableBuilder(
              valueListenable: accent,
              builder: (_, a, _) => Pill(label: 'add friends', color: a, textColor: onColor(a), size: 20, onTap: widget.onAddFriends),
            ),
          ]),
        )
      else
        Flexible(
          child: GridView.count(
            shrinkWrap: true,
            crossAxisCount: 3,
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
            mainAxisSpacing: 18,
            childAspectRatio: .82,
            children: [
              for (final t in targets)
                Press(
                  onTap: () => setState(() => to.contains(t.key) ? to.remove(t.key) : to.add(t.key)),
                  haptic: 5,
                  child: Column(children: [
                    Stack(clipBehavior: Clip.none, children: [
                      Avatar(name: t.name, color: t.color, size: 76, ring: to.contains(t.key), group: t.group),
                      if (to.contains(t.key))
                        Positioned(
                          right: -2,
                          bottom: -2,
                          child: ValueListenableBuilder(
                            valueListenable: accent,
                            builder: (_, a, _) => Container(
                              width: 30,
                              height: 30,
                              decoration: BoxDecoration(color: a, shape: BoxShape.circle),
                              child: Icon(Icons.check_rounded, size: 20, color: onColor(a)),
                            ),
                          ),
                        ),
                    ]),
                    const SizedBox(height: 8),
                    Text(t.name, overflow: TextOverflow.ellipsis, style: font(14, weight: FontWeight.w800, color: to.contains(t.key) ? Colors.white : Colors.white60)),
                  ]),
                ),
            ],
          ),
        ),
      AnimatedSize(
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOutBack,
        child: to.isEmpty
            ? const SizedBox(width: double.infinity)
            : ValueListenableBuilder(
                valueListenable: accent,
                builder: (_, a, _) => Container(
                  color: a,
                  padding: EdgeInsets.fromLTRB(24, 14, 16, MediaQuery.paddingOf(context).bottom + 14),
                  child: Row(children: [
                    Expanded(
                      child: Text(
                        to.map((k) => targets.firstWhere((t) => t.key == k).title).join(', '),
                        overflow: TextOverflow.ellipsis,
                        style: font(20, weight: FontWeight.w900, color: onColor(a)),
                      ),
                    ),
                    Press(
                      onTap: () => Navigator.pop(context, List.of(to)),
                      child: Container(
                        width: 64,
                        height: 64,
                        decoration: const BoxDecoration(color: Colors.black, shape: BoxShape.circle),
                        child: Icon(Icons.send_rounded, size: 28, color: a),
                      ),
                    ),
                  ]),
                ),
              ),
      ),
    ]);
  }
}
