/// Bake drawing + text into what gets sent, at the media's own resolution.
/// Photos come out as one JPEG; videos keep their file and get a PNG layer the same size.
/// Same rules as compose() in frontend/src/screens/Preview.tsx.
library;

import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_image_compress/flutter_image_compress.dart';

import '../ui.dart';
import 'camera.dart';
import 'home.dart';

// Strokes and text are stored in 0..1 coordinates of the screen. The media is shown whole
// (contain), and on send they're mapped onto the full-resolution media through that same
// rect, so nothing is cropped or upscaled.
class Stroke {
  Stroke(this.color, this.width, this.pts);
  final Color color;
  final double width;
  final List<Offset> pts;
}

class TextLabel {
  TextLabel({this.text = '', this.big = false, required this.color, this.x = .5, required this.y});
  String text;
  bool big;
  Color color;
  double x, y;
}

const brush = 0.012; // of screen width
// font sizes as a fraction of screen height, shared by the editor and the output
const fontBar = 0.028, fontBig = 0.065;
const maxSide = 4096;

Rect containRect(Size media, Size box) {
  if (media.isEmpty) return Offset.zero & box;
  final k = (box.width / media.width) < (box.height / media.height) ? box.width / media.width : box.height / media.height;
  final w = media.width * k, h = media.height * k;
  return Rect.fromLTWH((box.width - w) / 2, (box.height - h) / 2, w, h);
}

void paintStrokes(Canvas canvas, List<Stroke> strokes, Size screen) {
  for (final s in strokes) {
    final p = Paint()
      ..color = s.color
      ..strokeWidth = s.width * screen.width
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke;
    if (s.pts.length == 1) {
      final o = Offset(s.pts[0].dx * screen.width, s.pts[0].dy * screen.height);
      canvas.drawCircle(o, p.strokeWidth / 2, p..style = PaintingStyle.fill);
      continue;
    }
    final path = Path();
    for (final (i, pt) in s.pts.indexed) {
      final o = Offset(pt.dx * screen.width, pt.dy * screen.height);
      i == 0 ? path.moveTo(o.dx, o.dy) : path.lineTo(o.dx, o.dy);
    }
    canvas.drawPath(path, p);
  }
}

TextStyle labelStyle(TextLabel l, double size, {Paint? stroke}) => TextStyle(
      fontFamily: 'Nunito',
      fontSize: size,
      fontWeight: l.big ? FontWeight.w900 : FontWeight.w600,
      fontVariations: [ui.FontVariation('wght', l.big ? 900 : 600)],
      color: stroke == null ? (l.big ? l.color : Colors.white) : null,
      foreground: stroke,
    );

void paintLabel(Canvas canvas, TextLabel l, Size screen, Rect r) {
  if (l.text.trim().isEmpty) return;
  final size = (l.big ? fontBig : fontBar) * screen.height;
  final y = l.y * screen.height;
  TextPainter tp(TextStyle st) => TextPainter(text: TextSpan(text: l.text, style: st), textDirection: TextDirection.ltr, maxLines: 1, ellipsis: '…')..layout(maxWidth: r.width * .94);
  if (!l.big) {
    final bh = size * 2;
    canvas.drawRect(Rect.fromLTWH(r.left, y - bh / 2, r.width, bh), Paint()..color = const Color(0x8C000000));
    final t = tp(labelStyle(l, size));
    t.paint(canvas, Offset(r.left + (r.width - t.width) / 2, y - t.height / 2));
  } else {
    final outline = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = size * .14
      ..strokeJoin = StrokeJoin.round
      ..color = l.color == Colors.black ? Colors.white : Colors.black;
    final o = tp(labelStyle(l, size, stroke: outline));
    final f = tp(labelStyle(l, size));
    final at = Offset(l.x * screen.width - f.width / 2, y - f.height / 2);
    o.paint(canvas, at);
    f.paint(canvas, at);
  }
}

String videoMime(String path) {
  final p = path.toLowerCase();
  if (p.endsWith('.webm')) return 'video/webm';
  if (p.endsWith('.mov')) return 'video/quicktime';
  if (p.endsWith('.3gp')) return 'video/3gpp';
  return 'video/mp4';
}

/// Runs after the editor closed. `screen` is the editor's size, `dims` the media's (upright).
Future<Made> compose(Capture cap, Size dims, Size screen, List<Stroke> strokes, TextLabel? label) async {
  final decorated = strokes.isNotEmpty || (label != null && label.text.trim().isNotEmpty);
  final r = containRect(dims, screen);

  if (cap.kind == 'video') {
    final media = await File(cap.path).readAsBytes();
    if (!decorated) return (media: media, overlay: null, mime: videoMime(cap.path));
    final fit = (maxSide / (dims.width > dims.height ? dims.width : dims.height)).clamp(0, 1).toDouble();
    final w = (dims.width * fit).round(), h = (dims.height * fit).round();
    final png = await _render(w, h, screen, r, strokes, label, null, false);
    return (media: media, overlay: png, mime: videoMime(cap.path));
  }

  if (!decorated && !cap.mirror) {
    // nothing to draw: re-encode natively, which also turns it upright and strips EXIF (GPS etc.)
    final jpeg = await FlutterImageCompress.compressWithFile(cap.path, minWidth: 3072, minHeight: 3072, quality: 92, keepExif: false, autoCorrectionAngle: true);
    if (jpeg != null) return (media: jpeg, overlay: null, mime: 'image/jpeg');
  }

  final bytes = await File(cap.path).readAsBytes();
  final probe = await ui.instantiateImageCodec(bytes);
  final first = (await probe.getNextFrame()).image;
  final fit = (maxSide / (first.width > first.height ? first.width : first.height)).clamp(0, 1).toDouble();
  final w = (first.width * fit).round(), h = (first.height * fit).round();
  final img = fit < 1 ? (await (await ui.instantiateImageCodec(bytes, targetWidth: w, targetHeight: h)).getNextFrame()).image : first;
  final png = await _render(w, h, screen, containRect(Size(w.toDouble(), h.toDouble()), screen), strokes, label, img, cap.mirror);
  final jpeg = await FlutterImageCompress.compressWithList(png, minWidth: 8192, minHeight: 8192, quality: 92, format: CompressFormat.jpeg, keepExif: false);
  return (media: jpeg, overlay: null, mime: 'image/jpeg');
}

Future<Uint8List> _render(int w, int h, Size screen, Rect r, List<Stroke> strokes, TextLabel? label, ui.Image? photo, bool mirror) async {
  final rec = ui.PictureRecorder();
  final canvas = Canvas(rec, Rect.fromLTWH(0, 0, w.toDouble(), h.toDouble()));
  if (photo != null) {
    canvas.save();
    if (mirror) {
      canvas.translate(w.toDouble(), 0);
      canvas.scale(-1, 1);
    }
    canvas.drawImageRect(photo, Rect.fromLTWH(0, 0, photo.width.toDouble(), photo.height.toDouble()), Rect.fromLTWH(0, 0, w.toDouble(), h.toDouble()), Paint()..filterQuality = FilterQuality.high);
    canvas.restore();
  }
  // screen px -> media px, through the rect the media is shown in
  final k = w / r.width;
  canvas.scale(k);
  canvas.translate(-r.left, -r.top);
  paintStrokes(canvas, strokes, screen);
  if (label != null) paintLabel(canvas, label, screen, r);
  final out = await rec.endRecording().toImage(w, h);
  final data = await out.toByteData(format: ui.ImageByteFormat.png);
  return data!.buffer.asUint8List();
}

/// Snaps are mostly shown in the accent; kept here so the editor and the composer agree.
const inks = [Colors.white, Colors.black, Color(0xFFFF3D5A), Color(0xFFFF8A3D), Color(0xFFFFE14D), Color(0xFFC6FF3D), Color(0xFF3DD9FF), Color(0xFF7C5CFF), Color(0xFFFF5CD6)];

Color get defaultInk => inks[5];
Color inkOn(Color c) => onColor(c);
