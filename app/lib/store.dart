/// Where this device keeps things. Secrets (device token, private keys, pinned contact keys)
/// go in the Android Keystore / iOS Keychain via flutter_secure_storage; small preferences
/// go in shared_preferences.
library;

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

class Store {
  static const _secure = FlutterSecureStorage(
    iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device),
  );
  static late SharedPreferences _prefs;

  /// Tests run without platform channels: everything lives in this map instead.
  static Map<String, String>? memory;

  static Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
  }

  static Future<String?> _read(String k) async => memory != null ? memory![k] : _secure.read(key: k);
  static Future<void> _write(String k, String? v) async {
    if (memory != null) {
      v == null ? memory!.remove(k) : memory![k] = v;
    } else {
      v == null ? await _secure.delete(key: k) : await _secure.write(key: k, value: v);
    }
  }

  // --- secrets ----------------------------------------------------------------------

  static Future<String?> token() => _read('token');
  static Future<void> setToken(String? t) => _write('token', t);

  static Future<Map<String, dynamic>?> readJson(String key) async {
    final s = await _read(key);
    if (s == null) return null;
    try {
      return jsonDecode(s) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  static Future<void> writeJson(String key, Map<String, dynamic>? v) => _write(key, v == null ? null : jsonEncode(v));

  // --- preferences --------------------------------------------------------------------

  static String get server => _prefs.getString('server') ?? const String.fromEnvironment('KIKS_SERVER');
  static Future<void> setServer(String s) => _prefs.setString('server', s);

  static String pref(String key, String fallback) => _prefs.getString('pref.$key') ?? fallback;
  static Future<void> setPref(String key, String value) => _prefs.setString('pref.$key', value);
}
