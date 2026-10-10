import 'package:flutter/material.dart';

import '../api.dart';
import '../e2e.dart' as e2e;
import '../models.dart';
import '../passkey.dart';
import '../store.dart';
import '../ui.dart';
import 'home.dart';
import 'keys.dart';
import 'scanner.dart';
import 'terms.dart';

/// Tap your face: devices, keys, colour, timer, blocked people, sign out, delete.
class Settings extends StatefulWidget {
  const Settings({super.key, required this.model, required this.onSignOut, required this.onDeleted});
  final HomeModel model;
  final VoidCallback onSignOut, onDeleted;
  @override
  State<Settings> createState() => _SettingsState();
}

class _SettingsState extends State<Settings> {
  List<Device> devices = [];
  int passkeys = 0;
  List<Friend> blocked = [];
  bool deleting = false;

  /// the "your colour" hue bar is open
  bool hues = false;

  void setColour(String c) {
    accent.value = hex(c);
    model.me = me.copyWith(color: c);
    model.onMe(model.me);
    api.setColor(c).catchError((_) => me);
    setState(() {});
  }
  final confirmName = TextEditingController();
  int seconds = int.tryParse(Store.pref('seconds', '5')) ?? 5;

  HomeModel get model => widget.model;
  User get me => model.me;

  @override
  void initState() {
    super.initState();
    load();
    api.blocks().then((b) => mounted ? setState(() => blocked = b) : null, onError: (_) {});
  }

  Future<void> load() async {
    try {
      final d = await api.devices();
      if (mounted) {
        setState(() {
          devices = d.devices;
          passkeys = d.passkeys;
        });
      }
    } catch (_) {}
  }

  Future<void> addDevice() async {
    final code = await scan(context, 'scan the code on the new device');
    if (code == null || !mounted) return;
    if (await approveCode(context, model, code)) Future.delayed(const Duration(milliseconds: 2500), load);
  }

  Future<void> passkey() async {
    try {
      await addPasskey();
      buzz(15);
      if (mounted) toast(context, 'passkey added 🔑');
      load();
    } on PasskeyCancelled {
      // closed the sheet
    } on ApiError catch (e) {
      if (mounted) toast(context, e.message);
    }
  }

  Future<void> deleteAccount() async {
    try {
      await api.deleteAccount(confirmName.text.replaceFirst('@', ''));
      if (mounted) Navigator.pop(context);
      widget.onDeleted();
    } on ApiError catch (e) {
      if (mounted) toast(context, e.message);
    }
  }

  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
        valueListenable: accent,
        builder: (_, a, _) => ListView(padding: EdgeInsets.fromLTRB(24, 0, 24, MediaQuery.paddingOf(context).bottom + 24), children: [
          Stack(children: [
            Center(
              child: Column(children: [
                Avatar(name: me.username!, color: me.color, size: 96),
                const SizedBox(height: 10),
                Text('@${me.username}', style: font(28, weight: FontWeight.w900)),
                Text(Uri.parse(api.server).host, style: font(13, weight: FontWeight.w700, color: Colors.white30)),
              ]),
            ),
            const Positioned(right: -8, top: 0, child: TermsLink()),
          ]),
          const SizedBox(height: 22),
          Row(children: [
            Expanded(child: _Tile(icon: Icons.qr_code_scanner_rounded, label: 'add a device', onTap: addDevice)),
            const SizedBox(width: 12),
            Expanded(
              child: ValueListenableBuilder(
                valueListenable: e2e.keys,
                builder: (_, k, _) => _Tile(
                  icon: Icons.key_rounded,
                  label: k.locked ? 'set up this device' : 'encryption',
                  on: k.locked,
                  onTap: () => sheet(context, (_) => KeysSheet(me: model.username)),
                ),
              ),
            ),
          ]),
          if (passkeysHere)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: _Tile(icon: Icons.fingerprint_rounded, label: passkeys > 0 ? 'passkeys · $passkeys' : 'add a passkey', onTap: passkey),
            ),
          if (me.admin)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: _Tile(icon: Icons.admin_panel_settings_rounded, label: 'admin: open the web app for reports and appeals', onTap: () => toast(context, '${api.server} → tap your face → admin')),
            ),
          const Label('your colour'),
          Wrap(spacing: 12, runSpacing: 12, children: [
            // a rainbow "+" opens a hue bar for any colour
            Builder(builder: (_) {
              final mine = !accents.any((c) => c.toLowerCase() == me.color.toLowerCase());
              return Press(
                haptic: 6,
                onTap: () => setState(() => hues = !hues),
                child: Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: mine ? hex(me.color) : null,
                    gradient: mine ? null : SweepGradient(colors: [for (var i = 0; i <= 6; i++) hueAt(i / 6)]),
                  ),
                  child: mine
                      ? Icon(Icons.check_rounded, size: 26, color: onColor(hex(me.color)))
                      : const Icon(Icons.add_rounded, size: 28, color: Colors.white, shadows: [Shadow(blurRadius: 4)]),
                ),
              );
            }),
            for (final c in accents)
              Press(
                haptic: 6,
                onTap: () => setColour(c),
                child: Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(color: hex(c), shape: BoxShape.circle),
                  child: c.toLowerCase() == me.color.toLowerCase() ? Icon(Icons.check_rounded, size: 26, color: onColor(hex(c))) : null,
                ),
              ),
          ]),
          if (hues)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: LayoutBuilder(builder: (context, box) {
                String at(Offset p) => hexOf(hueAt(p.dx / box.maxWidth));
                return GestureDetector(
                  onHorizontalDragUpdate: (d) => accent.value = hex(at(d.localPosition)),
                  onHorizontalDragEnd: (_) => setColour(hexOf(accent.value)),
                  onTapUp: (d) => setColour(at(d.localPosition)),
                  child: Container(
                    height: 48,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(99),
                      gradient: LinearGradient(colors: [for (var i = 0; i <= 12; i++) hueAt(i / 12)]),
                    ),
                    child: Text('slide to pick', style: font(14, weight: FontWeight.w900, color: Colors.black54)),
                  ),
                );
              }),
            ),
          const Label('photos show for'),
          Row(children: [
            for (final t in timers)
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: Pill(
                    label: timerLabel(t),
                    size: 20,
                    pad: 14,
                    color: t == seconds ? a : null,
                    textColor: t == seconds ? onColor(a) : null,
                    onTap: () {
                      setState(() => seconds = t);
                      Store.setPref('seconds', '$t');
                    },
                  ),
                ),
              ),
          ]),
          const Label('signed in on'),
          for (final d in devices)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(children: [
                Container(width: 44, height: 44, decoration: const BoxDecoration(color: Colors.white10, shape: BoxShape.circle), child: const Icon(Icons.smartphone_rounded, size: 22)),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text.rich(TextSpan(text: d.label, children: [if (d.isThis) TextSpan(text: ' · this one', style: TextStyle(color: a))]), style: font(16, weight: FontWeight.w800)),
                    Text('active ${ago(d.seenAt).isEmpty ? 'now' : ago(d.seenAt)}', style: font(14, weight: FontWeight.w600, color: Colors.white38)),
                  ]),
                ),
                if (!d.isThis)
                  Press(
                    onTap: () async {
                      await api.removeDevice(d.id).catchError((_) {});
                      load();
                      model.syncKeys();
                    },
                    child: Container(width: 44, height: 44, decoration: const BoxDecoration(color: Colors.white10, shape: BoxShape.circle), child: const Icon(Icons.close_rounded, size: 20, color: Colors.white60)),
                  ),
              ]),
            ),
          const SizedBox(height: 24),
          Pill(
            icon: Icons.logout_rounded,
            label: 'sign out here',
            textColor: Colors.white60,
            color: Colors.white.withValues(alpha: .05),
            onTap: () {
              Navigator.pop(context);
              widget.onSignOut();
            },
          ),
          if (blocked.isNotEmpty) ...[
            const Label('blocked'),
            for (final b in blocked)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(children: [
                  Avatar(name: b.username, color: b.color, size: 44),
                  const SizedBox(width: 12),
                  Expanded(child: Text(b.username, style: font(16, weight: FontWeight.w800))),
                  Pill(
                    label: 'unblock',
                    size: 15,
                    pad: 8,
                    onTap: () async {
                      await api.unblock(b.username).catchError((_) {});
                      setState(() => blocked.remove(b));
                    },
                  ),
                ]),
              ),
          ],
          const SizedBox(height: 32),
          if (!deleting)
            Pill(icon: Icons.delete_rounded, label: 'delete my account', color: Colors.transparent, textColor: Colors.redAccent.withValues(alpha: .8), onTap: () => setState(() => deleting = true))
          else
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(color: Colors.red.withValues(alpha: .1), borderRadius: BorderRadius.circular(32)),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('This deletes @${me.username} for good.', style: font(18, weight: FontWeight.w900, color: Colors.redAccent)),
                const SizedBox(height: 4),
                Text(
                  'Your snaps, chats, friends, devices and passkeys go from the server. Your name is held for 30 days so nobody can pose as you, then anyone can take it. Groups you run pass to the next member.',
                  style: font(14, weight: FontWeight.w600, color: Colors.white60),
                ),
                const SizedBox(height: 14),
                Field(controller: confirmName, hint: 'type ${me.username} to confirm', formatters: [nameFormatter], onChanged: (_) => setState(() {})),
                const SizedBox(height: 12),
                Row(children: [
                  Expanded(child: Pill(label: 'keep it', size: 16, pad: 14, onTap: () => setState(() => deleting = false))),
                  const SizedBox(width: 8),
                  Expanded(child: Pill(label: 'delete', size: 16, pad: 14, color: Colors.red, onTap: confirmName.text == me.username ? deleteAccount : null)),
                ]),
              ]),
            ),
        ]),
      );
}

class _Tile extends StatelessWidget {
  const _Tile({required this.icon, required this.label, required this.onTap, this.on = false});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool on;
  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
        valueListenable: accent,
        builder: (_, a, _) => Press(
          onTap: onTap,
          scale: .95,
          child: Container(
            constraints: const BoxConstraints(minHeight: 112),
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(color: on ? a : Colors.white10, borderRadius: BorderRadius.circular(28)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(icon, size: 30, color: on ? onColor(a) : a),
              const SizedBox(height: 10),
              Text(label, style: font(17, weight: FontWeight.w900, color: on ? onColor(a) : Colors.white, height: 1.1)),
            ]),
          ),
        ),
      );
}

/// A colour on the "your colour" hue bar (0..1): bright and a little soft, so it works as an
/// accent. Same as hueColor in frontend/src/lib/feel.ts.
Color hueAt(double t) => HSVColor.fromAHSV(1, t.clamp(0.0, 1.0) * 360 % 360, .75, 1).toColor();

String hexOf(Color c) => '#${(c.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0').toUpperCase()}';
