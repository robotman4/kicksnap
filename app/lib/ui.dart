/// Look and feel shared by every screen: black, one loud accent colour, big rounded bold type,
/// big buttons, a buzz on every tap. Mirrors the PWA (frontend/src/lib/feel.ts, tailwind config).
library;

import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// The user's colour; the whole app follows it.
final accent = ValueNotifier<Color>(const Color(0xFFC6FF3D));

const chatBlue = Color(0xFF3DC9FF);
const danger = Color(0xFFFF5C8A);
const red = Color(0xFFFF3D5A);

const accents = ['#C6FF3D', '#FFE14D', '#FF5C8A', '#FF8A3D', '#7C5CFF', '#3DD9FF', '#3DFFA8', '#FFFFFF'];

Color hex(String h) {
  final s = h.replaceFirst('#', '');
  return Color(int.parse(s.length == 6 ? 'FF$s' : s, radix: 16));
}

/// Text colour that reads on top of a given background.
Color onColor(Color c) => (0.299 * c.r * 255 + 0.587 * c.g * 255 + 0.114 * c.b * 255) > 150 ? Colors.black : Colors.white;

/// Nunito is a variable font; weight goes through the wght axis.
TextStyle font(double size, {FontWeight weight = FontWeight.w800, Color? color, double? height, double? spacing}) => TextStyle(
      fontFamily: 'Nunito',
      fontSize: size,
      fontWeight: weight,
      fontVariations: [FontVariation('wght', weight.value.toDouble())],
      color: color,
      height: height,
      letterSpacing: spacing,
    );

void buzz([int ms = 8]) {
  if (ms >= 12) {
    HapticFeedback.mediumImpact();
  } else {
    HapticFeedback.lightImpact();
  }
}

String ago(int ts) {
  if (ts == 0) return '';
  final s = DateTime.now().millisecondsSinceEpoch / 1000 - ts;
  if (s < 60) return 'now';
  if (s < 3600) return '${s ~/ 60}m';
  if (s < 86400) return '${s ~/ 3600}h';
  return '${s ~/ 86400}d';
}

const timers = [3, 5, 10, 0];
String timerLabel(int s) => s == 0 ? '∞' : '${s}s';

ThemeData theme(Color a) => ThemeData(
      brightness: Brightness.dark,
      scaffoldBackgroundColor: Colors.black,
      canvasColor: Colors.black,
      fontFamily: 'Nunito',
      colorScheme: ColorScheme.dark(primary: a, secondary: a, surface: const Color(0xFF141414)),
      textSelectionTheme: TextSelectionThemeData(cursorColor: a, selectionHandleColor: a, selectionColor: a.withValues(alpha: .35)),
      splashFactory: NoSplash.splashFactory,
      highlightColor: Colors.transparent,
      useMaterial3: true,
    );

/// Shrinks a bit while pressed, like `active:scale-95`.
class Press extends StatefulWidget {
  const Press({super.key, required this.child, this.onTap, this.scale = .94, this.haptic = 8});
  final Widget child;
  final VoidCallback? onTap;
  final double scale;
  final int haptic;
  @override
  State<Press> createState() => _PressState();
}

class _PressState extends State<Press> {
  bool down = false;
  @override
  Widget build(BuildContext context) => GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: widget.onTap == null ? null : (_) => setState(() => down = true),
        onTapCancel: () => setState(() => down = false),
        onTapUp: (_) => setState(() => down = false),
        onTap: widget.onTap == null
            ? null
            : () {
                if (widget.haptic > 0) buzz(widget.haptic);
                widget.onTap!();
              },
        child: AnimatedScale(
          scale: down ? widget.scale : 1,
          duration: const Duration(milliseconds: 150),
          curve: Curves.easeOutBack,
          child: Opacity(opacity: widget.onTap == null ? .35 : 1, child: widget.child),
        ),
      );
}

/// The giant pill buttons of the welcome screens.
class BigButton extends StatelessWidget {
  const BigButton({super.key, required this.label, this.icon, this.onTap, this.ghost = false});
  final String label;
  final IconData? icon;
  final VoidCallback? onTap;
  final bool ghost;
  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
        valueListenable: accent,
        builder: (_, a, _) => Press(
          onTap: onTap,
          scale: .96,
          haptic: 10,
          child: Container(
            padding: const EdgeInsets.fromLTRB(32, 22, 24, 22),
            decoration: BoxDecoration(
              color: ghost ? Colors.white.withValues(alpha: .1) : a,
              borderRadius: BorderRadius.circular(99),
              boxShadow: ghost ? null : [BoxShadow(color: Colors.white.withValues(alpha: .18), offset: const Offset(0, 6))],
            ),
            child: Row(children: [
              Expanded(child: Text(label, style: font(24, weight: FontWeight.w900, color: ghost ? Colors.white : onColor(a)))),
              if (icon != null) Icon(icon, size: 30, color: ghost ? Colors.white : onColor(a)),
            ]),
          ),
        ),
      );
}

/// Pill button for sheets and settings.
class Pill extends StatelessWidget {
  const Pill({super.key, required this.label, this.icon, this.onTap, this.color, this.textColor, this.size = 18, this.pad = 18});
  final String label;
  final IconData? icon;
  final VoidCallback? onTap;
  final Color? color, textColor;
  final double size, pad;
  @override
  Widget build(BuildContext context) => Press(
        onTap: onTap,
        scale: .97,
        child: Container(
          padding: EdgeInsets.symmetric(vertical: pad, horizontal: 20),
          decoration: BoxDecoration(color: color ?? Colors.white.withValues(alpha: .1), borderRadius: BorderRadius.circular(99)),
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            if (icon != null) ...[Icon(icon, size: size + 4, color: textColor ?? Colors.white), const SizedBox(width: 8)],
            Flexible(child: Text(label, textAlign: TextAlign.center, style: font(size, weight: FontWeight.w800, color: textColor ?? Colors.white))),
          ]),
        ),
      );
}

/// Round translucent icon button over the camera / a snap.
class RoundButton extends StatelessWidget {
  const RoundButton({super.key, required this.icon, this.onTap, this.size = 56, this.on = false, this.tint, this.child});
  final IconData icon;
  final VoidCallback? onTap;
  final double size;
  final bool on;
  final Color? tint;
  final Widget? child;
  @override
  Widget build(BuildContext context) {
    final bg = tint ?? (on ? Colors.white : Colors.black.withValues(alpha: .35));
    final fg = tint != null ? onColor(tint!) : (on ? Colors.black : Colors.white);
    return Press(
      onTap: onTap,
      scale: .9,
      child: ClipOval(
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 12, sigmaY: 12),
          child: Container(width: size, height: size, color: bg, alignment: Alignment.center, child: child ?? Icon(icon, size: size * .48, color: fg)),
        ),
      ),
    );
  }
}

class Avatar extends StatelessWidget {
  const Avatar({super.key, required this.name, required this.color, this.size = 48, this.ring = false, this.group = false});
  final String name;
  final String color;
  final double size;
  final bool ring, group;
  @override
  Widget build(BuildContext context) {
    final c = hex(color);
    final circle = Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: c, shape: BoxShape.circle),
      child: group
          ? Icon(Icons.group_rounded, size: size * .52, color: onColor(c))
          : Text(name.isEmpty ? '?' : name.substring(0, 1).toUpperCase(), style: font(size * .42, weight: FontWeight.w900, color: onColor(c), height: 1)),
    );
    if (!ring) return circle;
    return ValueListenableBuilder(
      valueListenable: accent,
      builder: (_, a, _) => Container(
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: a, width: 4)),
        child: circle,
      ),
    );
  }
}

/// Section label: small, uppercase, dim.
class Label extends StatelessWidget {
  const Label(this.text, {super.key, this.top = 28});
  final String text;
  final double top;
  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.only(top: top, bottom: 10),
        child: Text(text.toUpperCase(), style: font(13, weight: FontWeight.w900, color: Colors.white38, spacing: 1.2)),
      );
}

/// Bottom sheet like the PWA's Sheet: dark, rounded, drag to dismiss.
Future<T?> sheet<T>(BuildContext context, WidgetBuilder builder, {bool full = false}) => showModalBottomSheet<T>(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFF141414),
      barrierColor: Colors.black54,
      showDragHandle: true,
      useSafeArea: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(32))),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * (full ? .92 : .85)),
          child: builder(ctx),
        ),
      ),
    );

/// Short message at the top of the screen.
void toast(BuildContext context, String text) {
  final m = ScaffoldMessenger.maybeOf(context);
  if (m == null) return;
  m.hideCurrentSnackBar();
  m.showSnackBar(SnackBar(
    content: Text(text, textAlign: TextAlign.center, style: font(16, weight: FontWeight.w800, color: Colors.black)),
    backgroundColor: Colors.white,
    behavior: SnackBarBehavior.floating,
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(99)),
    margin: const EdgeInsets.fromLTRB(20, 0, 20, 24),
    duration: const Duration(milliseconds: 2600),
  ));
}

/// Rounded text field on a translucent pill.
class Field extends StatelessWidget {
  const Field({super.key, required this.controller, this.hint, this.prefix, this.onSubmit, this.size = 18, this.autofocus = false, this.maxLines = 1, this.onChanged, this.formatters, this.keyboard, this.action, this.focusNode});
  final TextEditingController controller;
  final String? hint, prefix;
  final ValueChanged<String>? onSubmit, onChanged;
  final double size;
  final bool autofocus;
  final int maxLines;
  final List<TextInputFormatter>? formatters;
  final TextInputType? keyboard;
  final TextInputAction? action;
  final FocusNode? focusNode;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 4),
        decoration: BoxDecoration(color: Colors.white.withValues(alpha: .1), borderRadius: BorderRadius.circular(maxLines > 1 ? 28 : 99)),
        child: Row(children: [
          if (prefix != null) Text(prefix!, style: font(size, color: Colors.white38)),
          Expanded(
            child: TextField(
              controller: controller,
              focusNode: focusNode,
              autofocus: autofocus,
              maxLines: maxLines,
              minLines: 1,
              onChanged: onChanged,
              onSubmitted: onSubmit,
              inputFormatters: formatters,
              keyboardType: keyboard,
              textInputAction: action,
              autocorrect: false,
              enableSuggestions: false,
              style: font(size, weight: FontWeight.w800, color: Colors.white),
              decoration: InputDecoration(
                hintText: hint,
                hintStyle: font(size, weight: FontWeight.w700, color: Colors.white30),
                border: InputBorder.none,
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 14),
              ),
            ),
          ),
        ]),
      );
}

/// Lower-case, a-z0-9_. only: usernames.
final nameFormatter = TextInputFormatter.withFunction((o, n) {
  final t = n.text.toLowerCase().replaceAll(RegExp(r'[^a-z0-9_.]'), '');
  return TextEditingValue(text: t, selection: TextSelection.collapsed(offset: t.length));
});

class Spinner extends StatelessWidget {
  const Spinner({super.key, this.size = 40});
  final double size;
  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
        valueListenable: accent,
        builder: (_, a, _) => SizedBox(width: size, height: size, child: CircularProgressIndicator(strokeWidth: 4, color: a, backgroundColor: Colors.white12)),
      );
}

/// The logo: a tilted accent square with a camera eye.
class Logo extends StatelessWidget {
  const Logo({super.key, this.size = 80});
  final double size;
  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
        valueListenable: accent,
        builder: (_, a, _) => Transform.rotate(
          angle: -0.14,
          child: Container(
            width: size,
            height: size,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: a,
              borderRadius: BorderRadius.circular(size * .32),
              boxShadow: [BoxShadow(color: Colors.white.withValues(alpha: .15), offset: const Offset(0, 8))],
            ),
            child: Container(
              width: size * .55,
              height: size * .55,
              alignment: Alignment.center,
              decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Colors.black, width: size * .075)),
              child: Container(width: size * .17, height: size * .17, decoration: const BoxDecoration(color: Colors.black, shape: BoxShape.circle)),
            ),
          ),
        ),
      );
}
