import { useCallback, useEffect, useState } from "react";
import { Pager } from "./components/Pager";
import { Toast } from "./components/Toast";
import { api, Chat, FriendLists, live, User } from "./lib/api";
import { applyAccent, buzz, pref } from "./lib/feel";
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

function Home({ me, setMe }: { me: User & { username: string }; setMe: (u: User | null) => void }) {
  const [page, setPage] = useState(CAMERA);
  const [chats, setChats] = useState<Chat[]>([]);
  const [lists, setLists] = useState<FriendLists>({ friends: [], incoming: [], outgoing: [] });
  const [capture, setCapture] = useState<Capture | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Chat | null>(null);
  const [settings, setSettings] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(() => Number(pref.get("seconds", "5")));

  const refresh = useCallback(() => {
    api.chats().then(setChats).catch(() => {});
    api.friends().then(setLists).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    return live((e) => {
      refresh();
      if (e.type === "snap") {
        buzz([10, 60, 10]);
        if (document.hidden && "Notification" in window && Notification.permission === "granted") {
          new Notification("kicksnap", { body: `new snap from @${e.from}`, icon: "/icon.svg", tag: e.from });
        }
      }
    });
  }, [refresh]);

  const unread = chats.reduce((n, c) => n + c.snaps.length, 0);

  const snapAt = (name: string) => {
    setReplyTo(name);
    setPage(CAMERA);
  };

  const send = async (file: Blob, overlay: Blob | null, to: string[], secs: number) => {
    if (!capture) return;
    try {
      const r = await api.send(file, overlay, to, capture.kind === "video" ? 0 : secs);
      buzz([8, 40, 16]);
      setToast(`sent to ${r.sent_to.map((n) => "@" + n).join(", ")}`);
      URL.revokeObjectURL(capture.url);
      setCapture(null);
      setReplyTo(null);
      refresh();
      // ask once, after the first snap actually goes out
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    } catch (e) {
      setToast((e as Error).message);
    }
  };

  return (
    <div className="h-full bg-black">
      <Pager index={page} onChange={setPage}>
        <Chats chats={chats} onOpen={setViewing} onSnapBack={snapAt} onFriends={() => setPage(FRIENDS)} />
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

      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
