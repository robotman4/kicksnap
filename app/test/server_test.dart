import 'package:flutter_test/flutter_test.dart';
import 'package:kiks/api.dart';

void main() {
  test('plain http only for a server on your own network', () {
    for (final ok in ['https://kiks.example.com', 'http://192.168.1.20:8080', 'http://10.0.2.2:8000', 'http://127.0.0.1:8765', 'http://nas.local', 'http://100.101.1.2']) {
      expect(cleartextOk(ok), isTrue, reason: ok);
    }
    for (final bad in ['http://kiks.example.com', 'http://8.8.8.8', 'http://172.32.0.1', 'ftp://x']) {
      expect(cleartextOk(bad), isFalse, reason: bad);
    }
  });
}
