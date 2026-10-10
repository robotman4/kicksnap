import 'dart:async';
import 'dart:io';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:video_player/video_player.dart';

import '../models.dart';
import '../store.dart';
import '../ui.dart';
import 'compose.dart';

/// What the shutter (or the gallery) produced.
class Capture {
  Capture(this.path, this.kind, {this.mirror = false, this.fromGallery = false, this.crop});
  final String path;

  /// photo | video
  final String kind;

  /// front camera: show and send it the way the preview looked
  final bool mirror;
  final bool fromGallery;

  /// photos from the camera: crop to this aspect (see viewAspect), like the viewfinder showed
  final double? crop;
}

/// how long a video can be: the server's call (Limits, from /me)
Duration get _maxVideo => Duration(seconds: Limits.current.videoSeconds);
const _hold = Duration(milliseconds: 220);

/// The camera page: a rounded viewfinder (the sensor frame, cropped a little to viewAspect),
/// tap to focus, double tap to flip, pinch to zoom, tap the shutter for a photo, hold it for
/// video, up to the server's limit (30 s by default).
class Camera extends StatefulWidget {
  const Camera({super.key, required this.me, required this.active, required this.unread, required this.onCapture, required this.onChats, required this.onFriends, required this.onSettings});
  final User me;
  final bool active;
  final int unread;
  final void Function(Capture) onCapture;
  final VoidCallback onChats, onFriends, onSettings;
  @override
  State<Camera> createState() => _CameraState();
}

class _CameraState extends State<Camera> with WidgetsBindingObserver, SingleTickerProviderStateMixin {
  CameraController? cam;
  List<CameraDescription> cameras = [];
  bool front = Store.pref('facing', 'environment') == 'user';
  bool denied = false;
  bool recording = false;
  bool flash = false;
  bool holding = false;
  Timer? holdTimer, stopTimer;
  Offset? focusAt;
  int focusN = 0;
  DateTime lastTap = DateTime(0);
  int gen = 0;
  double zoom = 1, minZoom = 1, maxZoom = 1, pinchFrom = 1;
  double? wantZoom;
  bool zoomBusy = false;
  bool showZoom = false;
  Timer? zoomTimer;
  DateTime pinchedAt = DateTime(0);
  late final ring = AnimationController(vsync: this, duration: _maxVideo);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (widget.active) start();
  }

  @override
  void didUpdateWidget(Camera old) {
    super.didUpdateWidget(old);
    if (widget.active != old.active) widget.active ? start() : stop();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive || state == AppLifecycleState.paused) {
      stop();
    } else if (state == AppLifecycleState.resumed && widget.active) {
      start();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    holdTimer?.cancel();
    stopTimer?.cancel();
    zoomTimer?.cancel();
    ring.dispose();
    stop();
    super.dispose();
  }

  Future<void> start() async {
    final mine = ++gen;
    try {
      if (cameras.isEmpty) cameras = await availableCameras();
      final want = front ? CameraLensDirection.front : CameraLensDirection.back;
      final desc = cameras.firstWhere((c) => c.lensDirection == want, orElse: () => cameras.first);
      // max resolution: the whole sensor (4:3 on most phones), so nothing is cropped
      // video bitrate from the server: it sets the file size whatever the resolution
      final c = CameraController(desc, ResolutionPreset.max,
          enableAudio: true, imageFormatGroup: ImageFormatGroup.jpeg, videoBitrate: Limits.current.videoKbps * 1000);
      await c.initialize();
      if (mine != gen || !mounted) {
        await c.dispose();
        return;
      }
      await cam?.dispose();
      cam = c;
      c.setFocusMode(FocusMode.auto).catchError((_) {});
      c.setFlashMode(FlashMode.off).catchError((_) {});
      try {
        minZoom = await c.getMinZoomLevel();
        maxZoom = (await c.getMaxZoomLevel()).clamp(minZoom, 10.0).toDouble();
      } catch (_) {
        minZoom = maxZoom = 1;
      }
      if (mine != gen || !mounted) return;
      zoom = minZoom;
      setState(() => denied = false);
    } on CameraException catch (_) {
      if (mine == gen && mounted) setState(() => denied = true);
    } catch (_) {
      if (mine == gen && mounted) setState(() => denied = true);
    }
  }

  void stop() {
    gen++;
    holding = false;
    holdTimer?.cancel();
    if (recording) endRecording(discard: true);
    final c = cam;
    cam = null;
    if (mounted) setState(() {});
    c?.dispose();
  }

  void flip() {
    buzz(6);
    front = !front;
    Store.setPref('facing', front ? 'user' : 'environment');
    stop();
    start();
  }

  Future<void> photo() async {
    final c = cam;
    if (c == null || !c.value.isInitialized || c.value.isTakingPicture) return;
    setState(() => flash = true);
    Future.delayed(const Duration(milliseconds: 120), () => mounted ? setState(() => flash = false) : null);
    buzz(12);
    try {
      // a real still from the sensor: full resolution, autofocused
      final f = await c.takePicture();
      widget.onCapture(Capture(f.path, 'photo', mirror: front, crop: viewAspect));
    } catch (_) {}
  }

  Future<void> startRecording() async {
    final c = cam;
    if (c == null || !holding) return;
    try {
      await c.startVideoRecording();
    } catch (_) {
      return;
    }
    // let go while the recorder was starting: stop straight away
    if (!holding) return endRecording();
    setState(() => recording = true);
    ring.duration = _maxVideo;
    ring.forward(from: 0);
    buzz(15);
    stopTimer = Timer(_maxVideo, endRecording);
  }

  Future<void> endRecording({bool discard = false}) async {
    stopTimer?.cancel();
    ring.stop();
    final c = cam;
    if (mounted) setState(() => recording = false);
    if (c == null || !c.value.isRecordingVideo) return;
    try {
      final f = await c.stopVideoRecording();
      if (!discard && mounted) widget.onCapture(Capture(f.path, 'video', mirror: front));
    } catch (_) {}
  }

  void shutterDown() {
    holding = true;
    holdTimer?.cancel();
    holdTimer = Timer(_hold, () {
      holdTimer = null;
      startRecording();
    });
  }

  void shutterUp() {
    if (!holding) return;
    holding = false;
    if (holdTimer != null) {
      holdTimer!.cancel();
      holdTimer = null;
      photo();
    } else {
      endRecording();
    }
  }

  Future<void> pickFile() async {
    final f = await ImagePicker().pickMedia(requestFullMetadata: false);
    if (f == null) return;
    final video = (f.mimeType ?? '').startsWith('video') || RegExp(r'\.(mp4|mov|webm|3gp|mkv)$', caseSensitive: false).hasMatch(f.path);
    final problem = await _uploadProblem(f.path, video);
    if (problem != null) {
      if (mounted) toast(context, problem);
      return;
    }
    widget.onCapture(Capture(f.path, video ? 'video' : 'photo', fromGallery: true));
  }

  void pinchStart(ScaleStartDetails d) => pinchFrom = zoom;

  void pinch(ScaleUpdateDetails d) {
    if (d.pointerCount < 2 || cam == null || maxZoom <= minZoom) return;
    pinchedAt = DateTime.now();
    final z = (pinchFrom * d.scale).clamp(minZoom, maxZoom).toDouble();
    if ((z - zoom).abs() < .01) return;
    zoomTimer?.cancel();
    setState(() {
      zoom = z;
      showZoom = true;
    });
    zoomTimer = Timer(const Duration(milliseconds: 900), () => mounted ? setState(() => showZoom = false) : null);
    wantZoom = z;
    if (!zoomBusy) pushZoom();
  }

  /// One zoom call at a time: the plugin is async and a pinch fires many updates.
  Future<void> pushZoom() async {
    final c = cam, z = wantZoom;
    if (c == null || z == null) return;
    wantZoom = null;
    zoomBusy = true;
    await c.setZoomLevel(z).catchError((_) {});
    zoomBusy = false;
    if (wantZoom != null && mounted) pushZoom();
  }

  /// Why the server would turn this down, or null: said here, before it's encrypted and sent.
  Future<String?> _uploadProblem(String path, bool video) async {
    final l = Limits.current;
    if (await File(path).length() > l.uploadMb * 1024 * 1024) return 'too big: snaps can be up to ${l.uploadMb} MB';
    if (!video) return null;
    final v = VideoPlayerController.file(File(path));
    try {
      await v.initialize().timeout(const Duration(seconds: 3));
      if (v.value.duration > Duration(seconds: l.videoSeconds + 1)) return 'too long: videos can be up to ${l.videoSeconds}s';
    } catch (_) {
      // can't tell: let it through, the size cap still holds
    } finally {
      v.dispose();
    }
    return null;
  }

  void tap(TapUpDetails d, Size box) {
    final now = DateTime.now();
    // the end of a pinch isn't a tap
    if (now.difference(pinchedAt) < const Duration(milliseconds: 300)) return;
    // double tap anywhere on the viewfinder flips the camera
    if (now.difference(lastTap) < const Duration(milliseconds: 300)) {
      lastTap = DateTime(0);
      return flip();
    }
    lastTap = now;
    final c = cam;
    if (c == null || !c.value.isInitialized) return;
    // tap point -> 0..1 in the frame, which fills the viewfinder (cover)
    final card = viewfinder(box);
    if (!card.contains(d.localPosition)) return;
    final r = _cover(_frameSize(c), card);
    var x = (d.localPosition.dx - r.left) / r.width;
    final y = (d.localPosition.dy - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    if (front) x = 1 - x;
    setState(() {
      focusAt = d.localPosition;
      focusN++;
    });
    c.setFocusPoint(Offset(x, y)).catchError((_) {});
    c.setExposurePoint(Offset(x, y)).catchError((_) {});
  }

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    final c = cam;
    final ready = c != null && c.value.isInitialized;
    return LayoutBuilder(builder: (context, box) {
      final size = box.biggest;
      final card = viewfinder(size);
      return GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapUp: (d) => tap(d, size),
        // one finger still swipes between pages: the pager wins a plain drag before this does
        onScaleStart: pinchStart,
        onScaleUpdate: pinch,
        child: Stack(fit: StackFit.expand, children: [
          const ColoredBox(color: Colors.black),
          if (ready)
            Positioned.fromRect(
              rect: card,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(viewRadius),
                child: FittedBox(fit: BoxFit.cover, clipBehavior: Clip.hardEdge, child: _preview(c)),
              ),
            ),
          Positioned(
            left: card.left,
            width: card.width,
            top: card.top + 16,
            child: IgnorePointer(
              child: Center(
                child: AnimatedOpacity(
                  opacity: showZoom ? 1 : 0,
                  duration: const Duration(milliseconds: 200),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(99)),
                    child: Text('${(zoom / minZoom).toStringAsFixed(1)}×', style: font(16, weight: FontWeight.w900)),
                  ),
                ),
              ),
            ),
          ),
          if (focusAt != null)
            Positioned(
              key: ValueKey(focusN),
              left: focusAt!.dx - 40,
              top: focusAt!.dy - 40,
              child: IgnorePointer(
                child: TweenAnimationBuilder<double>(
                  tween: Tween(begin: 1.4, end: 1),
                  duration: const Duration(milliseconds: 400),
                  curve: Curves.easeOutBack,
                  builder: (_, s, _) => TweenAnimationBuilder<double>(
                    tween: Tween(begin: 1, end: 0),
                    duration: const Duration(milliseconds: 900),
                    curve: const Interval(.6, 1),
                    builder: (_, o, _) => Opacity(
                      opacity: o,
                      child: Transform.scale(
                        scale: s,
                        child: Container(width: 80, height: 80, decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: accent.value, width: 4))),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          if (denied)
            Container(
              color: const Color(0xFF111111),
              padding: const EdgeInsets.symmetric(horizontal: 40),
              child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                const Text('📷', style: TextStyle(fontSize: 56)),
                const SizedBox(height: 16),
                Text("camera's off", style: font(26, weight: FontWeight.w900)),
                const SizedBox(height: 8),
                Text('Allow camera access for Kiks in your phone settings, or pick something from your gallery.',
                    textAlign: TextAlign.center, style: font(16, weight: FontWeight.w600, color: Colors.white54)),
                const SizedBox(height: 20),
                ValueListenableBuilder(
                  valueListenable: accent,
                  builder: (_, a, _) => Pill(label: 'try again', color: a, textColor: onColor(a), onTap: start),
                ),
              ]),
            ),
          IgnorePointer(
            child: AnimatedOpacity(opacity: flash ? .8 : 0, duration: const Duration(milliseconds: 100), child: const ColoredBox(color: Colors.white)),
          ),
          // top bar
          Positioned(
            left: 0,
            right: 0,
            top: 0,
            child: Container(
              padding: EdgeInsets.fromLTRB(16, pad.top + 14, 16, 40),
              decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.black38, Colors.transparent])),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Press(onTap: widget.onSettings, child: Avatar(name: widget.me.username ?? '', color: widget.me.color, size: 52)),
                const Spacer(),
                Column(children: [
                  RoundButton(icon: Icons.cameraswitch_rounded, onTap: flip),
                  const SizedBox(height: 12),
                  RoundButton(icon: Icons.photo_library_rounded, onTap: pickFile),
                ]),
              ]),
            ),
          ),
          // bottom bar
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: Container(
              padding: EdgeInsets.fromLTRB(32, 64, 32, pad.bottom + 20),
              decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.bottomCenter, end: Alignment.topCenter, colors: [Colors.black38, Colors.transparent])),
              child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                Stack(clipBehavior: Clip.none, children: [
                  RoundButton(icon: Icons.chat_bubble_rounded, size: 64, onTap: widget.onChats),
                  if (widget.unread > 0)
                    Positioned(
                      right: -4,
                      top: -4,
                      child: ValueListenableBuilder(
                        valueListenable: accent,
                        builder: (_, a, _) => Container(
                          constraints: const BoxConstraints(minWidth: 28),
                          height: 28,
                          padding: const EdgeInsets.symmetric(horizontal: 6),
                          alignment: Alignment.center,
                          decoration: BoxDecoration(color: a, borderRadius: BorderRadius.circular(99)),
                          child: Text('${widget.unread}', style: font(13, weight: FontWeight.w900, color: onColor(a))),
                        ),
                      ),
                    ),
                ]),
                _Shutter(recording: recording, ring: ring, onDown: shutterDown, onUp: shutterUp),
                RoundButton(icon: Icons.group_rounded, size: 64, onTap: widget.onFriends),
              ]),
            ),
          ),
        ]),
      );
    });
  }

  Widget _preview(CameraController c) {
    final s = _frameSize(c);
    // the plugin already shows the front camera mirrored, like a mirror
    return SizedBox(width: s.width, height: s.height, child: c.buildPreview());
  }
}

const viewRadius = 24.0;

/// Where the viewfinder sits: viewAspect, as big as fits, centred. That's the same spot the
/// editor shows the photo afterwards (contain), so nothing jumps after the shutter.
Rect viewfinder(Size box) => _contain(const Size(viewAspect, 1), box);

/// Preview size in portrait (the plugin reports it landscape).
Size _frameSize(CameraController c) {
  final s = c.value.previewSize ?? const Size(4, 3);
  return Size(s.shortestSide, s.longestSide);
}

Rect _contain(Size media, Size box) {
  final k = (box.width / media.width).clamp(0, box.height / media.height).toDouble();
  final w = media.width * k, h = media.height * k;
  return Rect.fromLTWH((box.width - w) / 2, (box.height - h) / 2, w, h);
}

Rect _cover(Size media, Rect box) {
  final k = box.width / media.width > box.height / media.height ? box.width / media.width : box.height / media.height;
  final w = media.width * k, h = media.height * k;
  return Rect.fromLTWH(box.left + (box.width - w) / 2, box.top + (box.height - h) / 2, w, h);
}

class _Shutter extends StatelessWidget {
  const _Shutter({required this.recording, required this.ring, required this.onDown, required this.onUp});
  final bool recording;
  final AnimationController ring;
  final VoidCallback onDown, onUp;
  @override
  Widget build(BuildContext context) => Listener(
        onPointerDown: (_) => onDown(),
        onPointerUp: (_) => onUp(),
        onPointerCancel: (_) => onUp(),
        // the pager mustn't steal a hold
        child: GestureDetector(
          onHorizontalDragStart: (_) {},
          child: AnimatedScale(
            scale: recording ? 1.25 : 1,
            duration: const Duration(milliseconds: 300),
            curve: Curves.easeOutBack,
            child: SizedBox(
              width: 100,
              height: 100,
              child: AnimatedBuilder(
                animation: ring,
                builder: (_, _) => CustomPaint(
                  painter: _ShutterPaint(recording ? ring.value : null, accent.value),
                  child: Center(
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 300),
                      width: recording ? 32 : 0,
                      height: recording ? 32 : 0,
                      decoration: const BoxDecoration(color: red, shape: BoxShape.circle),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
}

class _ShutterPaint extends CustomPainter {
  _ShutterPaint(this.progress, this.accent);
  final double? progress;
  final Color accent;
  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.width / 2 - 6;
    canvas.drawCircle(c, r - 6, Paint()..color = Colors.white.withValues(alpha: .15));
    canvas.drawCircle(c, r, Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = 7);
    if (progress != null) {
      canvas.drawArc(Rect.fromCircle(center: c, radius: r), -1.5708, 6.2832 * progress!, false, Paint()
        ..color = accent
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeWidth = 7);
    }
  }

  @override
  bool shouldRepaint(_ShutterPaint old) => old.progress != progress || old.accent != accent;
}
