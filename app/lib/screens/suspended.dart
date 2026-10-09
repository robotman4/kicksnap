import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';
import '../ui.dart';

/// Suspended by an admin: why, one appeal per suspension, and their answer.
class Suspended extends StatefulWidget {
  const Suspended({super.key, required this.me, required this.onOut, required this.onBack});
  final User me;
  final VoidCallback onOut, onBack;
  @override
  State<Suspended> createState() => _SuspendedState();
}

class _SuspendedState extends State<Suspended> with WidgetsBindingObserver {
  Suspension? s;
  final text = TextEditingController();
  bool busy = false;
  String error = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // an admin may have answered while the app was in the background
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) load();
  }

  Future<void> load() async {
    try {
      final r = await api.suspension();
      if (!r.suspended) return widget.onBack();
      if (mounted) setState(() => s = r);
    } catch (_) {}
  }

  Future<void> send() async {
    setState(() {
      busy = true;
      error = '';
    });
    try {
      await api.appeal(text.text);
      await load();
    } on ApiError catch (e) {
      setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final until = s?.until ?? widget.me.suspendedUntil ?? 0;
    final d = DateTime.fromMillisecondsSinceEpoch(until * 1000);
    return Scaffold(
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.fromLTRB(32, 40, 32, 24), children: [
          const Text('⏸️', style: TextStyle(fontSize: 48)),
          const SizedBox(height: 12),
          Text('@${widget.me.username} is on a break', style: font(36, weight: FontWeight.w900, height: 1.05)),
          const SizedBox(height: 12),
          Text(
            "The people running this server suspended your account${until > 0 ? ' until ${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}' : ' until they lift it'}. You can't send or get snaps while it lasts.",
            style: font(17, weight: FontWeight.w600, color: Colors.white60),
          ),
          if (s != null && s!.reason.isNotEmpty) ...[
            const SizedBox(height: 16),
            _Box(children: [Text('reason', style: font(13, color: Colors.white38)), Text(s!.reason, style: font(16, weight: FontWeight.w600, color: Colors.white70))]),
          ],
          if (s != null && s!.appealBody == null) ...[
            const SizedBox(height: 20),
            Text("think it's a mistake?", style: font(18, weight: FontWeight.w900)),
            const SizedBox(height: 8),
            Field(controller: text, hint: 'tell them why they should lift it', maxLines: 4, onChanged: (_) => setState(() {})),
            const SizedBox(height: 6),
            Text('You get one appeal per suspension.', style: font(14, weight: FontWeight.w600, color: Colors.white38)),
            if (error.isNotEmpty) Text(error, style: font(14, color: Colors.redAccent)),
            const SizedBox(height: 12),
            ValueListenableBuilder(
              valueListenable: accent,
              builder: (_, a, _) => Pill(label: 'send appeal', color: a, textColor: onColor(a), onTap: text.text.trim().isEmpty || busy ? null : send),
            ),
          ],
          if (s?.appealBody != null && s?.appealOutcome == null) ...[
            const SizedBox(height: 20),
            _Box(children: [Text("Appeal sent. You'll see their answer here.", style: font(16, weight: FontWeight.w600, color: Colors.white70))]),
          ],
          if (s?.appealOutcome == 'rejected') ...[
            const SizedBox(height: 20),
            _Box(children: [
              Text('they kept the suspension', style: font(16, weight: FontWeight.w900)),
              if (s!.appealReply.isNotEmpty) Text('“${s!.appealReply}”', style: font(16, weight: FontWeight.w600, color: Colors.white70)),
            ]),
          ],
          const SizedBox(height: 28),
          Pill(label: 'sign out here', textColor: Colors.white60, onTap: widget.onOut),
        ]),
      ),
    );
  }
}

class _Box extends StatelessWidget {
  const _Box({required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
        decoration: BoxDecoration(color: Colors.white.withValues(alpha: .05), borderRadius: BorderRadius.circular(24)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
      );
}
