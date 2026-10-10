/// Passkeys through the platform (Android Credential Manager, see MainActivity.kt). Same server
/// endpoints and the same passkeys as the web app: one made in the browser on this server works here.
///
/// Android only for now. Android trusts the app for any Kiks server, since every server serves
/// /.well-known/assetlinks.json naming it. iOS needs each server's domain compiled into the app
/// (Associated Domains, paid Apple account), see app/README.md.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import 'api.dart';
import 'models.dart';

const _channel = MethodChannel('kiks/passkey');

bool get passkeysHere => Platform.isAndroid;

/// The person closed the passkey sheet: say nothing.
class PasskeyCancelled implements Exception {}

Future<Object> _ask(String method, String options) async {
  try {
    final json = await _channel.invokeMethod<String>(method, options);
    return jsonDecode(json!) as Object;
  } on PlatformException catch (e) {
    if (e.code == 'cancelled') throw PasskeyCancelled();
    if (e.code == 'none') throw ApiError(404, 'no passkey for this server on this phone');
    throw ApiError(400, await _whyNot() ?? e.message ?? "passkey didn't work");
  }
}

/// The usual reason Android refuses: the server doesn't (yet) say it trusts this app.
Future<String?> _whyNot() async {
  final host = Uri.parse(api.server).host;
  try {
    final r = await http.get(Uri.parse('${api.server}/.well-known/assetlinks.json')).timeout(const Duration(seconds: 8));
    final links = r.statusCode == 200 ? jsonDecode(r.body) : null;
    final ok = links is List && links.any((l) => l is Map && (l['target'] as Map?)?['package_name'] == appId);
    if (!ok) return "$host doesn't list this app in /.well-known/assetlinks.json yet";
  } on FormatException {
    return '$host needs an update before passkeys work in the app (no /.well-known/assetlinks.json)';
  } catch (_) {
    return null; // can't tell
  }
  return null;
}

const appId = 'com.getkiks.app';

Future<User> signInWithPasskey() async {
  final b = await api.passkeyBegin('login');
  return api.passkeyLoginFinish(b.id, await _ask('get', b.options));
}

Future<void> addPasskey() async {
  final b = await api.passkeyBegin('register');
  await api.passkeyRegisterFinish(b.id, await _ask('create', b.options));
}
