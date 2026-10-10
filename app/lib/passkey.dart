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
    throw ApiError(400, e.message ?? "passkey didn't work");
  }
}

Future<User> signInWithPasskey() async {
  final b = await api.passkeyBegin('login');
  return api.passkeyLoginFinish(b.id, await _ask('get', b.options));
}

Future<void> addPasskey() async {
  final b = await api.passkeyBegin('register');
  await api.passkeyRegisterFinish(b.id, await _ask('create', b.options));
}
