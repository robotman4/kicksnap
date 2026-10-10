import 'dart:async';

import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../api.dart';
import '../e2e.dart' as e2e;
import '../models.dart';
import '../store.dart';
import '../ui.dart';
import 'terms.dart';

/// First thing a new device sees. Two giant buttons, no passwords anywhere.
/// Starts on the public server; the server pill at the top switches to a self-hosted one.
class Welcome extends StatefulWidget {
  const Welcome({super.key, required this.onIn});
  final void Function(User) onIn;
  @override
  State<Welcome> createState() => _WelcomeState();
}

class _WelcomeState extends State<Welcome> {
  late String step = api.server.isEmpty ? 'server' : 'hi';
  bool busy = false;
  String error = '';
  final serverField = TextEditingController(text: api.server.replaceFirst('https://', ''));

  Future<void> setServer() async {
    final s = normalizeServer(serverField.text);
    if (s.isEmpty) return;
    setState(() {
      busy = true;
      error = '';
    });
    final prev = api.server;
    api.server = s;
    try {
      await api.get('/health');
      await Store.setServer(s);
      setState(() => step = 'hi');
    } on ApiError catch (e) {
      api.server = prev;
      setState(() => error = e.status == 0 ? e.message : "that doesn't look like a Kiks server");
    } catch (_) {
      api.server = prev;
      setState(() => error = "that doesn't look like a Kiks server");
    } finally {
      setState(() => busy = false);
    }
  }

  Future<void> fresh() async {
    setState(() {
      busy = true;
      error = '';
    });
    try {
      widget.onIn(await api.startFresh());
    } on ApiError catch (e) {
      setState(() {
        error = e.status == 0 ? "can't reach ${Uri.parse(api.server).host}. tap it at the top to pick another server." : e.message;
        busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (step == 'back') return _Back(onBack: () => setState(() => step = 'hi'), onIn: widget.onIn);
    return _Screen(
      children: [
        Row(children: [
          if (step == 'hi')
            Press(
              onTap: () => setState(() => step = 'server'),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                decoration: BoxDecoration(color: Colors.white10, borderRadius: BorderRadius.circular(99)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  const Icon(Icons.dns_rounded, size: 16, color: Colors.white54),
                  const SizedBox(width: 6),
                  Text(Uri.parse(api.server).host, style: font(14, weight: FontWeight.w800, color: Colors.white54)),
                  const SizedBox(width: 6),
                  const Icon(Icons.edit_rounded, size: 14, color: Colors.white38),
                ]),
              ),
            ),
          const Spacer(),
          const TermsLink(),
        ]),
        SizedBox(height: MediaQuery.sizeOf(context).height * .08),
        const Logo(),
        const SizedBox(height: 32),
        if (step == 'server') ...[
          Text("where's your\nKiks?", style: font(52, weight: FontWeight.w900, height: .95)),
          const SizedBox(height: 12),
          Text('Use the public one, or type the address of a server you or your friends host.',
              style: font(17, weight: FontWeight.w700, color: Colors.white54)),
          const SizedBox(height: 16),
          if (api.server != Store.defaultServer)
            Align(
              alignment: Alignment.centerLeft,
              child: Pill(
                label: 'use ${Uri.parse(Store.defaultServer).host}',
                onTap: busy
                    ? null
                    : () {
                        serverField.text = Store.defaultServer.replaceFirst('https://', '');
                        setServer();
                      },
              ),
            ),
          const Spacer(),
          if (error.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(error, style: font(16, color: danger))),
          Row(children: [
            Expanded(
              child: Field(
                controller: serverField,
                hint: 'kiks.example.com',
                size: 22,
                keyboard: TextInputType.url,
                action: TextInputAction.go,
                onSubmit: (_) => setServer(),
              ),
            ),
            const SizedBox(width: 12),
            _Go(onTap: busy ? null : setServer),
          ]),
        ] else ...[
          ValueListenableBuilder(
            valueListenable: accent,
            builder: (_, a, _) => Text.rich(
              TextSpan(children: [
                const TextSpan(text: 'snap it.\n'),
                TextSpan(text: 'send it.\n', style: TextStyle(color: a)),
                const TextSpan(text: 'gone.'),
              ]),
              style: font(64, weight: FontWeight.w900, height: .9, spacing: -1),
            ),
          ),
          const Spacer(),
          if (error.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 12), child: Center(child: Text(error, style: font(16, color: danger)))),
          BigButton(label: "I'm new", icon: Icons.auto_awesome_rounded, onTap: busy ? null : fresh),
          const SizedBox(height: 12),
          BigButton(label: "I've got an account", icon: Icons.arrow_forward_rounded, ghost: true, onTap: () => setState(() => step = 'back')),
        ],
      ],
    );
  }
}

class _Go extends StatelessWidget {
  const _Go({this.onTap});
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
        valueListenable: accent,
        builder: (_, a, _) => Press(
          onTap: onTap,
          scale: .9,
          child: Container(
            width: 72,
            height: 72,
            decoration: BoxDecoration(color: a, shape: BoxShape.circle),
            child: Icon(Icons.arrow_forward_rounded, size: 36, color: onColor(a)),
          ),
        ),
      );
}

/// Returning user on a new device: approve this device from your phone.
/// (Passkeys are left to the web app: they're bound to the server's domain.)
class _Back extends StatefulWidget {
  const _Back({required this.onBack, required this.onIn});
  final VoidCallback onBack;
  final void Function(User) onIn;
  @override
  State<_Back> createState() => _BackState();
}

class _BackState extends State<_Back> {
  String? code, check, qr;
  bool alive = true;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    begin();
  }

  @override
  void dispose() {
    alive = false;
    timer?.cancel();
    super.dispose();
  }

  // Ask for a link code, show it as QR, poll until another device approves it.
  Future<void> begin() async {
    try {
      // the other device seals this account's identity key to this one-time key (docs/e2e.md)
      final key = await e2e.newLinkKey();
      final l = await api.linkStart(key.pub);
      if (!alive) return;
      setState(() {
        code = l.code;
        check = key.check;
        qr = 'kiks-link:${l.code}#${key.pub}';
      });
      Future<void> poll() async {
        if (!alive) return;
        try {
          final r = await api.linkPoll(l.code, l.secret);
          if (r.approved && r.user != null) {
            buzz(12);
            if (r.user!.username != null) await e2e.adopt(r.user!.username!, key, r.keyBlob);
            widget.onIn(r.user!);
            return;
          }
          timer = Timer(const Duration(seconds: 2), poll);
        } catch (_) {
          if (alive) begin(); // expired, get a fresh code
        }
      }

      poll();
    } catch (_) {
      if (alive) timer = Timer(const Duration(seconds: 3), begin);
    }
  }

  @override
  Widget build(BuildContext context) => _Screen(children: [
        Align(
          alignment: Alignment.centerLeft,
          child: RoundButton(icon: Icons.chevron_left_rounded, onTap: widget.onBack, tint: Colors.white10),
        ),
        const SizedBox(height: 16),
        Text('welcome back', style: font(48, weight: FontWeight.w900, height: .95)),
        const SizedBox(height: 28),
        ValueListenableBuilder(
          valueListenable: accent,
          builder: (_, a, _) => Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(color: a, borderRadius: BorderRadius.circular(32)),
            child: Row(children: [
              SizedBox(
                width: 132,
                height: 132,
                child: qr == null ? const Center(child: CircularProgressIndicator(color: Colors.black)) : QrImageView(data: qr!, padding: EdgeInsets.zero, eyeStyle: const QrEyeStyle(color: Colors.black, eyeShape: QrEyeShape.square), dataModuleStyle: const QrDataModuleStyle(color: Colors.black, dataModuleShape: QrDataModuleShape.square)),
              ),
              const SizedBox(width: 20),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    const Icon(Icons.smartphone_rounded, size: 16, color: Colors.black54),
                    const SizedBox(width: 4),
                    Text('on your phone', style: font(14, weight: FontWeight.w900, color: Colors.black54)),
                  ]),
                  const SizedBox(height: 4),
                  Text('open Kiks, tap your face, add a device, scan this', style: font(18, weight: FontWeight.w900, color: Colors.black, height: 1.1)),
                  const SizedBox(height: 8),
                  Text(code ?? '······', style: const TextStyle(fontFamily: 'monospace', fontSize: 24, fontWeight: FontWeight.w900, letterSpacing: 4, color: Colors.black)),
                  if (check != null) Text('check $check', style: font(14, weight: FontWeight.w800, color: Colors.black54)),
                ]),
              ),
            ]),
          ),
        ),
        const Spacer(),
        Text('Your other device sends this one your keys when it scans the code, so your snaps stay end-to-end encrypted.',
            style: font(15, weight: FontWeight.w600, color: Colors.white38)),
      ]);
}

/// Right after "I'm new": the only thing we ask for.
class PickName extends StatefulWidget {
  const PickName({super.key, required this.onDone});
  final void Function(User) onDone;
  @override
  State<PickName> createState() => _PickNameState();
}

class _PickNameState extends State<PickName> {
  final name = TextEditingController();
  String state = 'idle';
  Timer? debounce;

  void changed(String n) {
    debounce?.cancel();
    if (n.length < 3) return setState(() => state = 'idle');
    debounce = Timer(const Duration(milliseconds: 250), () async {
      try {
        final r = await api.nameFree(n);
        if (mounted && name.text == n) setState(() => state = !r.valid ? 'invalid' : r.free ? 'free' : 'taken');
      } catch (_) {}
    });
  }

  Future<void> go() async {
    if (state != 'free') return;
    try {
      buzz(12);
      widget.onDone(await api.pickName(name.text));
    } catch (_) {
      setState(() => state = 'taken');
    }
  }

  @override
  Widget build(BuildContext context) {
    const hints = {'idle': 'letters, numbers, _ and .', 'free': "that's yours 🙌", 'taken': 'taken, try another', 'invalid': '3-20 letters, numbers, _ or .'};
    return _Screen(children: [
      SizedBox(height: MediaQuery.sizeOf(context).height * .06),
      const Logo(),
      const SizedBox(height: 32),
      Text('what do friends\ncall you?', style: font(46, weight: FontWeight.w900, height: .95)),
      const SizedBox(height: 12),
      ValueListenableBuilder(
        valueListenable: accent,
        builder: (_, a, _) => Text(hints[state]!, style: font(18, color: state == 'free' ? a : state == 'idle' ? Colors.white38 : danger)),
      ),
      const Spacer(),
      Row(children: [
        Expanded(
          child: Field(
            controller: name,
            prefix: '@',
            hint: 'yourname',
            size: 28,
            autofocus: true,
            formatters: [nameFormatter],
            onChanged: changed,
            onSubmit: (_) => go(),
            action: TextInputAction.done,
          ),
        ),
        const SizedBox(width: 12),
        _Go(onTap: state == 'free' ? go : null),
      ]),
    ]);
  }
}

class _Screen extends StatelessWidget {
  const _Screen({required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
          ),
        ),
      );
}
