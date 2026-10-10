import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kiks/screens/scanner.dart';

void main() {
  testWidgets('type it instead', (t) async {
    String? got;
    await t.pumpWidget(MaterialApp(home: Builder(builder: (c) => TextButton(onPressed: () async => got = await scan(c, 'scan'), child: const Text('go!')))));
    await t.tap(find.text('go!'));
    for (var i = 0; i < 20; i++) {
      await t.pump(const Duration(milliseconds: 100));
    }
    await t.tap(find.text('type it instead'));
    for (var i = 0; i < 5; i++) {
      await t.pump(const Duration(milliseconds: 100));
    }
    await t.enterText(find.byType(TextField), 'AB12CD');
    await t.tap(find.text('go'));
    await t.pump(const Duration(seconds: 1));
    expect(got, 'AB12CD');
  });
}
