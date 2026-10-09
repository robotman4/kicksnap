import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../ui.dart';

/// Full-screen QR scanner. Returns the first code it reads.
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

  @override
  void dispose() {
    ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(fit: StackFit.expand, children: [
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
              child: Text("can't use the camera: allow it for Kiks in your phone settings", textAlign: TextAlign.center, style: font(18, color: Colors.white70)),
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
          bottom: pad.bottom + 48,
          child: Text(widget.hint, textAlign: TextAlign.center, style: font(22, weight: FontWeight.w900, color: Colors.white, height: 1.1)),
        ),
        Positioned(left: 16, top: pad.top + 14, child: RoundButton(icon: Icons.close_rounded, onTap: () => Navigator.pop(context))),
      ]),
    );
  }
}
