import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../api.dart';
import '../e2e.dart' as e2e;
import '../ui.dart';
import 'home.dart';

/// Typed codes can't carry the link key, so both screens show a number to compare.
Future<bool> confirmCheck(BuildContext context, String check) async =>
    await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF1C1C1C),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
        title: Text('does the other screen show', style: font(20, weight: FontWeight.w900)),
        content: Text(check, textAlign: TextAlign.center, style: const TextStyle(fontFamily: 'monospace', fontSize: 34, fontWeight: FontWeight.w900, letterSpacing: 6)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text('no', style: font(18, color: Colors.white60))),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text('yes, same', style: font(18, weight: FontWeight.w900, color: accent.value))),
        ],
      ),
    ) ==
    true;

/// Scanned or typed code from a device that wants in (or wants this account's keys).
Future<bool> approveCode(BuildContext context, HomeModel model, String code) async {
  try {
    final what = await e2e.approve(code, (check) => confirmCheck(context, check));
    buzz(12);
    model.say(what == 'keys' ? 'keys sent 🔑' : 'device added ✨');
    return true;
  } on ApiError catch (e) {
    model.say(e.message);
  } catch (e) {
    model.say('$e');
  }
  return false;
}

/// This device's encryption keys. Locked (signed in without the keys): show a QR for another of
/// your devices to scan, or start fresh keys. Otherwise: your safety code.
class KeysSheet extends StatefulWidget {
  const KeysSheet({super.key, required this.me});
  final String me;
  @override
  State<KeysSheet> createState() => _KeysSheetState();
}

class _KeysSheetState extends State<KeysSheet> {
  String qr = '', code = '', check = '';
  bool stopped = false, resetting = false;

  @override
  void initState() {
    super.initState();
    if (e2e.keys.value.locked) run();
  }

  @override
  void dispose() {
    stopped = true;
    super.dispose();
  }

  Future<void> run() async {
    while (!stopped) {
      e2e.KeyState? done;
      try {
        done = await e2e.requestKeys(widget.me, (q, c, n) {
          if (mounted) {
            setState(() {
              qr = q;
              code = c;
              check = n;
            });
          }
        }, () => stopped);
      } catch (_) {}
      if (done?.ready == true) {
        buzz(12);
        if (mounted) {
          toast(context, 'this device is set up 🔑');
          Navigator.pop(context);
        }
        return;
      }
      if (!stopped) await Future.delayed(const Duration(seconds: 1)); // expired: a fresh code
    }
  }

  Future<void> reset() async {
    if (!resetting) return setState(() => resetting = true);
    try {
      await e2e.resetIdentity(widget.me);
      buzz(12);
      if (mounted) {
        toast(context, 'new keys made 🔑');
        Navigator.pop(context);
      }
    } on ApiError catch (e) {
      if (mounted) toast(context, e.message);
    }
  }

  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
        valueListenable: e2e.keys,
        builder: (_, k, _) => ListView(shrinkWrap: true, padding: EdgeInsets.fromLTRB(24, 0, 24, MediaQuery.paddingOf(context).bottom + 24), children: k.locked
            ? [
                Row(children: [const Icon(Icons.key_rounded, size: 28), const SizedBox(width: 8), Text('set up this device', style: font(28, weight: FontWeight.w900))]),
                const SizedBox(height: 6),
                Text("Snaps and chats are end-to-end encrypted. This device doesn't have your keys yet, so it can't open or send them.",
                    style: font(16, weight: FontWeight.w600, color: Colors.white60)),
                const SizedBox(height: 20),
                ValueListenableBuilder(
                  valueListenable: accent,
                  builder: (_, a, _) => Container(
                    padding: const EdgeInsets.all(20),
                    decoration: BoxDecoration(color: a, borderRadius: BorderRadius.circular(32)),
                    child: Row(children: [
                      SizedBox(
                        width: 128,
                        height: 128,
                        child: qr.isEmpty
                            ? const Center(child: CircularProgressIndicator(color: Colors.black))
                            : QrImageView(data: qr, padding: EdgeInsets.zero, eyeStyle: const QrEyeStyle(color: Colors.black, eyeShape: QrEyeShape.square), dataModuleStyle: const QrDataModuleStyle(color: Colors.black, dataModuleShape: QrDataModuleShape.square)),
                      ),
                      const SizedBox(width: 18),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text('on your other device', style: font(13, weight: FontWeight.w900, color: Colors.black54)),
                          Text('tap your face, add a device, scan this', style: font(17, weight: FontWeight.w900, color: Colors.black, height: 1.1)),
                          const SizedBox(height: 6),
                          Text(code.isEmpty ? '······' : code, style: const TextStyle(fontFamily: 'monospace', fontSize: 22, fontWeight: FontWeight.w900, letterSpacing: 4, color: Colors.black)),
                          if (check.isNotEmpty) Text('check $check', style: font(13, color: Colors.black54)),
                        ]),
                      ),
                    ]),
                  ),
                ),
                const SizedBox(height: 20),
                Pill(
                  label: resetting ? 'tap again: friends will see your key changed' : 'no other device? make new keys',
                  color: resetting ? Colors.red : Colors.white.withValues(alpha: .05),
                  textColor: resetting ? Colors.white : Colors.white60,
                  size: 16,
                  onTap: reset,
                ),
                if (resetting)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text('Your other signed-in devices will need setting up again from this one.',
                        textAlign: TextAlign.center, style: font(14, weight: FontWeight.w600, color: Colors.white54)),
                  ),
              ]
            : [
                Row(children: [const Icon(Icons.verified_user_rounded, size: 28), const SizedBox(width: 8), Text('encrypted', style: font(28, weight: FontWeight.w900))]),
                const SizedBox(height: 6),
                Text('Snaps and chats are end-to-end encrypted. Only the people in the chat can open them, not the server.',
                    style: font(16, weight: FontWeight.w600, color: Colors.white60)),
                const Label('your safety code', top: 20),
                Text(k.fingerprint ?? '…', style: const TextStyle(fontFamily: 'monospace', fontSize: 24, fontWeight: FontWeight.w900, letterSpacing: 1)),
                const SizedBox(height: 10),
                Text("Friends who scan your code in person are verified automatically. If a friend's key changes, you'll see it on their chat.",
                    style: font(14, weight: FontWeight.w600, color: Colors.white54)),
              ]),
      );
}
