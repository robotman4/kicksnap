import { ChevronLeft, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Avatar } from "../components/Avatar";
import { AdminAppeal, AdminReport, AdminUser, api, Reserved } from "../lib/api";
import { ago, buzz } from "../lib/feel";

type Tab = "reports" | "users" | "names" | "log";
const REASON: Record<string, string> = {
  harassment: "bullying / harassment",
  nudity: "nudity / sexual",
  violence: "violence / threats",
  spam: "spam / scam",
  other: "something else",
};
const SUSPEND_DAYS: (number | null)[] = [1, 7, 30, null];

/** Suspend / delete buttons for one user, shared by reports and the user list. */
function Actions({ name, suspended, onDone, toast, onDismiss }: { name: string; suspended: boolean; onDone: () => void; toast: (t: string) => void; onDismiss?: () => void }) {
  const [mode, setMode] = useState<null | "suspend" | "delete">(null);
  const [reserve, setReserve] = useState(true);
  const run = (p: Promise<unknown>, msg: string) =>
    p.then(
      () => (buzz(10), toast(msg), setMode(null), onDone()),
      (e) => toast((e as Error).message)
    );

  if (mode === "suspend")
    return (
      <div className="mt-3 flex flex-wrap gap-2">
        {SUSPEND_DAYS.map((d) => (
          <button key={d ?? "x"} onClick={() => run(api.admin.suspend(name, d), `@${name} suspended`)} className="rounded-full bg-amber-400 px-4 py-2.5 font-black text-black active:scale-95">
            {d ? `${d} day${d > 1 ? "s" : ""}` : "until I lift it"}
          </button>
        ))}
        <button onClick={() => setMode(null)} className="rounded-full bg-white/10 px-4 py-2.5 font-bold">
          cancel
        </button>
      </div>
    );
  if (mode === "delete")
    return (
      <div className="mt-3 rounded-3xl bg-red-500/10 p-4">
        <p className="font-bold text-red-400">Delete @{name} and everything they have on this server? Can't be undone.</p>
        <button onClick={() => setReserve(!reserve)} className="mt-2 flex items-center gap-2 font-bold">
          <span className={`grid h-6 w-6 place-items-center rounded-md ${reserve ? "bg-accent text-black" : "bg-white/10"}`}>{reserve && "✓"}</span>
          keep the name reserved so nobody can take it
        </button>
        <div className="mt-3 flex gap-2">
          <button onClick={() => setMode(null)} className="flex-1 rounded-full bg-white/10 py-3 font-bold">
            cancel
          </button>
          <button onClick={() => run(api.admin.remove(name, reserve), `@${name} deleted`)} className="flex-1 rounded-full bg-red-500 py-3 font-black text-white">
            delete
          </button>
        </div>
      </div>
    );
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {onDismiss && (
        <button onClick={onDismiss} className="rounded-full bg-white/10 px-4 py-2.5 font-bold active:scale-95">
          dismiss
        </button>
      )}
      {suspended ? (
        <button onClick={() => run(api.admin.unsuspend(name), `@${name} is back`)} className="rounded-full bg-white/10 px-4 py-2.5 font-bold active:scale-95">
          lift suspension
        </button>
      ) : (
        <button onClick={() => setMode("suspend")} className="rounded-full bg-amber-400/15 px-4 py-2.5 font-bold text-amber-300 active:scale-95">
          suspend
        </button>
      )}
      <button onClick={() => setMode("delete")} className="rounded-full bg-red-500/15 px-4 py-2.5 font-bold text-red-400 active:scale-95">
        delete
      </button>
    </div>
  );
}

/** A suspended person asking to be let back in. */
function Appeal({ a, onDone, toast }: { a: AdminAppeal; onDone: () => void; toast: (t: string) => void }) {
  const [reply, setReply] = useState("");
  const decide = (lift: boolean) =>
    api.admin.decide(a.id, lift, reply).then(
      () => (buzz(10), toast(lift ? `@${a.username} is back` : `kept @${a.username} suspended`), onDone()),
      (e) => toast(e.message)
    );
  return (
    <div className="rounded-[2rem] bg-sky-400/10 p-5">
      <div className="flex items-center gap-3">
        <p className="flex-1 truncate text-xl font-black">@{a.username}</p>
        <span className="text-sm text-white/40">{ago(a.at)}</span>
      </div>
      <p className="mt-1 font-bold text-sky-300">appeal</p>
      <p className="text-sm text-white/50">
        suspended {a.until ? `until ${new Date(a.until * 1000).toLocaleDateString()}` : "until lifted"}
        {a.reason ? ` for ${a.reason}` : ""}
      </p>
      <p className="mt-2 whitespace-pre-wrap break-words rounded-2xl bg-black/40 px-4 py-2 text-white/80">“{a.body}”</p>
      <input
        value={reply}
        onChange={(e) => setReply(e.target.value.slice(0, 500))}
        placeholder="short answer they'll see (optional)"
        className="mt-3 w-full rounded-full bg-white/10 px-5 py-3 font-semibold outline-none placeholder:text-white/30"
        style={{ userSelect: "text", WebkitUserSelect: "text" }}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => decide(true)} className="rounded-full bg-accent px-4 py-2.5 font-black text-black active:scale-95">
          lift suspension
        </button>
        <button onClick={() => decide(false)} className="rounded-full bg-white/10 px-4 py-2.5 font-bold active:scale-95">
          keep suspended
        </button>
      </div>
    </div>
  );
}

function Reports({ tick, toast }: { tick: number; toast: (t: string) => void }) {
  const [list, setList] = useState<AdminReport[] | null>(null);
  const [appeals, setAppeals] = useState<AdminAppeal[]>([]);
  // evidence url -> blob url
  const [media, setMedia] = useState<Record<string, string>>({});
  const load = () =>
    Promise.all([api.admin.appeals().then(setAppeals), api.admin.reports().then(setList)]).catch((e) => toast(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  // evidence is fetched with the cookie, then shown from a blob
  useEffect(() => {
    const urls: string[] = [];
    list?.forEach((r) => {
      [r.media, ...r.shots].forEach((src) => {
        if (src && !media[src])
          fetch(src, { credentials: "same-origin" })
            .then((res) => res.blob())
            .then((b) => {
              const u = URL.createObjectURL(b);
              urls.push(u);
              setMedia((m) => ({ ...m, [src]: u }));
            });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  if (!list) return null;
  if (!list.length && !appeals.length) return <p className="mt-20 text-center text-2xl font-black text-white/30">nothing to look at 🎉</p>;
  return (
    <div className="flex flex-col gap-4">
      {appeals.map((a) => (
        <Appeal key={`a${a.id}`} a={a} onDone={load} toast={toast} />
      ))}
      {list.map((r) => (
        <div key={r.id} className="rounded-[2rem] bg-white/5 p-5">
          <div className="flex items-center gap-3">
            <p className="flex-1 truncate text-xl font-black">
              @{r.reported} {r.reported_suspended && <span className="text-sm text-amber-300">· suspended</span>}
              {r.reported_gone && <span className="text-sm text-white/40">· deleted</span>}
            </p>
            <span className="text-sm text-white/40">{ago(r.at)}</span>
          </div>
          <p className="mt-1 font-bold text-red-300">{REASON[r.reason] ?? r.reason}</p>
          <p className="text-sm text-white/50">
            from @{r.reporter}
            {r.was_friend ? " (a friend of theirs)" : ""} · {r.friend_reporters} friend{r.friend_reporters === 1 ? "" : "s"} reported them
          </p>
          {r.note && <p className="mt-2 rounded-2xl bg-black/40 px-4 py-2 text-white/80">“{r.note}”</p>}
          {r.media && media[r.media] && (
            <div className="mt-3 overflow-hidden rounded-2xl bg-black">
              {r.media_kind === "video" ? (
                <video src={media[r.media]} controls playsInline className="max-h-80 w-full object-contain" />
              ) : (
                <img src={media[r.media]} alt="reported snap" className="max-h-80 w-full object-contain" />
              )}
            </div>
          )}
          {r.texts.length > 0 && (
            <div className="mt-3 flex flex-col gap-1.5">
              {r.texts.map((t, i) => (
                <div key={i} className="flex flex-col items-start">
                  <p className="max-w-[90%] whitespace-pre-wrap break-words rounded-3xl bg-white/10 px-4 py-2 font-semibold">{t.body}</p>
                  <span className="ml-3 mt-0.5 text-xs text-white/40">
                    {t.group ? `in ${t.group}` : "to them directly"} · {ago(t.at)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {r.shots.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              {r.shots.map((src) =>
                media[src] ? (
                  <a key={src} href={media[src]} target="_blank" rel="noreferrer" className="overflow-hidden rounded-xl bg-black">
                    <img src={media[src]} alt="screenshot" className="aspect-[9/16] w-full object-cover" />
                  </a>
                ) : (
                  <div key={src} className="aspect-[9/16] rounded-xl bg-white/5" />
                )
              )}
            </div>
          )}
          {!r.reported_gone ? (
            <Actions
              name={r.reported}
              suspended={r.reported_suspended}
              onDone={load}
              toast={toast}
              onDismiss={() => api.admin.dismiss(r.id).then(() => (buzz(6), load()), (e) => toast(e.message))}
            />
          ) : (
            <button onClick={() => api.admin.dismiss(r.id).then(load)} className="mt-3 rounded-full bg-white/10 px-4 py-2.5 font-bold">
              close
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Users({ toast }: { toast: (t: string) => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<AdminUser[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => api.admin.users(q).then(setList, () => {});
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  return (
    <>
      <label className="flex items-center gap-2 rounded-full bg-white/10 px-5 py-3.5">
        <Search size={20} className="text-white/40" />
        <input value={q} onChange={(e) => setQ(e.target.value.toLowerCase())} placeholder="search a name" autoCapitalize="none" className="w-full bg-transparent text-lg font-semibold outline-none placeholder:text-white/30" />
      </label>
      <div className="mt-3">
        {list.map((u) => (
          <div key={u.username} className="border-b border-white/5 py-3">
            <button onClick={() => setOpen(open === u.username ? null : u.username)} className="flex w-full items-center gap-3 text-left">
              <Avatar name={u.username} color={u.color} size={44} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold">
                  {u.username} {u.admin && <span className="text-accent">· admin</span>}
                  {u.suspended && <span className="text-amber-300"> · suspended{u.suspended_until ? ` until ${new Date(u.suspended_until * 1000).toLocaleDateString()}` : ""}</span>}
                </p>
                <p className="text-sm text-white/40">
                  joined {new Date(u.created_at * 1000).toLocaleDateString()} · {u.devices} device{u.devices === 1 ? "" : "s"}
                  {u.open_reports > 0 && <span className="text-red-300"> · {u.open_reports} open report{u.open_reports === 1 ? "" : "s"}</span>}
                </p>
              </div>
            </button>
            {open === u.username && !u.admin && <Actions name={u.username} suspended={u.suspended} onDone={load} toast={toast} />}
          </div>
        ))}
      </div>
    </>
  );
}

function Names({ toast }: { toast: (t: string) => void }) {
  const [list, setList] = useState<Reserved[]>([]);
  const [name, setName] = useState("");
  const load = () => api.admin.reserved().then(setList, () => {});
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          api.admin.reserve(name, "").then(() => (setName(""), load()), (err) => toast(err.message));
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="block a name" autoCapitalize="none" className="w-full rounded-full bg-white/10 px-5 py-3.5 text-lg font-semibold outline-none placeholder:text-white/30" />
        <button disabled={!name} className="rounded-full bg-accent px-5 font-black text-black disabled:opacity-30">
          add
        </button>
      </form>
      <div className="mt-3">
        {list.map((r) => (
          <div key={r.name} className="flex items-center gap-3 border-b border-white/5 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-bold">{r.name}</p>
              <p className="text-sm text-white/40">
                {r.reason || "reserved"} · by {r.by}
                {r.expires_at ? ` · free ${new Date(r.expires_at * 1000).toLocaleDateString()}` : ""}
              </p>
            </div>
            <button onClick={() => api.admin.release(r.name).then(load)} aria-label={`release ${r.name}`} className="grid h-10 w-10 place-items-center rounded-full bg-white/5 text-white/60 active:scale-90">
              <X size={18} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function Log() {
  const [list, setList] = useState<{ admin: string; action: string; target: string; detail: string; at: number }[]>([]);
  useEffect(() => {
    api.admin.log().then(setList, () => {});
  }, []);
  return (
    <div>
      {list.map((l, i) => (
        <p key={i} className="border-b border-white/5 py-2.5 text-white/80">
          <span className="font-bold">@{l.admin}</span> {l.action} <span className="font-bold">{l.target}</span>
          {l.detail && <span className="text-white/40"> · {l.detail}</span>}
          <span className="text-white/30"> · {ago(l.at) || "now"}</span>
        </p>
      ))}
    </div>
  );
}

export function AdminView({ tick, onClose, toast }: { tick: number; onClose: () => void; toast: (t: string) => void }) {
  const [tab, setTab] = useState<Tab>("reports");
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white" data-nodrag>
      <header className="flex items-center gap-2 px-2 pt-[max(env(safe-area-inset-top),10px)]">
        <button onClick={onClose} aria-label="back" className="grid h-12 w-12 place-items-center rounded-full active:bg-white/10">
          <ChevronLeft size={30} strokeWidth={2.75} />
        </button>
        <h1 className="text-3xl font-black">admin</h1>
      </header>
      <div className="flex gap-2 overflow-x-auto px-4 py-3">
        {(["reports", "users", "names", "log"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`shrink-0 whitespace-nowrap rounded-full px-5 py-2.5 font-bold ${tab === t ? "bg-accent text-black" : "bg-white/10"}`}>
            {t === "names" ? "reserved names" : t}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-[max(env(safe-area-inset-bottom),24px)]" style={{ userSelect: "text", WebkitUserSelect: "text" }}>
        {tab === "reports" && <Reports tick={tick} toast={toast} />}
        {tab === "users" && <Users toast={toast} />}
        {tab === "names" && <Names toast={toast} />}
        {tab === "log" && <Log />}
      </div>
    </div>,
    document.body
  );
}
