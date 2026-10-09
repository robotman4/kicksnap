import { Check, Crown, LogOut, Trash2, UserPlus, X } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Sheet } from "../components/Sheet";
import { api, Friend, Group, InviteMode } from "../lib/api";
import { buzz } from "../lib/feel";

const MODES: { mode: InviteMode; label: string }[] = [
  { mode: "open", label: "anyone can join" },
  { mode: "members", label: "anyone can invite" },
  { mode: "admin", label: "only admin invites" },
];

/** Grid of friends to tick. */
function Picker({ friends, picked, onToggle }: { friends: Friend[]; picked: string[]; onToggle: (n: string) => void }) {
  if (!friends.length) return <p className="px-2 py-6 text-center text-white/50">No friends left to add.</p>;
  return (
    <div className="grid grid-cols-4 gap-y-5 py-2">
      {friends.map((f) => {
        const on = picked.includes(f.username);
        return (
          <button key={f.username} onClick={() => (buzz(5), onToggle(f.username))} className="flex flex-col items-center gap-1.5 transition ease-spring active:scale-90">
            <div className="relative">
              <Avatar name={f.username} color={f.color} size={60} ring={on} />
              {on && (
                <span className="absolute -bottom-1 -right-1 grid h-7 w-7 place-items-center rounded-full bg-accent text-black">
                  <Check size={18} strokeWidth={4} />
                </span>
              )}
            </div>
            <span className={`max-w-full truncate text-xs font-bold ${on ? "text-white" : "text-white/60"}`}>{f.username}</span>
          </button>
        );
      })}
    </div>
  );
}

const toggleIn = (list: string[], n: string) => (list.includes(n) ? list.filter((x) => x !== n) : [...list, n]);

export function NewGroup({ open, friends, onClose, onMade, toast }: { open: boolean; friends: Friend[]; onClose: () => void; onMade: (g: Group) => void; toast: (t: string) => void }) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    if (open) {
      setName("");
      setPicked([]);
    }
  }, [open]);

  const make = async () => {
    try {
      const g = await api.newGroup(name, picked);
      buzz([8, 40, 16]);
      onMade(g);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <Sheet open={open} onClose={onClose}>
      <div className="max-h-[75vh] overflow-y-auto px-6 pb-[max(env(safe-area-inset-bottom),24px)]">
        <h2 className="text-3xl font-black">new group</h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 30))}
          placeholder="name it"
          className="mt-4 w-full rounded-full bg-white/10 px-5 py-4 text-xl font-bold outline-none placeholder:text-white/30 focus:bg-white/15"
        />
        <p className="mb-1 mt-6 text-sm font-black uppercase tracking-wider text-white/40">who's in</p>
        <Picker friends={friends} picked={picked} onToggle={(n) => setPicked((p) => toggleIn(p, n))} />
        <button
          onClick={make}
          disabled={!name.trim()}
          className="mt-6 w-full rounded-full bg-accent py-5 text-2xl font-black text-black transition active:scale-95 disabled:opacity-30"
        >
          make it
        </button>
      </div>
    </Sheet>
  );
}

export function GroupInfo({
  id,
  me,
  friends,
  tick,
  onClose,
  onGone,
  toast,
}: {
  id: number | null;
  me: string;
  friends: Friend[];
  tick: number;
  onClose: () => void;
  onGone: () => void;
  toast: (t: string) => void;
}) {
  const [g, setG] = useState<Group | null>(null);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [qr, setQr] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    if (id === null) return;
    api.group(id).then(setG, () => onGone());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, tick]);
  useEffect(() => {
    setAdding(false);
    setPicked([]);
    setConfirmClose(false);
  }, [id]);
  useEffect(() => {
    if (g?.code) QRCode.toDataURL(`kicksnap-group:${g.code}`, { margin: 1, width: 480, color: { dark: "#000000", light: "#00000000" } }).then(setQr);
  }, [g?.code]);

  const run = async (p: Promise<unknown>, after?: () => void) => {
    try {
      const r = await p;
      buzz(8);
      if (r && typeof r === "object" && "members" in r) setG(r as Group);
      after?.();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const open = id !== null;
  const notIn = g ? friends.filter((f) => !g.members.some((m) => m.username === f.username)) : [];

  return (
    <Sheet open={open} onClose={onClose}>
      {g && (
        <div className="max-h-[78vh] overflow-y-auto px-6 pb-[max(env(safe-area-inset-bottom),24px)]">
          <div className="flex items-center gap-4">
            <Avatar name={g.name} color={g.color} size={64} group />
            <div className="min-w-0">
              <h2 className="truncate text-3xl font-black">{g.name}</h2>
              <p className="text-white/50">{g.members.length} people</p>
            </div>
          </div>

          {g.admin && (
            <>
              <p className="mb-3 mt-7 text-sm font-black uppercase tracking-wider text-white/40">who can add people</p>
              <div className="flex flex-col gap-2">
                {MODES.map(({ mode, label }) => (
                  <button
                    key={mode}
                    onClick={() => run(api.updateGroup(g.id, { invite_mode: mode }))}
                    className={`rounded-full py-3.5 text-lg font-bold transition active:scale-[.98] ${g.invite_mode === mode ? "bg-accent text-black" : "bg-white/10"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}

          {g.code && (
            <div className="mt-6 flex items-center gap-5 rounded-[2rem] bg-accent p-5 text-black">
              <div className="h-24 w-24 shrink-0">{qr && <img src={qr} alt="group code" draggable={false} className="h-full w-full" />}</div>
              <p className="font-bold">Anyone who scans this in friends can join.</p>
            </div>
          )}

          <div className="mb-2 mt-7 flex items-center justify-between">
            <p className="text-sm font-black uppercase tracking-wider text-white/40">people</p>
            {g.can_invite && !adding && (
              <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 rounded-full bg-white/10 px-4 py-2 font-bold active:scale-95">
                <UserPlus size={18} /> add
              </button>
            )}
          </div>

          {adding && (
            <div className="mb-4 rounded-3xl bg-white/5 p-3">
              <Picker friends={notIn} picked={picked} onToggle={(n) => setPicked((p) => toggleIn(p, n))} />
              <div className="mt-2 flex gap-2">
                <button onClick={() => setAdding(false)} className="flex-1 rounded-full bg-white/10 py-3 font-bold">
                  cancel
                </button>
                <button
                  disabled={!picked.length}
                  onClick={() => run(api.invite(g.id, picked), () => (setAdding(false), setPicked([])))}
                  className="flex-1 rounded-full bg-accent py-3 font-black text-black disabled:opacity-30"
                >
                  add {picked.length || ""}
                </button>
              </div>
            </div>
          )}

          {g.members.map((m) => (
            <div key={m.username} className="flex items-center gap-3 py-2">
              <Avatar name={m.username} color={m.color} size={44} />
              <p className="flex-1 truncate font-bold">
                {m.username} {m.username === me && <span className="text-white/40">· you</span>}
              </p>
              {m.admin && (
                <span className="flex items-center gap-1 rounded-full bg-accent/15 px-3 py-1 text-sm font-black text-accent">
                  <Crown size={14} /> admin
                </span>
              )}
              {g.admin && !m.admin && (
                <>
                  <button
                    onClick={() => run(api.updateGroup(g.id, { admin: m.username }))}
                    className="rounded-full bg-white/10 px-3 py-2 text-sm font-bold active:scale-95"
                  >
                    make admin
                  </button>
                  <button
                    onClick={() => run(api.removeMember(g.id, m.username), () => api.group(g.id).then(setG))}
                    aria-label={`remove ${m.username}`}
                    className="grid h-9 w-9 place-items-center rounded-full bg-white/5 text-white/60 active:scale-90"
                  >
                    <X size={18} />
                  </button>
                </>
              )}
            </div>
          ))}

          <button
            onClick={() => run(api.removeMember(g.id, me), onGone)}
            className="mt-8 flex w-full items-center justify-center gap-2 rounded-full bg-white/5 py-5 text-lg font-bold text-white/60 active:scale-[.98]"
          >
            <LogOut size={22} /> leave group
          </button>
          {g.admin && (
            <button
              onClick={() => (confirmClose ? run(api.closeGroup(g.id), onGone) : setConfirmClose(true))}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-red-500/15 py-5 text-lg font-bold text-red-400 active:scale-[.98]"
            >
              <Trash2 size={22} /> {confirmClose ? "tap again to close it for everyone" : "close group"}
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}
