import { Plus, ScanLine } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { PullToRefresh } from "../components/PullToRefresh";
import { Scanner } from "../components/Scanner";
import { Avatar } from "../components/Avatar";
import { api, FriendLists, User } from "../lib/api";
import { buzz } from "../lib/feel";

export function Friends({
  me,
  lists,
  onChanged,
  onSnap,
  toast,
}: {
  me: User;
  lists: FriendLists;
  onChanged: () => Promise<unknown>;
  onSnap: (name: string) => void;
  toast: (t: string) => void;
}) {
  const [qr, setQr] = useState("");
  const [name, setName] = useState("");
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    QRCode.toDataURL(`kiks:${me.username}`, { margin: 1, width: 480, color: { dark: "#000000", light: "#00000000" } }).then(setQr);
  }, [me.username]);

  const add = async (raw: string) => {
    const n = raw.trim().toLowerCase().replace(/^(kiks|kicksnap):/, "").replace(/^@/, "");
    if (!n) return;
    try {
      const r = await api.addFriend(n);
      buzz(12);
      toast(r.status === "friends" ? `you and @${r.username} are friends` : `request sent to @${r.username}`);
      setName("");
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col bg-black text-white">
      <header className="px-5 pb-3 pt-[max(env(safe-area-inset-top),18px)]">
        <h1 className="text-4xl font-black tracking-tight">friends</h1>
      </header>

      <PullToRefresh onRefresh={onChanged} className="flex-1 px-5 pb-24">
        {/* your code */}
        <div className="flex items-center gap-5 rounded-[2rem] bg-accent p-5 text-black">
          <div className="h-28 w-28 shrink-0 rounded-2xl bg-accent">{qr && <img src={qr} alt="your code" draggable={false} className="pointer-events-none h-full w-full" />}</div>
          <div className="min-w-0">
            <p className="text-sm font-bold opacity-60">your code</p>
            <p className="truncate text-2xl font-black">@{me.username}</p>
            <p className="mt-1 text-sm font-semibold opacity-60">friends scan this to add you</p>
          </div>
        </div>

        {/* add by name or scan */}
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add(name);
          }}
        >
          <label className="flex flex-1 items-center rounded-full bg-white/10 px-5 py-3.5 text-lg font-semibold focus-within:bg-white/15">
            <span className="text-white/40">@</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, ""))}
              placeholder="add by name"
              autoCapitalize="none"
              autoCorrect="off"
              className="w-full bg-transparent outline-none placeholder:text-white/30"
            />
          </label>
          {name ? (
            <button className="grid h-14 w-14 place-items-center rounded-full bg-accent text-black active:scale-90" aria-label="add">
              <Plus size={26} strokeWidth={3} />
            </button>
          ) : (
            <button type="button" onClick={() => setScanning(true)} className="grid h-14 w-14 place-items-center rounded-full bg-white/10 active:scale-90" aria-label="scan code">
              <ScanLine size={24} />
            </button>
          )}
        </form>

        {lists.incoming.length > 0 && (
          <Section title="added you">
            {lists.incoming.map((f) => (
              <Row key={f.username} name={f.username} color={f.color}>
                <button
                  onClick={() => api.block(f.username).then(() => (toast(`blocked @${f.username}`), onChanged()), (e) => toast(e.message))}
                  className="rounded-full bg-white/10 px-4 py-2 font-bold text-white/60 active:scale-95"
                >
                  block
                </button>
                <button onClick={() => add(f.username)} className="rounded-full bg-accent px-5 py-2 font-bold text-black active:scale-95">
                  accept
                </button>
              </Row>
            ))}
          </Section>
        )}

        {lists.friends.length > 0 && (
          <Section title="your people">
            {lists.friends.map((f) => (
              <Row key={f.username} name={f.username} color={f.color} onClick={() => onSnap(f.username)}>
                <span className="text-sm text-white/40">tap to snap</span>
              </Row>
            ))}
          </Section>
        )}

        {lists.outgoing.length > 0 && (
          <Section title="waiting on them">
            {lists.outgoing.map((f) => (
              <Row key={f.username} name={f.username} color={f.color}>
                <span className="text-sm text-white/40">pending</span>
              </Row>
            ))}
          </Section>
        )}
      </PullToRefresh>

      {scanning && (
        <Scanner
          hint="point at a friend's code"
          onClose={() => setScanning(false)}
          onCode={(code) => {
            setScanning(false);
            if (/^(kiks|kicksnap)-group:/i.test(code)) {
              api.joinGroup(code).then(
                (g) => (buzz(12), toast(`you're in ${g.name} 🎉`), onChanged()),
                (e) => toast(e.message)
              );
            } else if (/^(kiks|kicksnap)-link:/i.test(code)) {
              api.linkApprove(code.replace(/^(kiks|kicksnap)-link:/i, "")).then(
                () => toast("device added ✨"),
                (e) => toast(e.message)
              );
            } else add(code);
          }}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-7">
      <p className="mb-1 text-sm font-bold uppercase tracking-wider text-white/40">{title}</p>
      {children}
    </div>
  );
}

function Row({ name, color, onClick, children }: { name: string; color: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClick} className={`-mx-2 flex items-center gap-4 rounded-2xl px-2 py-2.5 ${onClick ? "cursor-pointer active:bg-white/5" : ""}`}>
      <Avatar name={name} color={color} size={46} />
      <p className="flex-1 truncate text-lg font-bold">{name}</p>
      {children}
    </div>
  );
}
