import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kiks/screens/camera.dart';
import 'package:kiks/screens/compose.dart';
import 'package:kiks/screens/preview.dart';
import 'package:kiks/store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  /// Smoke test of the editor: text styles (focus kept while flipping), palette, custom colour, filters.
  testWidgets('editor styles, palette, filters', (t) async {
    SharedPreferences.setMockInitialValues({});
    await Store.init();
    t.view.physicalSize = const Size(1170, 2532);
    t.view.devicePixelRatio = 3;
    final path = await t.runAsync(() async {
      final rec = ui.PictureRecorder();
      Canvas(rec).drawRect(const Rect.fromLTWH(0, 0, 300, 400), Paint()..color = Colors.orange);
      final img = await rec.endRecording().toImage(300, 400);
      final png = (await img.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
      final f = File('${Directory.systemTemp.path}/kiks_test.png');
      await f.writeAsBytes(png);
      return f.path;
    });
    await t.pumpWidget(
      MaterialApp(
        home: Preview(
          capture: Capture(path!, 'photo', crop: 0.6),
          targets: const [],
          preselect: const [],
          onSend: (_, _, _) {},
          onAddFriends: () {},
        ),
      ),
    );
    await t.runAsync(() => Future.delayed(const Duration(milliseconds: 300)));
    await t.pumpAndSettle();
    // tap picture -> text
    await t.tapAt(const Offset(200, 400));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), 'hello');
    for (var i = 0; i < 4; i++) {
      await t.tap(find.byIcon(Icons.title_rounded));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      expect(t.widget<EditableText>(find.byType(EditableText)).focusNode.hasFocus, isTrue);
    }
    // now 'bar' again -> next to big
    await t.tap(find.byIcon(Icons.title_rounded));
    await t.pumpAndSettle();
    expect(find.byType(Palette), findsOneWidget);
    // open custom bar and slide
    await t.tap(find.byIcon(Icons.title_rounded));
    await t.pumpAndSettle();
    await t.tap(find.byType(Palette));
    await t.pumpAndSettle();
    // finish text
    FocusManager.instance.primaryFocus?.unfocus();
    await t.pumpAndSettle();
    expect(find.text('hello'), findsWidgets);
    // drag label
    await t.drag(find.text('hello').last, const Offset(40, -60));
    await t.pumpAndSettle();
    // filters
    await t.tap(find.byIcon(Icons.auto_awesome_rounded));
    await t.pumpAndSettle();
    await t.tap(find.text('warm'));
    await t.pumpAndSettle();
    await t.tap(find.text('done'));
    await t.pumpAndSettle();
    // draw mode, custom colour
    await t.tap(find.byIcon(Icons.edit_rounded));
    await t.pumpAndSettle();
    final p = find.byType(Palette);
    final br = t.getRect(p);
    await t.tapAt(br.bottomCenter - const Offset(0, 20));
    await t.pumpAndSettle();
    await t.dragFrom(br.topCenter + const Offset(0, 40), const Offset(0, 120));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    // paint each style
    final rec = ui.PictureRecorder();
    final c = Canvas(rec);
    for (final s in textStyles) {
      paintLabel(c, TextLabel(text: 'hey', style: s, color: Colors.purple, y: .5, scale: 2), const Size(390, 844), const Rect.fromLTWH(0, 100, 390, 650));
    }
    rec.endRecording();
    expect(cropRect(const Size(3000, 4000), 0.6).size, const Size(2400, 4000));
    expect(cropRect(const Size(4000, 3000), 0.6).size, const Size(4000, 2400));
    expect(spectrumAt(0), const Color(0xFFFFFFFF));
  });
}
