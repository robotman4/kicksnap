import 'package:flutter/material.dart';

import '../ui.dart';

/// The small (i) that opens the boring page.
class TermsLink extends StatelessWidget {
  const TermsLink({super.key});
  @override
  Widget build(BuildContext context) => Press(
        onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const Terms(), fullscreenDialog: true)),
        child: const Padding(padding: EdgeInsets.all(8), child: Icon(Icons.info_outline_rounded, size: 24, color: Colors.white38)),
      );
}

// Same text as frontend/src/components/Terms.tsx; keep them in step.
const _sections = <(String, List<String>)>[
  ('The short version', [
    'Kiks is a small app run by whoever runs this server. You use it as it is, at your own risk.',
    'You are responsible for what you send. We are not responsible for what anyone sends, or for what the people you send to do with it.',
  ]),
  ("Once you send it, it's out of your hands", [
    "Snaps disappear in the app, but the person you send to can still screenshot, screen record or film their screen with another phone. We can't stop that and we can't get it back for you.",
    "Only send things you're OK with the other person keeping.",
  ]),
  ('End-to-end encrypted', [
    "Snaps and chats are end-to-end encrypted. They're locked on your phone and only unlocked on the phones of the people you send them to. The server only ever holds the locked version and can't see what's in them.",
    'Each of your devices has its own key, and your devices only get your account\'s key from another of your devices (when you scan the code to add one). Friends see "key changed" if your key ever changes, and scanning each other\'s code in person verifies you.',
    "The server still knows who you send to, when, and whether it's a photo, a video or a chat.",
    'If you report someone, your app sends the snap or texts you picked to the people who run this server, unlocked, so they can look at it. Nothing else is ever unlocked for them.',
  ]),
  ('What the server keeps', [
    'Snaps are stored only until every recipient has opened them, then the file is deleted. Snaps nobody opens are deleted after 24 hours.',
    'Chat messages are deleted after 24 hours.',
    "We don't keep copies after that.",
    "To make the app work, the server keeps: your username and colour, who your friends are, your groups, who you've blocked, your signed-in devices (name and when last active), the public half of your passkeys and of your encryption keys. Like any web server it can also log IP addresses.",
    "Notifications go through Apple's or Google's push service and only say who sent something, never what.",
    'No ads, no tracking, nothing sold.',
  ]),
  ('Deleting', [
    'Profile → delete my account removes your account and everything above from the server, and frees your username for someone else.',
  ]),
  ('Be decent', [
    "Don't send illegal stuff, don't harass people, don't send things to people who don't want them. Block anyone who bothers you.",
    'The server owner can remove accounts that break this.',
  ]),
  ('No promises', [
    'The app comes with no guarantee. It can go down, lose messages or change at any time.',
    "Using it means you're fine with all of the above.",
  ]),
];

class Terms extends StatelessWidget {
  const Terms({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: Column(children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 8, 16, 8),
              child: Row(children: [
                Expanded(child: Text('the boring stuff', style: font(30, weight: FontWeight.w900))),
                RoundButton(icon: Icons.close_rounded, size: 48, tint: Colors.white10, onTap: () => Navigator.pop(context)),
              ]),
            ),
            Expanded(
              child: ValueListenableBuilder(
                valueListenable: accent,
                builder: (_, a, _) => ListView(padding: const EdgeInsets.fromLTRB(24, 0, 24, 32), children: [
                  for (final (title, lines) in _sections) ...[
                    const SizedBox(height: 24),
                    Text(title, style: font(18, weight: FontWeight.w900, color: a)),
                    for (final l in lines)
                      Padding(padding: const EdgeInsets.only(top: 8), child: SelectableText(l, style: font(16, weight: FontWeight.w600, color: Colors.white70, height: 1.5))),
                  ],
                ]),
              ),
            ),
          ]),
        ),
      );
}
