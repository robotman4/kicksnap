import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:video_player/video_player.dart';

import '../api.dart';
import '../e2e.dart' as e2e;
import '../models.dart';
import '../ui.dart';
import 'report.dart';

/// Full-screen snap player. Tap to skip, swipe down to close. Each snap burns once shown.
/// Pops with the chat key on "snap back".
class Viewer extends StatefulWidget {
  const Viewer({super.key, required this.chat});
  final Chat chat;
  @override
  State<Viewer> createState() => _ViewerState();
}

/// Android: blocks screenshots and screen recording while a snap is open (FLAG_SECURE).
/// iOS can't block them; nothing happens there.
const _secure = MethodChannel('kiks/secure');

class _ViewerState extends State<Viewer> with SingleTickerProviderStateMixin {
  int i = 0;
  e2e.OpenedSnap? shown;
  String? cant;
  VideoPlayerController? video;
  File? tmp;
  double dy = 0;
  bool reporting = false;
  late final progress = AnimationController(vsync: this);
  int gen = 0;

  List<SnapMeta> get snaps => widget.chat.snaps;

  @override
  void initState() {
    super.initState();
    _secure.invokeMethod('on').catchError((_) {});
    progress.addStatusListener((s) {
      if (s == AnimationStatus.completed) next();
    });
    load();
  }

  @override
  void dispose() {
    _secure.invokeMethod('off').catchError((_) {});
    progress.dispose();
    _clear();
    super.dispose();
  }

  void _clear() {
    video?.dispose();
    video = null;
    tmp?.delete().catchError((_) => tmp!);
    tmp = null;
  }

  Future<void> load() async {
    if (i >= snaps.length) return _done();
    final mine = ++gen;
    final snap = snaps[i];
    progress.stop();
    progress.value = 0;
    setState(() {
      shown = null;
      cant = null;
      _clear();
    });
    try {
      final r = await e2e.openSnap(snap, widget.chat);
      if (mine != gen || !mounted) return;
      // can't open it here: say why, and don't burn it, another device may still open it
      if (!r.ok) return setState(() => cant = r.why);
      if (r.kind == 'video') {
        final dir = await getTemporaryDirectory();
        final ext = r.mime.contains('webm') ? 'webm' : r.mime.contains('quicktime') ? 'mov' : 'mp4';
        tmp = File('${dir.path}/snap-${snap.id}.$ext');
        await tmp!.writeAsBytes(r.media!, flush: true);
        final v = VideoPlayerController.file(tmp!);
        await v.initialize();
        if (mine != gen || !mounted) {
          await v.dispose();
          return;
        }
        video = v;
        v.addListener(() {
          final val = v.value;
          if (val.isInitialized && !val.isPlaying && val.position >= val.duration && val.duration > Duration.zero) next();
        });
        v.play();
      }
      setState(() => shown = r);
      api.openSnap(snap.id).catchError((_) {});
      if (r.kind == 'photo' && r.seconds > 0 && !reporting) {
        progress.duration = Duration(seconds: r.seconds);
        progress.forward(from: 0);
      }
    } catch (_) {
      if (mine == gen && mounted) next();
    }
  }

  void next() {
    if (!mounted || reporting) return;
    buzz(5);
    if (i + 1 < snaps.length) {
      i++;
      load();
    } else {
      _done();
    }
  }

  void _done([String? back]) {
    gen++;
    if (mounted && Navigator.of(context).canPop()) Navigator.pop(context, back);
  }

  Future<void> report() async {
    final s = shown;
    setState(() => reporting = true);
    progress.stop();
    video?.pause();
    final blocked = await sheet<bool>(
      context,
      (_) => ReportSheet(username: snaps[i].sender.isEmpty ? widget.chat.name : snaps[i].sender, snap: s, model: null),
      full: true,
    );
    if (!mounted) return;
    setState(() => reporting = false);
    if (blocked == true) return _done();
    // the timer carries on where it was
    if (s?.kind == 'photo' && (s?.seconds ?? 0) > 0) progress.forward();
    video?.play();
  }

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    if (i >= snaps.length) return const Scaffold();
    final snap = snaps[i];
    final s = shown;
    final timed = s != null && s.kind == 'photo' && s.seconds > 0;
    return Scaffold(
      backgroundColor: Colors.black,
      body: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: next,
        onVerticalDragUpdate: (d) => setState(() => dy = (dy + d.delta.dy).clamp(0, 1000)),
        onVerticalDragEnd: (_) {
          if (dy > 120) return _done();
          setState(() => dy = 0);
        },
        child: Transform.translate(
          offset: Offset(0, dy),
          child: Transform.scale(
            scale: 1 - dy / 2000,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(dy > 0 ? 24 : 0),
              child: Stack(fit: StackFit.expand, children: [
                const ColoredBox(color: Colors.black),
                if (s == null && cant == null) const Center(child: Spinner()),
                if (cant != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 40),
                    child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                      const Text('🔒', style: TextStyle(fontSize: 48)),
                      const SizedBox(height: 12),
                      Text(cant == 'nokey' ? "can't open this one here" : "this snap didn't check out", textAlign: TextAlign.center, style: font(24, weight: FontWeight.w900)),
                      const SizedBox(height: 8),
                      Text(
                        cant == 'nokey' ? 'It was sent before this device was set up. Open it on your other device.' : "It couldn't be decrypted or verified, so it isn't shown. Tap to skip.",
                        textAlign: TextAlign.center,
                        style: font(16, weight: FontWeight.w600, color: Colors.white60),
                      ),
                    ]),
                  ),
                if (s != null && s.kind == 'photo') Image.memory(s.media!, fit: BoxFit.contain, gaplessPlayback: true),
                if (s != null && s.kind == 'video' && video != null)
                  FittedBox(fit: BoxFit.contain, child: SizedBox(width: video!.value.size.width, height: video!.value.size.height, child: VideoPlayer(video!))),
                if (s?.overlay != null) IgnorePointer(child: Image.memory(s!.overlay!, fit: BoxFit.contain)),
                // top: progress bars, who, report
                Positioned(
                  left: 0,
                  right: 0,
                  top: 0,
                  child: Container(
                    padding: EdgeInsets.fromLTRB(12, pad.top + 10, 12, 32),
                    decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.black54, Colors.transparent])),
                    child: Column(children: [
                      Row(children: [
                        for (final (n, _) in snaps.indexed)
                          Expanded(
                            child: Container(
                              height: 4,
                              margin: const EdgeInsets.symmetric(horizontal: 2),
                              decoration: BoxDecoration(color: Colors.white30, borderRadius: BorderRadius.circular(2)),
                              alignment: Alignment.centerLeft,
                              child: AnimatedBuilder(
                                animation: progress,
                                builder: (_, _) => FractionallySizedBox(
                                  widthFactor: n < i ? 1 : n == i ? (timed ? progress.value : (s != null ? 1 : 0)) : 0,
                                  child: Container(decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(2))),
                                ),
                              ),
                            ),
                          ),
                      ]),
                      const SizedBox(height: 12),
                      Row(children: [
                        Avatar(name: widget.chat.name, color: widget.chat.color, size: 36, group: widget.chat.group),
                        const SizedBox(width: 10),
                        Flexible(
                          child: Text(widget.chat.group ? '${snap.sender} · ${widget.chat.name}' : widget.chat.name,
                              overflow: TextOverflow.ellipsis, style: font(16, weight: FontWeight.w800)),
                        ),
                        const SizedBox(width: 8),
                        Text(ago(snap.createdAt), style: font(14, weight: FontWeight.w600, color: Colors.white60)),
                        const Spacer(),
                        RoundButton(icon: Icons.flag_rounded, size: 40, onTap: report),
                      ]),
                    ]),
                  ),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: pad.bottom + 18,
                  child: Center(
                    child: ValueListenableBuilder(
                      valueListenable: accent,
                      builder: (_, a, _) => Press(
                        onTap: () => _done(widget.chat.key),
                        scale: .95,
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
                          decoration: BoxDecoration(color: a, borderRadius: BorderRadius.circular(99), boxShadow: const [BoxShadow(color: Colors.black38, offset: Offset(0, 6))]),
                          child: Text('snap back', style: font(21, weight: FontWeight.w900, color: onColor(a))),
                        ),
                      ),
                    ),
                  ),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
