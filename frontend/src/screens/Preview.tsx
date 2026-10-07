import { Check, Download, Send, Timer, Type, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Sheet } from "../components/Sheet";
import { Friend } from "../lib/api";
import { buzz, pref, timerLabel, TIMERS } from "../lib/feel";
import { Capture } from "./Camera";

/** After the shutter: look at it, maybe add a caption, pick people, send. */
export function Preview({
  capture,
  friends,
  preselect,
  onClose,
  onSend,
  onAddFriends,
}: {
  capture: Capture;
  friends: Friend[];
  preselect: string[];
  onClose: () => void;
  onSend: (to: string[], seconds: number, caption: string) => Promise<void>;
  onAddFriends: () => void;
}) {
  const [seconds, setSeconds] = useState(() => Number(pref.get("seconds", "5")));
  const [caption, setCaption] = useState("");
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [to, setTo] = useState<string[]>(preselect);
  const [sending, setSending] = useState(false);
  const captionInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) captionInput.current?.focus();
  }, [editing]);

  const cycleTimer = () => {
    buzz(5);
    setSeconds(TIMERS[(TIMERS.indexOf(seconds as never) + 1) % TIMERS.length]);
  };

  const toggle = (name: string) => {
    buzz(5);
    setTo((t) => (t.includes(name) ? t.filter((n) => n !== name) : [...t, name]));
  };

  const send = async () => {
    if (!to.length || sending) return;
    setSending(true);
    try {
      await onSend(to, seconds, caption.trim());
    } finally {
      setSending(false);
    }
  };

  const save = () => {
    const a = document.createElement("a");
    a.href = capture.url;
    a.download = `kicksnap-${Date.now()}.${capture.kind === "video" ? "webm" : "jpg"}`;
    a.click();
    buzz(8);
  };

  return (
    <div className="fixed inset-0 z-30 animate-[pop_.25s_ease-out] bg-black text-white" data-nodrag>
      {capture.kind === "photo" ? (
        <img src={capture.url} className="absolute inset-0 h-full w-full object-cover" alt="" />
      ) : (
        <video
          src={capture.url}
          autoPlay
          loop
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
          style={{ transform: capture.mirrored ? "scaleX(-1)" : undefined }}
        />
      )}

      {/* tap the picture to caption it */}
      <button className="absolute inset-0" onClick={() => setEditing(true)} aria-label="add caption" />

      {(caption || editing) && (
        <div className="absolute inset-x-0 top-[62%] bg-black/55 px-4 py-2.5 text-center backdrop-blur-sm">
          {editing ? (
            <input
              ref={captionInput}
              value={caption}
              maxLength={120}
              onChange={(e) => setCaption(e.target.value)}
              onBlur={() => setEditing(false)}
              onKeyDown={(e) => e.key === "Enter" && setEditing(false)}
              className="w-full bg-transparent text-center text-xl font-semibold outline-none"
            />
          ) : (
            <p className="text-xl font-semibold" onClick={() => setEditing(true)}>
              {caption}
            </p>
          )}
        </div>
      )}

      <div className="absolute left-4 top-[max(env(safe-area-inset-top),14px)]">
        <Round onClick={onClose} label="discard">
          <X size={28} />
        </Round>
      </div>

      <div className="absolute right-4 top-[max(env(safe-area-inset-top),14px)] flex flex-col items-center gap-3">
        <Round onClick={() => setEditing(true)} label="caption">
          <Type size={24} />
        </Round>
        {capture.kind === "photo" && (
          <Round onClick={cycleTimer} label="view timer">
            <div className="flex flex-col items-center leading-none">
              <Timer size={20} />
              <span className="mt-0.5 text-[11px] font-black">{timerLabel(seconds)}</span>
            </div>
          </Round>
        )}
        <Round onClick={save} label="save">
          <Download size={24} />
        </Round>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex justify-end px-4 pb-[max(env(safe-area-inset-bottom),20px)]">
        <button
          onClick={() => (preselect.length ? send() : setPicking(true))}
          className="flex items-center gap-2 rounded-full bg-accent py-4 pl-6 pr-5 text-lg font-black text-black shadow-2xl transition active:scale-95"
        >
          {preselect.length ? `@${preselect[0]}` : "send to"}
          <Send size={22} strokeWidth={2.75} />
        </button>
      </div>

      <Sheet open={picking} onClose={() => setPicking(false)}>
        <div className="px-5 pb-2">
          <h2 className="text-2xl font-black">send to</h2>
        </div>
        {friends.length === 0 ? (
          <div className="flex flex-col items-center gap-4 px-8 pb-12 pt-6 text-center">
            <p className="text-white/60">No friends yet. Share your code and you're set.</p>
            <button onClick={onAddFriends} className="rounded-full bg-accent px-6 py-3 font-bold text-black active:scale-95">
              add friends
            </button>
          </div>
        ) : (
          <div className="grid max-h-[50vh] grid-cols-4 gap-y-5 overflow-y-auto px-4 pb-32 pt-3">
            {friends.map((f) => {
              const on = to.includes(f.username);
              return (
                <button key={f.username} onClick={() => toggle(f.username)} className="flex flex-col items-center gap-2 active:scale-95">
                  <div className="relative">
                    <Avatar name={f.username} color={f.color} size={60} ring={on} />
                    {on && (
                      <span className="absolute -bottom-1 -right-1 grid h-6 w-6 place-items-center rounded-full bg-accent text-black">
                        <Check size={16} strokeWidth={3.5} />
                      </span>
                    )}
                  </div>
                  <span className={`max-w-full truncate text-xs font-semibold ${on ? "text-white" : "text-white/60"}`}>{f.username}</span>
                </button>
              );
            })}
          </div>
        )}
        <div
          className={`absolute inset-x-0 bottom-0 flex items-center gap-3 bg-accent px-5 pb-[max(env(safe-area-inset-bottom),16px)] pt-4 text-black transition-transform duration-300 ease-spring ${
            to.length ? "translate-y-0" : "translate-y-full"
          }`}
        >
          <p className="flex-1 truncate text-lg font-bold">{to.join(", ")}</p>
          <button
            onClick={send}
            disabled={sending}
            className="grid h-14 w-14 place-items-center rounded-full bg-black text-accent transition active:scale-90 disabled:opacity-50"
            aria-label="send"
          >
            <Send size={24} strokeWidth={2.75} />
          </button>
        </div>
      </Sheet>
    </div>
  );
}

function Round({ children, onClick, label }: { children: React.ReactNode; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="relative z-10 grid h-12 w-12 place-items-center rounded-full bg-black/35 backdrop-blur transition active:scale-90"
    >
      {children}
    </button>
  );
}
