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

/// Text styles, in the order tapping T cycles through them: the full-width bar, then the
/// free ones (bold outline, colour pill, soft shadow) that move with a drag and resize with a pinch.
const textStyles = ['bar', 'big', 'pill', 'soft'];

class TextLabel {
  TextLabel({this.text = '', this.style = 'bar', required this.color, this.x = .5, required this.y, this.scale = 1});
  String text;
  String style;
  Color color;
  double x, y;

  /// pinch size of the free styles
  double scale;
  bool get free => style != 'bar';
}

const brush = 0.012; // of screen width
// font sizes as a fraction of screen height, shared by the editor and the output
const fontSizes = {'bar': 0.028, 'big': 0.065, 'pill': 0.045, 'soft': 0.055};
const minScale = .4, maxScale = 4.0;
const maxSide = 4096;

double labelSize(TextLabel l, double screenH) => fontSizes[l.style]! * screenH * (l.free ? l.scale : 1);

/// The camera's viewfinder and photos are cropped to this (portrait width / height):
/// a bit taller than the sensor's 3:4, so the picture fills more of the screen.
const viewAspect = 3 / 5;

/// The centre part of `full` with the long side / short side ratio of `aspect`
/// (portrait or landscape, following the media).
Rect cropRect(Size full, double? aspect) {
  if (aspect == null || full.isEmpty) return Offset.zero & full;
  final a = full.width > full.height ? 1 / aspect : aspect;
  final w = full.width / full.height > a ? full.height * a : full.width;
  final h = w / a;
  return Rect.fromLTWH((full.width - w) / 2, (full.height - h) / 2, w, h);
}

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

const _weights = {'bar': 600, 'big': 900, 'pill': 800, 'soft': 800};

TextStyle labelStyle(TextLabel l, double size, {Paint? stroke}) {
  final w = _weights[l.style]!;
  return TextStyle(
    fontFamily: 'Nunito',
    fontSize: size,
    fontWeight: FontWeight.values[w ~/ 100 - 1],
    fontVariations: [ui.FontVariation('wght', w.toDouble())],
    color: stroke != null
        ? null
        : switch (l.style) {
            'bar' => Colors.white,
            'pill' => onColor(l.color),
            _ => l.color,
          },
    foreground: stroke,
    shadows: l.style == 'soft' && stroke == null ? [Shadow(color: const Color(0x99000000), offset: Offset(0, size * .06), blurRadius: size * .18)] : null,
  );
}

/// The outline of the bold style: black, or white on very dark colours.
Paint labelOutline(TextLabel l, double size) => Paint()
  ..style = PaintingStyle.stroke
  ..strokeWidth = size * .14
  ..strokeJoin = StrokeJoin.round
  ..color = l.color.computeLuminance() < .08 ? Colors.white : Colors.black;

/// Padding of the pill style around its text, as a fraction of the font size.
const pillPadX = .45, pillPadY = .2, pillRadius = .35;

void paintLabel(Canvas canvas, TextLabel l, Size screen, Rect r) {
  if (l.text.trim().isEmpty) return;
  final size = labelSize(l, screen.height);
  final y = l.y * screen.height;
  TextPainter tp(TextStyle st, {double? maxWidth}) =>
      TextPainter(text: TextSpan(text: l.text, style: st), textDirection: TextDirection.ltr, maxLines: 1, ellipsis: maxWidth == null ? null : '…')..layout(maxWidth: maxWidth ?? double.infinity);
  if (!l.free) {
    final bh = size * 2;
    canvas.drawRect(Rect.fromLTWH(r.left, y - bh / 2, r.width, bh), Paint()..color = const Color(0x8C000000));
    final t = tp(labelStyle(l, size), maxWidth: r.width * .94);
    t.paint(canvas, Offset(r.left + (r.width - t.width) / 2, y - t.height / 2));
    return;
  }
  // the free styles are one line, centred on their spot, as wide as the text
  final f = tp(labelStyle(l, size));
  final c = Offset(l.x * screen.width, y);
  final at = c - Offset(f.width / 2, f.height / 2);
  if (l.style == 'pill') {
    final box = Rect.fromCenter(center: c, width: f.width + size * pillPadX * 2, height: f.height + size * pillPadY * 2);
    canvas.drawRRect(RRect.fromRectAndRadius(box, Radius.circular(size * pillRadius)), Paint()..color = l.color);
  }
  if (l.style == 'big') tp(labelStyle(l, size, stroke: labelOutline(l, size))).paint(canvas, at);
  f.paint(canvas, at);
}

String videoMime(String path) {
  final p = path.toLowerCase();
  if (p.endsWith('.webm')) return 'video/webm';
  if (p.endsWith('.mov')) return 'video/quicktime';
  if (p.endsWith('.3gp')) return 'video/3gpp';
  return 'video/mp4';
}

/// Runs after the editor closed. `screen` is the editor's size, `dims` the media's as shown
/// (upright, after the crop). Photos come out cropped to `cap.crop` and with the `look` filter.
Future<Made> compose(Capture cap, Size dims, Size screen, List<Stroke> strokes, TextLabel? label, Look look) async {
  final decorated = strokes.isNotEmpty || (label != null && label.text.trim().isNotEmpty);
  final r = containRect(dims, screen);

  if (cap.kind == 'video') {
    final media = await File(cap.path).readAsBytes();
    if (!decorated) return (media: media, overlay: null, mime: videoMime(cap.path));
    final fit = (maxSide / (dims.width > dims.height ? dims.width : dims.height)).clamp(0, 1).toDouble();
    final w = (dims.width * fit).round(), h = (dims.height * fit).round();
    final png = await _render(w, h, screen, r, strokes, label, null, Rect.zero, false, null);
    return (media: media, overlay: png, mime: videoMime(cap.path));
  }

  if (!decorated && !cap.mirror && cap.crop == null && look.matrix == null) {
    // nothing to draw: re-encode natively, which also turns it upright and strips EXIF (GPS etc.)
    final jpeg = await FlutterImageCompress.compressWithFile(cap.path, minWidth: 3072, minHeight: 3072, quality: 92, keepExif: false, autoCorrectionAngle: true);
    if (jpeg != null) return (media: jpeg, overlay: null, mime: 'image/jpeg');
  }

  final bytes = await File(cap.path).readAsBytes();
  final img = (await (await ui.instantiateImageCodec(bytes)).getNextFrame()).image;
  final src = cropRect(Size(img.width.toDouble(), img.height.toDouble()), cap.crop);
  final fit = (maxSide / (src.width > src.height ? src.width : src.height)).clamp(0, 1).toDouble();
  final w = (src.width * fit).round(), h = (src.height * fit).round();
  final png = await _render(w, h, screen, containRect(Size(w.toDouble(), h.toDouble()), screen), strokes, label, img, src, cap.mirror, look.matrix);
  final jpeg = await FlutterImageCompress.compressWithList(png, minWidth: 8192, minHeight: 8192, quality: 92, format: CompressFormat.jpeg, keepExif: false);
  return (media: jpeg, overlay: null, mime: 'image/jpeg');
}

Future<Uint8List> _render(int w, int h, Size screen, Rect r, List<Stroke> strokes, TextLabel? label, ui.Image? photo, Rect src, bool mirror, List<double>? matrix) async {
  final rec = ui.PictureRecorder();
  final canvas = Canvas(rec, Rect.fromLTWH(0, 0, w.toDouble(), h.toDouble()));
  if (photo != null) {
    canvas.save();
    if (mirror) {
      canvas.translate(w.toDouble(), 0);
      canvas.scale(-1, 1);
    }
    final paint = Paint()..filterQuality = FilterQuality.high;
    if (matrix != null) paint.colorFilter = ColorFilter.matrix(matrix);
    canvas.drawImageRect(photo, src, Rect.fromLTWH(0, 0, w.toDouble(), h.toDouble()), paint);
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

/// Photo filters: a colour matrix each (5x4, offsets in 0..255).
/// Same numbers as LOOKS in frontend/src/lib/looks.ts.
class Look {
  const Look(this.name, this.matrix);
  final String name;
  final List<double>? matrix;
}

const looks = [
  Look('original', null),
  Look('vivid', [1.4627, -0.3476, -0.0351, 0, -10.24, -0.1033, 1.2184, -0.0351, 0, -10.24, -0.1033, -0.3476, 1.5309, 0, -10.24, 0, 0, 0, 1, 0]),
  Look('warm', [1.1435, -0.0758, -0.0077, 0, 12, -0.0213, 1.0285, -0.0072, 0, 4, -0.0183, -0.0615, 0.9398, 0, 0, 0, 0, 0, 1, 0]),
  Look('cool', [0.9354, -0.0322, -0.0032, 0, 0, -0.0106, 1.0142, -0.0036, 0, 4, -0.0115, -0.0386, 1.1301, 0, 16, 0, 0, 0, 1, 0]),
  Look('mono', [0.2126, 0.7152, 0.0722, 0, 0, 0.2126, 0.7152, 0.0722, 0, 0, 0.2126, 0.7152, 0.0722, 0, 0, 0, 0, 0, 1, 0]),
  Look('noir', [0.3083, 1.037, 0.1047, 0, -67.6, 0.3083, 1.037, 0.1047, 0, -67.6, 0.3083, 1.037, 0.1047, 0, -67.6, 0, 0, 0, 1, 0]),
  Look('fade', [0.5558, 0.3083, 0.0567, 0, 37.04, 0.1175, 0.7095, 0.0513, 0, 37.04, 0.0965, 0.2373, 0.4681, 0, 37.04, 0, 0, 0, 1, 0]),
];

/// Snaps are mostly shown in the accent; kept here so the editor and the composer agree.
const inks = [Colors.white, Colors.black, Color(0xFFFF3D5A), Color(0xFFFF8A3D), Color(0xFFFFE14D), Color(0xFFC6FF3D), Color(0xFF3DD9FF), Color(0xFF7C5CFF), Color(0xFFFF5CD6)];

Color get defaultInk => inks[5];

/// The custom colour bar, top to bottom. Same stops as SPECTRUM in frontend/src/lib/looks.ts.
const spectrum = [
  Color(0xFFFFFFFF), Color(0xFFFF0000), Color(0xFFFF8000), Color(0xFFFFFF00), Color(0xFF00FF00),
  Color(0xFF00FFFF), Color(0xFF0000FF), Color(0xFF8000FF), Color(0xFFFF00FF), Color(0xFF000000),
];

/// The colour at 0..1 down the bar.
Color spectrumAt(double t) {
  final p = t.clamp(0.0, 1.0) * (spectrum.length - 1);
  final i = p.floor().clamp(0, spectrum.length - 2);
  return Color.lerp(spectrum[i], spectrum[i + 1], p - i)!;
}
Color inkOn(Color c) => onColor(c);
