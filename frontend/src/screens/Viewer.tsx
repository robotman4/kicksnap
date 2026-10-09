import { useEffect, useRef, useState } from "react";
import { Flag } from "lucide-react";
import { Avatar } from "../components/Avatar";
import { ReportSheet } from "../components/Report";
import { Media } from "../components/Media";
import { api, Chat } from "../lib/api";
import { openSnap, SnapProof } from "../lib/e2e";
import { ago, buzz } from "../lib/feel";

/** Full-screen snap player. Tap to skip, swipe down to close. Each snap burns once shown. */
export function Viewer({ chat, onDone, toast }: { chat: Chat; onDone: (replyTo?: string) => void; toast: (t: string) => void }) {
  const [i, setI] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [layer, setLayer] = useState<Blob | null>(null);
  const [proof, setProof] = useState<SnapProof | null>(null);
  // what the (decrypted) snap itself says; the server's copy is only a hint
  const [shown, setShown] = useState<{ kind: "photo" | "video"; seconds: number } | null>(null);
  const [cant, setCant] = useState<"nokey" | "bad" | null>(null);
  const [reporting, setReporting] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<string | null>(null);
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
    const urls: string[] = [];
    setUrl(null);
    setOverlay(null);
    setCant(null);
    openSnap(snap, chat)
      .then((r) => {
        if (gone) return;
        // can't open it here: say why, and don't burn it, another device may still open it
        if (!r.ok) return setCant(r.why);
        urls.push(URL.createObjectURL(r.media));
        if (r.overlay) urls.push(URL.createObjectURL(r.overlay));
        setOverlay(r.overlay ? urls[1] : null);
        setShown({ kind: r.kind, seconds: r.seconds });
        setUrl(urls[0]);
        setBlob(r.media);
        setLayer(r.overlay);
        setProof(r.proof);
        api.open(snap.id).catch(() => {});
      })
      .catch(() => !gone && next());
    return () => {
      gone = true;
      urls.forEach(URL.revokeObjectURL);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap?.id]);

  useEffect(() => {
    // the timer waits while you're reporting
    if (!url || !shown || shown.kind === "video" || !shown.seconds || reporting) return;
    const t = setTimeout(next, shown.seconds * 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, reporting]);

  if (!snap) return null;
  const timed = url && shown?.kind === "photo" && shown.seconds > 0;

  return (
    <div
      className="fixed inset-0 z-30 touch-none bg-black text-white"
      data-nodrag
      style={{ transform: `translateY(${dy}px) scale(${1 - dy / 2000})`, borderRadius: dy ? 24 : 0, transition: dy ? "none" : "transform .3s" }}
      onPointerDown={(e) => !reporting && (y0.current = e.clientY)}
      onPointerMove={(e) => y0.current !== null && setDy(Math.max(0, e.clientY - y0.current))}
      onPointerUp={() => {
        if (reporting || y0.current === null) return;
        const pulled = dy;
        y0.current = null;
        setDy(0);
        if (pulled > 120) onDone();
        else if (pulled < 8) next();
      }}
    >
      {!url && !cant && <div className="absolute inset-0 grid place-items-center"><div className="h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-accent" /></div>}
      {cant && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-10 text-center">
          <p className="text-5xl">🔒</p>
          <p className="text-2xl font-black">{cant === "nokey" ? "can't open this one here" : "this snap didn't check out"}</p>
          <p className="text-white/60">
            {cant === "nokey"
              ? "It was sent before this device was set up. Open it on your other device."
              : "It couldn't be decrypted or verified, so it isn't shown. Tap to skip."}
          </p>
        </div>
      )}
      {url && shown && <Media src={url} kind={shown.kind} onEnded={next} />}

      {url && overlay && <img src={overlay} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-contain" />}

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
                      ? { animation: `grow ${shown!.seconds}s linear forwards` }
                      : { width: n === i && url ? "100%" : 0 }
                }
              />
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Avatar name={chat.name} color={chat.color} size={36} group={chat.group} />
          <span className="font-bold">{chat.group ? `${snap.sender} · ${chat.name}` : chat.name}</span>
          <span className="text-sm text-white/60">{ago(snap.created_at)}</span>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => {
              e.stopPropagation();
              setReporting(true);
            }}
            aria-label="report this snap"
            className="ml-auto grid h-10 w-10 place-items-center rounded-full bg-black/30 text-white/70 active:scale-90"
          >
            <Flag size={18} />
          </button>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex justify-center pb-[max(env(safe-area-inset-bottom),18px)]">
        <button
          onPointerUp={(e) => {
            e.stopPropagation();
            onDone(chat.key);
          }}
          className="rounded-full bg-accent px-8 py-4 text-xl font-black text-black shadow-[0_6px_0_rgba(0,0,0,.35)] transition ease-spring active:translate-y-1 active:scale-95 active:shadow-none"
        >
          snap back
        </button>
      </div>

      <ReportSheet
        open={reporting}
        username={snap.sender}
        snap={blob}
        snapOverlay={layer}
        snapProof={proof}
        onClose={() => setReporting(false)}
        onDone={(blocked) => {
          setReporting(false);
          if (blocked) onDone();
        }}
        toast={toast}
      />
    </div>
  );
}
