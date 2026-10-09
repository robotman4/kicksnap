import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../api.dart';
import '../models.dart';
import '../ui.dart';
import 'home.dart';

const _modes = [('open', 'anyone can join'), ('members', 'anyone can invite'), ('admin', 'only admin invites')];

/// Grid of friends to tick.
class _Picker extends StatelessWidget {
  const _Picker({required this.friends, required this.picked, required this.onToggle});
  final List<Friend> friends;
  final List<String> picked;
  final ValueChanged<String> onToggle;
  @override
  Widget build(BuildContext context) {
    if (friends.isEmpty) {
      return Padding(padding: const EdgeInsets.all(24), child: Text('No friends left to add.', textAlign: TextAlign.center, style: font(16, weight: FontWeight.w600, color: Colors.white54)));
    }
    return Wrap(runSpacing: 16, children: [
      for (final f in friends)
        SizedBox(
          width: (MediaQuery.sizeOf(context).width - 48) / 4,
          child: Press(
            haptic: 5,
            onTap: () => onToggle(f.username),
            child: Column(children: [
              Avatar(name: f.username, color: f.color, size: 60, ring: picked.contains(f.username)),
              const SizedBox(height: 6),
              Text(f.username, overflow: TextOverflow.ellipsis, style: font(12, weight: FontWeight.w800, color: picked.contains(f.username) ? Colors.white : Colors.white60)),
            ]),
          ),
        ),
    ]);
  }
}

/// Pops with the new group.
class NewGroup extends StatefulWidget {
  const NewGroup({super.key, required this.friends});
  final List<Friend> friends;
  @override
  State<NewGroup> createState() => _NewGroupState();
}

class _NewGroupState extends State<NewGroup> {
  final name = TextEditingController();
  final picked = <String>[];

  Future<void> make() async {
    try {
      final g = await api.newGroup(name.text.trim(), picked);
      buzz(12);
      if (mounted) Navigator.pop(context, g);
    } on ApiError catch (e) {
      if (mounted) toast(context, e.message);
    }
  }

  @override
  Widget build(BuildContext context) => ListView(shrinkWrap: true, padding: EdgeInsets.fromLTRB(24, 0, 24, MediaQuery.paddingOf(context).bottom + 24), children: [
        Text('new group', style: font(30, weight: FontWeight.w900)),
        const SizedBox(height: 14),
        Field(controller: name, hint: 'name it', size: 20, onChanged: (_) => setState(() {})),
        const Label("who's in", top: 22),
        _Picker(friends: widget.friends, picked: picked, onToggle: (n) => setState(() => picked.contains(n) ? picked.remove(n) : picked.add(n))),
        const SizedBox(height: 22),
        ValueListenableBuilder(
          valueListenable: accent,
          builder: (_, a, _) => Pill(label: 'make it', color: a, textColor: onColor(a), size: 22, onTap: name.text.trim().isEmpty ? null : make),
        ),
      ]);
}

class GroupInfo extends StatefulWidget {
  const GroupInfo({super.key, required this.id, required this.model});
  final int id;
  final HomeModel model;
  @override
  State<GroupInfo> createState() => _GroupInfoState();
}

class _GroupInfoState extends State<GroupInfo> {
  Group? g;
  bool adding = false, confirmClose = false;
  final picked = <String>[];
  late int tick = widget.model.tick;

  String get me => widget.model.username;

  @override
  void initState() {
    super.initState();
    load();
    widget.model.addListener(_onModel);
  }

  @override
  void dispose() {
    widget.model.removeListener(_onModel);
    super.dispose();
  }

  void _onModel() {
    if (widget.model.tick != tick) {
      tick = widget.model.tick;
      load();
    }
  }

  Future<void> load() async {
    try {
      final r = await api.group(widget.id);
      if (mounted) setState(() => g = r);
    } catch (_) {
      // closed, or we're not in it any more
      if (mounted) Navigator.pop(context, 'gone');
    }
  }

  Future<void> run(Future<Object?> Function() call, {VoidCallback? after}) async {
    try {
      final r = await call();
      buzz(8);
      if (r is Group && mounted) setState(() => g = r);
      after?.call();
    } on ApiError catch (e) {
      if (mounted) toast(context, e.message);
    }
  }

  void gone() {
    widget.model.refresh();
    Navigator.pop(context, 'gone');
  }

  @override
  Widget build(BuildContext context) {
    final g = this.g;
    if (g == null) return const SizedBox(height: 200, child: Center(child: Spinner()));
    final notIn = widget.model.lists.friends.where((f) => !g.members.any((m) => m.username == f.username)).toList();
    return ValueListenableBuilder(
      valueListenable: accent,
      builder: (_, a, _) => ListView(shrinkWrap: true, padding: EdgeInsets.fromLTRB(24, 0, 24, MediaQuery.paddingOf(context).bottom + 24), children: [
        Row(children: [
          Avatar(name: g.name, color: g.color, size: 64, group: true),
          const SizedBox(width: 16),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(g.name, overflow: TextOverflow.ellipsis, style: font(28, weight: FontWeight.w900)),
              Text('${g.members.length} people', style: font(16, weight: FontWeight.w600, color: Colors.white54)),
            ]),
          ),
        ]),
        if (g.admin) ...[
          const Label('who can add people'),
          for (final (mode, label) in _modes)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Pill(
                label: label,
                pad: 14,
                color: g.inviteMode == mode ? a : null,
                textColor: g.inviteMode == mode ? onColor(a) : null,
                onTap: () => run(() => api.updateGroup(g.id, {'invite_mode': mode})),
              ),
            ),
        ],
        if (g.code != null) ...[
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(color: a, borderRadius: BorderRadius.circular(32)),
            child: Row(children: [
              SizedBox(
                width: 96,
                height: 96,
                child: QrImageView(
                  data: 'kiks-group:${g.code}',
                  padding: EdgeInsets.zero,
                  eyeStyle: const QrEyeStyle(color: Colors.black, eyeShape: QrEyeShape.square),
                  dataModuleStyle: const QrDataModuleStyle(color: Colors.black, dataModuleShape: QrDataModuleShape.square),
                ),
              ),
              const SizedBox(width: 18),
              Expanded(child: Text('Anyone who scans this in friends can join.', style: font(16, weight: FontWeight.w800, color: Colors.black))),
            ]),
          ),
        ],
        Padding(
          padding: const EdgeInsets.only(top: 24, bottom: 8),
          child: Row(children: [
            Expanded(child: Text('PEOPLE', style: font(13, weight: FontWeight.w900, color: Colors.white38, spacing: 1.2))),
            if (g.canInvite && !adding) Pill(icon: Icons.person_add_rounded, label: 'add', size: 15, pad: 8, onTap: () => setState(() => adding = true)),
          ]),
        ),
        if (adding)
          Container(
            margin: const EdgeInsets.only(bottom: 12),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: Colors.white.withValues(alpha: .05), borderRadius: BorderRadius.circular(24)),
            child: Column(children: [
              _Picker(friends: notIn, picked: picked, onToggle: (n) => setState(() => picked.contains(n) ? picked.remove(n) : picked.add(n))),
              const SizedBox(height: 8),
              Row(children: [
                Expanded(child: Pill(label: 'cancel', pad: 12, size: 16, onTap: () => setState(() => adding = false))),
                const SizedBox(width: 8),
                Expanded(
                  child: Pill(
                    label: 'add ${picked.isEmpty ? '' : picked.length}',
                    pad: 12,
                    size: 16,
                    color: a,
                    textColor: onColor(a),
                    onTap: picked.isEmpty ? null : () => run(() => api.invite(g.id, picked), after: () => setState(() {
                          adding = false;
                          picked.clear();
                        })),
                  ),
                ),
              ]),
            ]),
          ),
        for (final m in g.members)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(children: [
              Avatar(name: m.username, color: m.color, size: 44),
              const SizedBox(width: 12),
              Expanded(
                child: Text.rich(
                  TextSpan(text: m.username, children: [if (m.username == me) TextSpan(text: ' · you', style: font(16, color: Colors.white38))]),
                  overflow: TextOverflow.ellipsis,
                  style: font(16, weight: FontWeight.w800),
                ),
              ),
              if (m.admin)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(color: a.withValues(alpha: .15), borderRadius: BorderRadius.circular(99)),
                  child: Row(children: [Icon(Icons.workspace_premium_rounded, size: 14, color: a), const SizedBox(width: 4), Text('admin', style: font(13, weight: FontWeight.w900, color: a))]),
                ),
              if (g.admin && !m.admin) ...[
                Pill(label: 'make admin', size: 13, pad: 8, onTap: () => run(() => api.updateGroup(g.id, {'admin': m.username}))),
                const SizedBox(width: 6),
                Press(
                  onTap: () => run(() => api.removeMember(g.id, m.username), after: load),
                  child: Container(width: 36, height: 36, decoration: const BoxDecoration(color: Colors.white10, shape: BoxShape.circle), child: const Icon(Icons.close_rounded, size: 18, color: Colors.white60)),
                ),
              ],
            ]),
          ),
        const SizedBox(height: 24),
        Pill(icon: Icons.logout_rounded, label: 'leave group', textColor: Colors.white60, onTap: g.admin ? null : () => run(() => api.removeMember(g.id, me), after: gone)),
        if (g.admin)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              g.members.length > 1 ? "You're the admin. Tap \"make admin\" on someone to hand it over, then you can leave." : "You're the only one here. Close the group instead.",
              textAlign: TextAlign.center,
              style: font(14, weight: FontWeight.w600, color: Colors.white38),
            ),
          ),
        if (g.admin) ...[
          const SizedBox(height: 12),
          Pill(
            icon: Icons.delete_rounded,
            label: confirmClose ? 'tap again to close it for everyone' : 'close group',
            color: Colors.red.withValues(alpha: .15),
            textColor: Colors.redAccent,
            onTap: () => confirmClose ? run(() => api.closeGroup(g.id), after: gone) : setState(() => confirmClose = true),
          ),
        ],
      ]),
    );
  }
}
