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
  String mode = 'look'; // look | draw | text | filter
  Color ink = defaultInk;
  Look look = looks.first;
  final strokes = <Stroke>[];
  Stroke? drawing;
  TextLabel? label;
  final text = TextEditingController();
  final focus = FocusNode();
  // keeps the field (and the keyboard) when T flips between styles that wrap it differently
  final field = GlobalKey();

  /// the media's size as shown: upright, after the camera's crop
  Size dims = Size.zero;
  VideoPlayerController? video;
  bool sending = false;
  double pinchFrom = 1, twistFrom = 0;

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
        final full = Size(info.image.width.toDouble(), info.image.height.toDouble());
        if (mounted) setState(() => dims = cropRect(full, widget.capture.crop).size);
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
      // another tap on T moves on to the next style, like Snapchat
      setState(() => label!.style = textStyles[(textStyles.indexOf(label!.style) + 1) % textStyles.length]);
      return;
    }
    // start text in the lower part of the picture itself
    final r = containRect(dims, mediaArea(screen, MediaQuery.paddingOf(context).bottom).size);
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

  void pickInk(Color c) => setState(() {
        ink = c;
        if (mode == 'text') label?.color = c;
      });

  void cycleTimer() {
    buzz(5);
    setState(() => seconds = timers[(timers.indexOf(seconds) + 1) % timers.length]);
  }

  void send(List<String> to, Size screen) {
    if (to.isEmpty || sending) return;
    sending = true;
    video?.pause();
    final r = containRect(dims, mediaArea(screen, MediaQuery.paddingOf(context).bottom).size);
    final made = compose(widget.capture, dims, screen, r, List.of(strokes), label, look);
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

  /// Two fingers anywhere resize and rotate the free text; dragging it is on the text itself.
  void pinchStart(ScaleStartDetails d) {
    pinchFrom = label?.scale ?? 1;
    twistFrom = label?.rotation ?? 0;
  }

  void pinch(ScaleUpdateDetails d) {
    final l = label;
    if (l == null || !l.free || d.pointerCount < 2) return;
    setState(() {
      l.scale = (pinchFrom * d.scale).clamp(minScale, maxScale);
      l.rotation = twistFrom + d.rotation;
    });
  }

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    final kb = MediaQuery.viewInsetsOf(context).bottom;
    final colours = mode == 'draw' || (mode == 'text' && label != null && label!.free);
    return Scaffold(
      backgroundColor: Colors.black,
      // the keyboard floats over the snap; nothing moves
      resizeToAvoidBottomInset: false,
      body: LayoutBuilder(builder: (context, box) {
        final screen = box.biggest;
        // the media fills the space above the send bar, like the camera's viewfinder
        final r = containRect(dims, mediaArea(screen, pad.bottom).size);
        return Stack(children: [
          Positioned.fill(child: _media(r)),
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
          // tap the picture to start typing, pinch it to resize the text
          if (mode == 'look')
            Positioned.fill(
              child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: () => tapText(screen), onScaleStart: pinchStart, onScaleUpdate: pinch),
            ),
          if (mode == 'text' || mode == 'filter')
            Positioned.fill(child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: mode == 'text' ? finishText : () => setState(() => mode = 'look'))),
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
              if (mode != 'text') ...[
                const SizedBox(height: 12),
                RoundButton(icon: Icons.edit_rounded, on: mode == 'draw', tint: mode == 'draw' ? ink : null, onTap: () {
                  buzz(6);
                  setState(() => mode = mode == 'draw' ? 'look' : 'draw');
                }),
              ],
              if (colours) ...[
                const SizedBox(height: 10),
                Palette(color: ink, onPick: pickInk),
              ],
              if (mode == 'look' && !isVideo) ...[
                const SizedBox(height: 12),
                RoundButton(icon: Icons.auto_awesome_rounded, tint: look.plain ? null : Colors.white, onTap: () {
                  buzz(6);
                  setState(() => mode = 'filter');
                }),
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
          // the send bar: full width, in the bar under the photo
          if (mode == 'look')
            Positioned(
              left: 16,
              right: 16,
              bottom: pad.bottom + (bottomBar - 60) / 2,
              child: ValueListenableBuilder(
                valueListenable: accent,
                builder: (_, a, _) => Press(
                  onTap: sending ? null : () => widget.preselect.isNotEmpty ? send(widget.preselect, screen) : pickTargets(screen),
                  scale: .97,
                  haptic: 8,
                  child: Container(
                    height: 60,
                    padding: const EdgeInsets.fromLTRB(24, 0, 20, 0),
                    decoration: BoxDecoration(color: a, borderRadius: BorderRadius.circular(99), boxShadow: const [BoxShadow(color: Colors.black38, offset: Offset(0, 4))]),
                    child: Row(children: [
                      Expanded(
                        child: Text(widget.preselect.isNotEmpty ? 'send to ${nameOf(widget.preselect.first)}' : 'send to…',
                            overflow: TextOverflow.ellipsis, style: font(22, weight: FontWeight.w900, color: onColor(a))),
                      ),
                      if (!isVideo) ...[
                        Icon(Icons.timer_rounded, size: 18, color: onColor(a).withValues(alpha: .6)),
                        const SizedBox(width: 3),
                        Text(timerLabel(seconds), style: font(15, weight: FontWeight.w800, color: onColor(a).withValues(alpha: .6))),
                        const SizedBox(width: 14),
                      ],
                      Icon(Icons.send_rounded, size: 26, color: onColor(a)),
                    ]),
                  ),
                ),
              ),
            ),
          if (mode == 'filter')
            Positioned(
              left: 0,
              right: 0,
              bottom: pad.bottom + 24,
              child: Column(children: [
                _filters(),
                const SizedBox(height: 16),
                Pill(label: 'done', color: Colors.white, textColor: Colors.black, size: 20, pad: 16, onTap: () => setState(() => mode = 'look')),
              ]),
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

  Widget _filtered(Look l, Widget child) {
    if (l.matrix != null) child = ColorFiltered(colorFilter: ColorFilter.matrix(l.matrix!), child: child);
    if (l.vignette) child = CustomPaint(foregroundPainter: _Vignette(), child: child);
    return child;
  }

  /// The media in its spot, with the viewfinder's rounded corners.
  Widget _media(Rect r) {
    if (dims.isEmpty) return const SizedBox();
    Widget media;
    if (isVideo) {
      final v = video!;
      media = FittedBox(fit: BoxFit.cover, child: SizedBox(width: v.value.size.width, height: v.value.size.height, child: VideoPlayer(v)));
    } else {
      // the photo whole, or the camera's crop of it (the middle, like the viewfinder)
      media = Image.file(File(widget.capture.path), fit: BoxFit.cover, width: r.width, height: r.height);
      if (widget.capture.mirror) media = Transform.flip(flipX: true, child: media);
      media = _filtered(look, media);
    }
    return Stack(children: [Positioned.fromRect(rect: r, child: ClipRRect(borderRadius: BorderRadius.circular(viewRadius), child: media))]);
  }

  /// The filter strip: the photo in each look, tap one to use it.
  Widget _filters() {
    final thumb = Image.file(File(widget.capture.path), fit: BoxFit.cover, cacheWidth: 240);
    return SizedBox(
      height: 104,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        children: [
          for (final f in looks)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 5),
              child: Press(
                haptic: 4,
                onTap: () => setState(() => look = f),
                child: Column(children: [
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 150),
                    width: 68,
                    height: 76,
                    padding: const EdgeInsets.all(3),
                    decoration: BoxDecoration(borderRadius: BorderRadius.circular(18), color: f == look ? Colors.white : Colors.transparent),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(15),
                      child: _filtered(f, Transform.flip(flipX: widget.capture.mirror, child: thumb)),
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(f.name, style: font(13, weight: FontWeight.w800, color: f == look ? Colors.white : Colors.white70)),
                ]),
              ),
            ),
        ],
      ),
    );
  }

  /// While typing, the text sits just above the keyboard (Snapchat-style) and drops back to its
  /// spot when done. The snap itself never moves.
  Widget _label(Size screen, Rect r, double kb) {
    final l = label!;
    final typing = mode == 'text';
    var size = labelSize(l, screen.height);
    // keep a big pinch from overflowing the screen while typing
    if (typing && l.free) size = size.clamp(0, fontSizes[l.style]! * screen.height * 1.2).toDouble();
    final style = labelStyle(l, size);

    Widget content = typing
        ? ConstrainedBox(
            constraints: BoxConstraints(maxWidth: screen.width * .9),
            child: IntrinsicWidth(
              child: TextField(
                key: field,
                controller: text,
                focusNode: focus,
                maxLength: 80,
                textAlign: TextAlign.center,
                style: style,
                cursorColor: l.style == 'pill' ? onColor(l.color) : Colors.white,
                onChanged: (t) => l.text = t,
                onSubmitted: (_) => finishText(),
                decoration: const InputDecoration(border: InputBorder.none, counterText: '', isDense: true, contentPadding: EdgeInsets.zero),
              ),
            ),
          )
        : (l.free ? Text(l.text, style: style, maxLines: 1, softWrap: false) : Text(l.text, style: style, maxLines: 1, overflow: TextOverflow.ellipsis));
    if (l.style == 'big') {
      content = Stack(children: [
        // the outline: same text under it, stroked
        if (!typing) Text(l.text, style: labelStyle(l, size, stroke: labelOutline(l, size)), maxLines: 1, softWrap: false),
        content,
      ]);
    }

    final child = GestureDetector(
      onScaleStart: typing ? null : pinchStart,
      onScaleUpdate: typing
          ? null
          : (d) => setState(() {
                l.x = (l.x + d.focalPointDelta.dx / screen.width).clamp(l.free ? 0 : .05, l.free ? 1 : .95);
                l.y = (l.y + d.focalPointDelta.dy / screen.height).clamp(.05, .95);
                if (l.free && d.pointerCount >= 2) {
                  l.scale = (pinchFrom * d.scale).clamp(minScale, maxScale);
                  l.rotation = twistFrom + d.rotation;
                }
              }),
      onTap: typing ? null : () => tapText(screen),
      child: switch (l.style) {
        'bar' => Container(
            width: r.width,
            color: const Color(0x8C000000),
            padding: EdgeInsets.symmetric(vertical: size * .5, horizontal: 12),
            alignment: Alignment.center,
            child: content,
          ),
        'pill' => Container(
            padding: EdgeInsets.symmetric(horizontal: size * pillPadX, vertical: size * pillPadY),
            decoration: BoxDecoration(color: l.color, borderRadius: BorderRadius.circular(size * pillRadius)),
            child: content,
          ),
        _ => content,
      },
    );

    if (!l.free) {
      final y = typing && kb > 0 ? screen.height - kb - 24 - size : l.y * screen.height;
      return Positioned(top: y - size, left: r.left, child: child);
    }
    // straight while typing, so the field is easy to edit
    if (typing && kb > 0) return Positioned(left: 0, right: 0, bottom: kb + 24, child: Center(child: child));
    // centred on its spot, as wide as the text (can run off the edges, like the output)
    return Positioned(
      left: l.x * screen.width,
      top: l.y * screen.height,
      child: FractionalTranslation(translation: const Offset(-.5, -.5), child: typing ? child : Transform.rotate(angle: l.rotation, child: child)),
    );
  }
}

/// The ink swatches, plus a rainbow one that swaps them for a bar to pick any colour from.
class Palette extends StatefulWidget {
  const Palette({super.key, required this.color, required this.onPick});
  final Color color;
  final ValueChanged<Color> onPick;
  @override
  State<Palette> createState() => _PaletteState();
}

class _PaletteState extends State<Palette> {
  bool custom = false;
  double at = .5;
  bool sliding = false;
  static const barHeight = 300.0;

  void slide(double y) {
    at = (y / barHeight).clamp(0, 1);
    widget.onPick(spectrumAt(at));
  }

  @override
  Widget build(BuildContext context) {
    final mine = !inks.contains(widget.color);
    return Container(
      padding: const EdgeInsets.all(6),
      decoration: BoxDecoration(color: Colors.black38, borderRadius: BorderRadius.circular(99)),
      child: Column(children: [
        if (!custom)
          for (final c in inks)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Press(
                onTap: () => widget.onPick(c),
                haptic: 4,
                child: AnimatedScale(
                  scale: c == widget.color ? 1.25 : 1,
                  duration: const Duration(milliseconds: 150),
                  child: Container(
                    width: 30,
                    height: 30,
                    decoration: BoxDecoration(color: c, shape: BoxShape.circle, border: Border.all(color: c == widget.color ? Colors.white : Colors.white30, width: 3)),
                  ),
                ),
              ),
            )
        else
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onVerticalDragStart: (d) => setState(() {
                sliding = true;
                slide(d.localPosition.dy);
              }),
              onVerticalDragUpdate: (d) => setState(() => slide(d.localPosition.dy)),
              onVerticalDragEnd: (_) => setState(() => sliding = false),
              onTapDown: (d) => setState(() => slide(d.localPosition.dy)),
              child: SizedBox(
                width: 30,
                height: barHeight,
                child: Stack(clipBehavior: Clip.none, alignment: Alignment.topCenter, children: [
                  Container(
                    width: 22,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(11),
                      border: Border.all(color: Colors.white54, width: 2),
                      gradient: const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: spectrum),
                    ),
                  ),
                  // the handle, with a bigger drop of the colour beside it while sliding
                  Positioned(
                    top: at * barHeight - 15,
                    child: Container(
                      width: 30,
                      height: 30,
                      decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 3)),
                    ),
                  ),
                  if (sliding)
                    Positioned(
                      top: at * barHeight - 26,
                      right: 44,
                      child: Container(
                        width: 52,
                        height: 52,
                        decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 3)),
                      ),
                    ),
                ]),
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Press(
            onTap: () => setState(() => custom = !custom),
            haptic: 4,
            child: AnimatedScale(
              scale: mine && !custom ? 1.25 : 1,
              duration: const Duration(milliseconds: 150),
              child: Container(
                width: 30,
                height: 30,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: mine || custom ? Colors.white : Colors.white30, width: 3),
                  color: mine && !custom ? widget.color : null,
                  gradient: mine && !custom ? null : const SweepGradient(colors: [Color(0xFFFF0000), Color(0xFFFFFF00), Color(0xFF00FF00), Color(0xFF00FFFF), Color(0xFF0000FF), Color(0xFFFF00FF), Color(0xFFFF0000)]),
                ),
                child: custom ? const Icon(Icons.close_rounded, size: 16, color: Colors.white) : null,
              ),
            ),
          ),
        ),
      ]),
    );
  }
}

class _Vignette extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) => paintVignette(canvas, Offset.zero & size);
  @override
  bool shouldRepaint(_Vignette old) => false;
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
