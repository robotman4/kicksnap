import { useCallback, useEffect, useState } from "react";
import { Pager } from "./components/Pager";
import { Toast } from "./components/Toast";
import { api, ApiError, Chat, FriendLists, live, User } from "./lib/api";
import { Bell } from "lucide-react";
import { applyAccent, buzz, pref } from "./lib/feel";
import { enablePush, pushState, syncPush } from "./lib/push";
import { Camera, Capture } from "./screens/Camera";
import { Chats } from "./screens/Chats";
import { Friends } from "./screens/Friends";
import { PickName, Welcome } from "./screens/Onboard";
import { Preview } from "./screens/Preview";
import { Settings } from "./screens/Settings";
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
  const [settings, setSettings] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [askPush, setAskPush] = useState(false);
  const [seconds, setSeconds] = useState(() => Number(pref.get("seconds", "5")));

  const refresh = useCallback(
    () =>
      Promise.all([
        api.chats().then(setChats).catch(() => {}),
        api.friends().then(setLists).catch(() => {}),
      ]),
    []
  );

  useEffect(() => {
    refresh();
    syncPush();
    // Phones drop the socket when the app is backgrounded, so catch up on return.
    const back = () => !document.hidden && refresh();
    document.addEventListener("visibilitychange", back);
    const stop = live(refresh, (e) => {
      refresh();
      if (e.type === "snap") {
        buzz([10, 60, 10]);
      }
    });
    return () => {
      stop();
      document.removeEventListener("visibilitychange", back);
    };
  }, [refresh]);

  const unread = chats.reduce((n, c) => n + c.snaps.length, 0);

  const snapAt = (name: string) => {
    setReplyTo(name);
    setPage(CAMERA);
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
        <Chats chats={chats} outgoing={outgoing} onRefresh={refresh} onOpen={setViewing} onSnapBack={snapAt} onFriends={() => setPage(FRIENDS)} />
        <Camera
          me={me}
          active={page === CAMERA && !capture && !viewing}
          unread={unread}
          onCapture={setCapture}
          onChats={() => setPage(CHATS)}
          onFriends={() => setPage(FRIENDS)}
          onSettings={() => setSettings(true)}
        />
        <Friends me={me} lists={lists} onChanged={refresh} onSnap={snapAt} toast={setToast} />
      </Pager>

      {replyTo && page === CAMERA && !capture && (
        <div className="pointer-events-none fixed inset-x-0 top-[max(env(safe-area-inset-top),18px)] z-20 flex justify-center">
          <button
            className="pointer-events-auto rounded-full bg-accent px-4 py-2 text-sm font-black text-black shadow-xl"
            onClick={() => setReplyTo(null)}
          >
            snapping @{replyTo} ✕
          </button>
        </div>
      )}

      {capture && (
        <Preview
          key={capture.url}
          capture={capture}
          friends={lists.friends}
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
          onDone={(back) => {
            setViewing(null);
            refresh();
            if (back) snapAt(back);
          }}
        />
      )}

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

      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
