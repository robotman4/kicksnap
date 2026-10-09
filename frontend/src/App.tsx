import { useCallback, useEffect, useState } from "react";
import { Pager } from "./components/Pager";
import { Toast } from "./components/Toast";
import { api, ApiError, Chat, FriendLists, live, Suspension, User } from "./lib/api";
import { Bell } from "lucide-react";
import { applyAccent, buzz, pref } from "./lib/feel";
import { enablePush, pushState, syncPush } from "./lib/push";
import { Camera, Capture } from "./screens/Camera";
import { Chats } from "./screens/Chats";
import { Friends } from "./screens/Friends";
import { PickName, Welcome } from "./screens/Onboard";
import { Preview } from "./screens/Preview";
import { Settings } from "./screens/Settings";
import { GroupInfo, NewGroup } from "./screens/Groups";
import { AdminView } from "./screens/Admin";
import { Thread } from "./screens/Thread";
import { Viewer } from "./screens/Viewer";

const CHATS = 0;
const CAMERA = 1;
const FRIENDS = 2;

export default function App() {
  const [me, setMe] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (me) applyAccent(me.color);
  }, [me]);

  if (booting) return <div className="h-full bg-black" />;
  if (!me) return <Welcome onIn={setMe} />;
  if (!me.username) return <PickName onDone={setMe} />;
  if (me.suspended_until !== undefined) return <Suspended me={me} onOut={() => api.logout().finally(() => setMe(null))} onBack={() => api.me().then(setMe, () => {})} />;
  return <Home me={me as User & { username: string }} setMe={setMe} />;
}

type Outgoing = { id: string; to: string[]; seconds: number; made: Promise<{ file: Blob; overlay: Blob | null }>; failed: boolean };

function Home({ me, setMe }: { me: User & { username: string }; setMe: (u: User | null) => void }) {
  const [page, setPage] = useState(CAMERA);
  const [chats, setChats] = useState<Chat[]>([]);
  const [lists, setLists] = useState<FriendLists>({ friends: [], incoming: [], outgoing: [] });
  const [capture, setCapture] = useState<Capture | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Chat | null>(null);
  const [talking, setTalking] = useState<Chat | null>(null);
  const [groupInfo, setGroupInfo] = useState<number | null>(null);
  const [making, setMaking] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  // bumps on every live event so open screens refetch
  const [tick, setTick] = useState(0);
  const [settings, setSettings] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [askPush, setAskPush] = useState(false);
  const [seconds, setSeconds] = useState(() => Number(pref.get("seconds", "5")));

  const refresh = useCallback(
    () =>
      Promise.all([
        api.chats().then(setChats, (e) => {
          // suspended while the app was open: show it
          if (e instanceof ApiError && e.status === 403) api.me().then(setMe, () => {});
        }),
        api.friends().then(setLists).catch(() => {}),
      ]),
    []
  );

  useEffect(() => {
    refresh();
    syncPush();
    // sign-in responses are minimal; pick up the admin flag etc.
    api.me().then(setMe, () => {});
    // Phones drop the socket when the app is backgrounded, so catch up on return.
    const back = () => !document.hidden && refresh();
    document.addEventListener("visibilitychange", back);
    const stop = live(refresh, (e) => {
      refresh();
      setTick((t) => t + 1);
      if (e.type === "snap" || e.type === "message") {
        buzz([10, 60, 10]);
      }
      if (e.type === "group" && e.closed) {
        setTalking((c) => (c?.key === e.closed ? null : c));
        setGroupInfo((g) => (`g:${g}` === e.closed ? null : g));
      }
    });
    return () => {
      stop();
      document.removeEventListener("visibilitychange", back);
    };
  }, [refresh]);

  const unread = chats.reduce((n, c) => n + c.snaps.length, 0);

  /** Open the camera aimed at a chat (key: "u:name" or "g:id"). */
  const snapAt = (key: string) => {
    setReplyTo(key);
    setTalking(null);
    setPage(CAMERA);
  };
  // keep an open thread's header in sync with the list (renames, colours)
  const talkingNow = talking && (chats.find((c) => c.key === talking.key) ?? talking);
  const nameOf = (key: string) => {
    const c = chats.find((x) => x.key === key);
    return c ? (c.group ? c.name : `@${c.name}`) : `@${key.slice(2)}`;
  };

  // Sends run in the background: the editor closes straight away and the chat rows
  // show "sending" until the upload lands. Failed ones stay on the row to retry.
  const [outbox, setOutbox] = useState<Outgoing[]>([]);
  const upload = async (job: Outgoing) => {
    setOutbox((o) => o.map((j) => (j.id === job.id ? { ...j, failed: false } : j)));
    try {
      const { file, overlay } = await job.made;
      await api.send(file, overlay, job.to, job.seconds);
      buzz([8, 40, 16]);
      await refresh();
      setOutbox((o) => o.filter((j) => j.id !== job.id));
      // offer notifications once, right after the first snap goes out
      if (!pref.get("asked-push", "")) {
        pref.set("asked-push", "1");
        pushState().then((s) => s === "off" && setAskPush(true));
      }
    } catch (e) {
      setOutbox((o) => o.map((j) => (j.id === job.id ? { ...j, failed: true } : j)));
      // network drops just show on the row; only surface what the server actually said
      if (e instanceof ApiError) setToast(e.message);
    }
  };

  const send = (make: () => Promise<{ file: Blob; overlay: Blob | null }>, to: string[], secs: number) => {
    if (!capture) return;
    const cap = capture;
    // let the chats page paint before the full-res encode grabs the main thread
    const made = new Promise<void>((ok) => requestAnimationFrame(() => setTimeout(ok, 50)))
      .then(make)
      .finally(() => URL.revokeObjectURL(cap.url));
    made.catch(() => {});
    const job: Outgoing = { id: cap.url, to, seconds: cap.kind === "video" ? 0 : secs, made, failed: false };
    buzz(8);
    setCapture(null);
    setReplyTo(null);
    setPage(CHATS);
    setOutbox((o) => [...o, job]);
    upload(job);
  };

  const outgoing = Object.fromEntries(
    outbox.flatMap((j) => j.to.map((n) => [n, { failed: j.failed, retry: () => upload(j) }] as const))
  );

  return (
    <div className="h-full bg-black">
      <Pager index={page} onChange={setPage}>
        <Chats
          chats={chats}
          outgoing={outgoing}
          onRefresh={refresh}
          onOpen={setViewing}
          onTalk={setTalking}
          onSnapBack={snapAt}
          onFriends={() => setPage(FRIENDS)}
          onNewGroup={() => setMaking(true)}
        />
        <Camera
          me={me}
          active={page === CAMERA && !capture && !viewing && !talking}
          unread={unread}
          onCapture={setCapture}
          onChats={() => setPage(CHATS)}
          onFriends={() => setPage(FRIENDS)}
          onSettings={() => setSettings(true)}
        />
        <Friends me={me} lists={lists} onChanged={refresh} onSnap={(n) => snapAt(`u:${n}`)} toast={setToast} />
      </Pager>

      {replyTo && page === CAMERA && !capture && (
        <div className="pointer-events-none fixed inset-x-0 top-[max(env(safe-area-inset-top),18px)] z-20 flex justify-center">
          <button
            className="pointer-events-auto rounded-full bg-accent px-4 py-2 text-sm font-black text-black shadow-xl"
            onClick={() => setReplyTo(null)}
          >
            snapping {nameOf(replyTo)} ✕
          </button>
        </div>
      )}

      {capture && (
        <Preview
          key={capture.url}
          capture={capture}
          targets={chats}
          preselect={replyTo ? [replyTo] : []}
          onClose={() => {
            URL.revokeObjectURL(capture.url);
            setCapture(null);
          }}
          onSend={send}
          onAddFriends={() => {
            setCapture(null);
            setPage(FRIENDS);
          }}
        />
      )}

      {viewing && (
        <Viewer
          chat={viewing}
          toast={setToast}
          onDone={(back) => {
            setViewing(null);
            refresh();
            if (back) snapAt(back);
          }}
        />
      )}

      {talkingNow && (
        <Thread
          chat={talkingNow}
          tick={tick}
          onClose={() => {
            setTalking(null);
            refresh();
          }}
          onSnap={() => snapAt(talkingNow.key)}
          onInfo={() => talkingNow.group && setGroupInfo(Number(talkingNow.key.slice(2)))}
          onGone={() => {
            setTalking(null);
            refresh();
          }}
          toast={setToast}
        />
      )}

      <NewGroup
        open={making}
        friends={lists.friends}
        onClose={() => setMaking(false)}
        onMade={(g) => {
          setMaking(false);
          refresh();
          setPage(CHATS);
          setTalking({ key: g.key, name: g.name, color: g.color, group: true, state: "none", kind: "chat", at: 0, snaps: [], unread: 0 });
        }}
        toast={setToast}
      />
      <GroupInfo
        id={groupInfo}
        me={me.username}
        friends={lists.friends}
        tick={tick}
        onClose={() => setGroupInfo(null)}
        onGone={() => {
          setGroupInfo(null);
          setTalking(null);
          refresh();
        }}
        toast={setToast}
      />

      <Settings
        open={settings}
        me={me}
        seconds={seconds}
        onClose={() => setSettings(false)}
        onColor={(c) => {
          setMe({ ...me, color: c });
          api.setColor(c).catch(() => {});
        }}
        onSeconds={(s) => {
          setSeconds(s);
          pref.set("seconds", String(s));
        }}
        onLogout={() => {
          api.logout().finally(() => setMe(null));
        }}
        onDeleted={() => setMe(null)}
        onAdmin={() => {
          setSettings(false);
          setAdminOpen(true);
        }}
        toast={setToast}
      />

      {askPush && (
        <div className="fixed inset-x-4 bottom-[max(env(safe-area-inset-bottom),20px)] z-40 flex animate-[pop_.25s_ease-out] items-center gap-3 rounded-[2rem] bg-white p-3 pl-5 text-black shadow-2xl">
          <Bell size={28} strokeWidth={2.5} className="shrink-0" />
          <p className="flex-1 text-lg font-black leading-tight">know when they snap back?</p>
          <button onClick={() => setAskPush(false)} className="rounded-full px-3 py-3 font-bold text-black/50">
            nah
          </button>
          <button
            onClick={async () => {
              setAskPush(false);
              const s = await enablePush().catch(() => "off");
              setToast(s === "on" ? "notifications on 🔔" : "notifications are off");
            }}
            className="rounded-full bg-black px-5 py-3 font-black text-accent active:scale-95"
          >
            yes
          </button>
        </div>
      )}

      {adminOpen && <AdminView tick={tick} onClose={() => setAdminOpen(false)} toast={setToast} />}

      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function Suspended({ me, onOut, onBack }: { me: User; onOut: () => void; onBack: () => void }) {
  const [state, setState] = useState<Suspension | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () =>
    api.suspension().then((s) => (s.suspended ? setState(s) : onBack()), () => {});
  useEffect(() => {
    load();
    // an admin may have answered while the app was in the background
    const vis = () => !document.hidden && load();
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = state?.suspended ? state : null;
  const until = (s ? s.until : me.suspended_until) || 0;
  const send = async () => {
    setBusy(true);
    setError("");
    try {
      await api.appeal(text);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col justify-center gap-4 overflow-y-auto bg-black px-8 py-[max(env(safe-area-inset-top),24px)] text-white">
      <p className="text-5xl">⏸️</p>
      <h1 className="text-4xl font-black leading-tight">@{me.username} is on a break</h1>
      <p className="text-lg text-white/60">
        The people running this server suspended your account
        {until ? ` until ${new Date(until * 1000).toLocaleDateString()}` : " until they lift it"}. You can't send or get snaps while it lasts.
      </p>
      {s?.reason && (
        <p className="rounded-3xl bg-white/5 px-5 py-3 text-white/80">
          <span className="text-sm font-bold text-white/40">reason</span>
          <br />
          {s.reason}
        </p>
      )}
      {s && !s.appeal && (
        <div className="mt-2">
          <p className="font-black">think it's a mistake?</p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 1000))}
            placeholder="tell them why they should lift it"
            rows={3}
            className="mt-2 w-full resize-none rounded-3xl bg-white/10 px-5 py-3 text-lg font-semibold outline-none placeholder:text-white/30"
            style={{ userSelect: "text", WebkitUserSelect: "text" }}
          />
          <p className="mt-1 text-sm text-white/40">You get one appeal per suspension.</p>
          {error && <p className="mt-1 text-sm font-bold text-red-400">{error}</p>}
          <button
            onClick={send}
            disabled={!text.trim() || busy}
            className="mt-3 w-full rounded-full bg-accent py-5 text-lg font-black text-black transition active:scale-95 disabled:opacity-30"
          >
            send appeal
          </button>
        </div>
      )}
      {s?.appeal && !s.appeal.outcome && (
        <p className="rounded-3xl bg-white/5 px-5 py-3 text-white/70">Appeal sent. You'll see their answer here.</p>
      )}
      {s?.appeal?.outcome === "rejected" && (
        <div className="rounded-3xl bg-white/5 px-5 py-3">
          <p className="font-black">they kept the suspension</p>
          {s.appeal.reply && <p className="mt-1 text-white/80">“{s.appeal.reply}”</p>}
        </div>
      )}
      <button onClick={onOut} className="mt-4 rounded-full bg-white/10 py-5 text-lg font-bold active:scale-95">
        sign out here
      </button>
    </div>
  );
}
