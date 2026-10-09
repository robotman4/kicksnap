import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'e2e.dart' as e2e;
import 'models.dart';
import 'screens/home.dart';
import 'screens/onboard.dart';
import 'screens/suspended.dart';
import 'store.dart';
import 'ui.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Store.init();
  api.server = Store.server;
  api.token = await Store.token();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.light,
    systemNavigationBarColor: Colors.black,
  ));
  SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  runApp(const KiksApp());
}

class KiksApp extends StatelessWidget {
  const KiksApp({super.key});
  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
        valueListenable: accent,
        builder: (_, a, _) => MaterialApp(
          title: 'Kiks',
          debugShowCheckedModeBanner: false,
          theme: theme(a),
          home: const Root(),
        ),
      );
}

/// Picks the screen: welcome, pick a name, suspended, or the app.
class Root extends StatefulWidget {
  const Root({super.key});
  @override
  State<Root> createState() => _RootState();
}

class _RootState extends State<Root> {
  User? me;
  bool booting = true;
  String? offline;

  @override
  void initState() {
    super.initState();
    boot();
  }

  Future<void> boot() async {
    setState(() {
      booting = true;
      offline = null;
    });
    if (api.server.isEmpty || api.token == null) {
      setState(() => booting = false);
      return;
    }
    try {
      signedIn(await api.me());
    } on ApiError catch (e) {
      if (e.status == 401) {
        // the server forgot this device (signed out elsewhere, or removed)
        await Store.setToken(null);
        api.token = null;
        await e2e.forget();
      } else {
        offline = e.message;
      }
    }
    if (mounted) setState(() => booting = false);
  }

  void signedIn(User? u) {
    setState(() => me = u);
    if (u != null) accent.value = hex(u.color);
  }

  Future<void> signOut({bool deleted = false}) async {
    if (!deleted) {
      await e2e.leave();
      try {
        await api.logout();
      } catch (_) {}
    } else {
      await e2e.forget();
    }
    await Store.setToken(null);
    api.token = null;
    if (mounted) setState(() => me = null);
  }

  @override
  Widget build(BuildContext context) {
    if (booting) return const Scaffold(body: Center(child: Spinner()));
    if (offline != null && me == null) {
      return Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Spacer(),
              const Text('📡', style: TextStyle(fontSize: 56)),
              const SizedBox(height: 12),
              Text("can't reach your server", style: font(34, weight: FontWeight.w900, height: 1)),
              const SizedBox(height: 10),
              Text('${api.server}\n$offline', style: font(16, weight: FontWeight.w600, color: Colors.white54)),
              const Spacer(),
              BigButton(label: 'try again', icon: Icons.refresh_rounded, onTap: boot),
            ]),
          ),
        ),
      );
    }
    final u = me;
    if (u == null) return Welcome(onIn: signedIn);
    if (u.username == null) return PickName(onDone: signedIn);
    if (u.suspendedUntil != null) {
      return Suspended(me: u, onOut: () => signOut(), onBack: () => api.me().then(signedIn, onError: (_) {}));
    }
    return Home(
      me: u,
      onMe: signedIn,
      onSignOut: () => signOut(),
      onDeleted: () => signOut(deleted: true),
    );
  }
}
