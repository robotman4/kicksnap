import { useEffect, useRef, useState } from "react";
import { Avatar } from "../components/Avatar";
import { api, Chat } from "../lib/api";
import { ago, buzz } from "../lib/feel";

/** Full-screen snap player. Tap to skip, swipe down to close. Each snap burns once shown. */
export function Viewer({ chat, onDone }: { chat: Chat; onDone: (replyTo?: string) => void }) {
  const [i, setI] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [dy, setDy] = useState(0);
  const y0 = useRef<number | null>(null);
  const snap = chat.snaps[i];

  const next = () => {
    buzz(5);
    if (i + 1 < chat.snaps.length) setI(i + 1);
    else onDone();
  };

  useEffect(() => {
    if (!snap) return onDone();
    let gone = false;
    let objectUrl: string | null = null;
    setUrl(null);
    api
      .media(snap.id)
      .then((blob) => {
        if (gone) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        api.open(snap.id).catch(() => {});
      })
      .catch(() => !gone && next());
    return () => {
      gone = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap?.id]);

  useEffect(() => {
    if (!url || !snap || snap.kind === "video" || !snap.seconds) return;
    const t = setTimeout(next, snap.seconds * 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (!snap) return null;
  const timed = url && snap.kind === "photo" && snap.seconds > 0;

  return (
    <div
      className="fixed inset-0 z-30 touch-none bg-black text-white"
      data-nodrag
      style={{ transform: `translateY(${dy}px) scale(${1 - dy / 2000})`, borderRadius: dy ? 24 : 0, transition: dy ? "none" : "transform .3s" }}
      onPointerDown={(e) => (y0.current = e.clientY)}
      onPointerMove={(e) => y0.current !== null && setDy(Math.max(0, e.clientY - y0.current))}
      onPointerUp={() => {
        const pulled = dy;
        y0.current = null;
        setDy(0);
        if (pulled > 120) onDone();
        else if (pulled < 8) next();
      }}
    >
      {!url && <div className="absolute inset-0 grid place-items-center"><div className="h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-accent" /></div>}
      {url && snap.kind === "photo" && <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" />}
      {url && snap.kind === "video" && (
        <video src={url} autoPlay playsInline className="absolute inset-0 h-full w-full object-cover" onEnded={next} />
      )}

      {snap.caption && (
        <div className="absolute inset-x-0 top-[62%] bg-black/55 px-4 py-2.5 text-center text-xl font-semibold backdrop-blur-sm">{snap.caption}</div>
      )}

      <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/50 to-transparent px-3 pb-8 pt-[max(env(safe-area-inset-top),10px)]">
        <div className="flex gap-1">
          {chat.snaps.map((s, n) => (
            <div key={s.id} className="h-1 flex-1 overflow-hidden rounded-full bg-white/30">
              <div
                className="h-full bg-white"
                style={
                  n < i
                    ? { width: "100%" }
                    : n === i && timed
                      ? { animation: `grow ${snap.seconds}s linear forwards` }
                      : { width: n === i && url ? "100%" : 0 }
                }
              />
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Avatar name={chat.username} color={chat.color} size={36} />
          <span className="font-bold">{chat.username}</span>
          <span className="text-sm text-white/60">{ago(snap.created_at)}</span>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex justify-center pb-[max(env(safe-area-inset-bottom),18px)]">
        <button
          onPointerUp={(e) => {
            e.stopPropagation();
            onDone(chat.username);
          }}
          className="rounded-full bg-white/15 px-6 py-3 font-bold backdrop-blur active:scale-95"
        >
          snap back
        </button>
      </div>
    </div>
  );
}
