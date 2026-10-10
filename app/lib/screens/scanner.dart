import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../ui.dart';

/// Full-screen QR scanner with a "type it instead" fallback, like the PWA's. Returns the first
/// code it reads, or what was typed.
Future<String?> scan(BuildContext context, String hint) =>
    Navigator.of(context).push<String>(MaterialPageRoute(fullscreenDialog: true, builder: (_) => _Scanner(hint: hint)));

class _Scanner extends StatefulWidget {
  const _Scanner({required this.hint});
  final String hint;
  @override
  State<_Scanner> createState() => _ScannerState();
}

class _ScannerState extends State<_Scanner> {
  final ctrl = MobileScannerController(formats: const [BarcodeFormat.qrCode], detectionSpeed: DetectionSpeed.noDuplicates);
  bool done = false;
  bool typing = false;
  final typed = TextEditingController();

  @override
  void dispose() {
    ctrl.dispose();
    typed.dispose();
    super.dispose();
  }

  void submit() {
    final v = typed.text.trim();
    if (v.isEmpty || done) return;
    done = true;
    Navigator.pop(context, v);
  }

  Widget _typeIt(EdgeInsets pad) => Padding(
        padding: EdgeInsets.fromLTRB(32, pad.top + 80, 32, 32),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          Text('type the code', style: font(30, weight: FontWeight.w900)),
          const SizedBox(height: 24),
          TextField(
            controller: typed,
            autofocus: true,
            maxLength: 20,
            textAlign: TextAlign.center,
            textCapitalization: TextCapitalization.characters,
            autocorrect: false,
            enableSuggestions: false,
            onSubmitted: (_) => submit(),
            style: font(34, weight: FontWeight.w900, color: Colors.white).copyWith(fontFamily: 'monospace', letterSpacing: 8),
            cursorColor: Colors.white,
            decoration: InputDecoration(
              counterText: '',
              filled: true,
              fillColor: Colors.white.withValues(alpha: .1),
              contentPadding: const EdgeInsets.symmetric(vertical: 20),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: BorderSide.none),
            ),
          ),
          const SizedBox(height: 20),
          SizedBox(
            width: double.infinity,
            child: ValueListenableBuilder(
              valueListenable: accent,
              builder: (_, a, _) => Pill(label: 'go', color: a, textColor: onColor(a), size: 22, onTap: submit),
            ),
          ),
        ]),
      );

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    return Scaffold(
      backgroundColor: Colors.black,
      resizeToAvoidBottomInset: true,
      body: Stack(fit: StackFit.expand, children: [
        if (typing) _typeIt(pad),
        if (!typing) ...[
        MobileScanner(
          controller: ctrl,
          onDetect: (r) {
            final v = r.barcodes.map((b) => b.rawValue).whereType<String>().firstOrNull;
            if (v == null || done) return;
            done = true;
            buzz(12);
            Navigator.pop(context, v);
          },
          errorBuilder: (_, e) => Center(
            child: Padding(
              padding: const EdgeInsets.all(40),
              child: Text("can't use the camera: allow it for Kiks in your phone settings, or type the code instead", textAlign: TextAlign.center, style: font(18, color: Colors.white70)),
            ),
          ),
        ),
        Center(
          child: ValueListenableBuilder(
            valueListenable: accent,
            builder: (_, a, _) => Container(
              width: 260,
              height: 260,
              decoration: BoxDecoration(border: Border.all(color: a, width: 5), borderRadius: BorderRadius.circular(36)),
            ),
          ),
        ),
        Positioned(
          left: 24,
          right: 24,
          bottom: pad.bottom + 32,
          child: Column(children: [
            Text(widget.hint, textAlign: TextAlign.center, style: font(22, weight: FontWeight.w900, color: Colors.white, height: 1.1)),
            const SizedBox(height: 16),
            IntrinsicWidth(child: Pill(label: 'type it instead', size: 16, pad: 12, color: Colors.white.withValues(alpha: .15), onTap: () => setState(() => typing = true))),
          ]),
        ),
        ],
        Positioned(left: 16, top: pad.top + 14, child: RoundButton(icon: Icons.close_rounded, onTap: () => Navigator.pop(context))),
      ]),
    );
  }
}
