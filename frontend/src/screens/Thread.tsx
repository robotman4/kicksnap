import { ArrowUp, Ban, Camera as CameraIcon, ChevronLeft, UserMinus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Sheet } from "../components/Sheet";
import { api, charCount, Chat, clip, MAX_CHARS, Message } from "../lib/api";
import { buzz } from "../lib/feel";
import { useVisualViewport } from "../lib/viewport";

/** A conversation: short texts, plus a camera button to snap them. `tick` bumps on live events. */
export function Thread({
  chat,
  tick,
  onClose,
  onSnap,
  onInfo,
  onGone,
  toast,
}: {
  chat: Chat;
  tick: number;
  onClose: () => void;
  onSnap: () => void;
  onInfo: () => void;
  /** you unfriended or blocked them */
  onGone: () => void;
  toast: (t: string) => void;
}) {
  const [friendMenu, setFriendMenu] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const who = chat.key.slice(2);
  const act = (p: Promise<unknown>, done: string) =>
    p.then(
      () => (buzz(10), toast(done), setFriendMenu(false), onGone()),
      (e) => toast((e as Error).message)
    );
  const [messages, setMessages] = useState<Message[]>([]);
  const [seenAt, setSeenAt] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const vv = useVisualViewport();

  const load = () =>
    api.messages(chat.key).then((r) => {
      setMessages(r.messages);
      setSeenAt(r.seen_at);
      api.read(chat.key).catch(() => {});
    }, () => {});

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.key, tick]);

  // stick to the newest message, also when the keyboard opens
  useLayoutEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages.length, vv.height]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.say(chat.key, body);
      buzz(8);
      setText("");
      await load();
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  const left = MAX_CHARS - charCount(text);
  const lastMine = [...messages].reverse().find((m) => m.mine);

  return (
    <div
      className="fixed inset-x-0 top-0 z-30 flex flex-col bg-black text-white"
      style={{ height: vv.height, transform: `translateY(${vv.top}px)` }}
      data-nodrag
    >
      <header className="flex items-center gap-2 border-b border-white/10 px-2 pb-2 pt-[max(env(safe-area-inset-top),10px)]">
        <button onClick={onClose} aria-label="back" className="grid h-12 w-12 place-items-center rounded-full active:bg-white/10">
          <ChevronLeft size={30} strokeWidth={2.75} />
        </button>
        <button
          onClick={() => (chat.group ? onInfo() : (setConfirmBlock(false), setFriendMenu(true)))}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <Avatar name={chat.name} color={chat.color} size={40} group={chat.group} />
          <div className="min-w-0">
            <p className="truncate text-lg font-black">{chat.name}</p>
            <p className="text-xs font-semibold text-white/40">{chat.group ? "tap for group info" : "tap for options"}</p>
          </div>
        </button>
        <button onClick={onSnap} aria-label={`snap ${chat.name}`} className="grid h-12 w-12 place-items-center rounded-full bg-accent text-black active:scale-90">
          <CameraIcon size={24} strokeWidth={2.5} />
        </button>
      </header>

      <div ref={list} className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        <p className="mb-4 text-center text-xs font-semibold text-white/30">chats disappear after 24h</p>
        {messages.length === 0 && <p className="mt-16 text-center text-2xl font-black text-white/30">say hi 👋</p>}
        {messages.map((m, i) => {
          const firstOfRun = messages[i - 1]?.from !== m.from;
          return (
            <div key={m.id} className={`flex flex-col ${m.mine ? "items-end" : "items-start"} ${firstOfRun ? "mt-3" : "mt-1"}`}>
              {firstOfRun && chat.group && !m.mine && (
                <span className="mb-1 ml-3 text-xs font-black" style={{ color: m.color }}>
                  {m.from}
                </span>
              )}
              <p
                className={`max-w-[80%] whitespace-pre-wrap break-words rounded-3xl px-4 py-2.5 text-lg font-semibold leading-snug ${
                  m.mine ? "bg-accent text-black" : "bg-white/10"
                }`}
                style={{ userSelect: "text", WebkitUserSelect: "text" }}
              >
                {m.body}
              </p>
              {!chat.group && m === lastMine && (
                <span className="mr-2 mt-1 text-xs font-bold text-white/40">{seenAt >= m.at ? "seen" : "delivered"}</span>
              )}
            </div>
          );
        })}
      </div>

      <form
        className="flex items-center gap-2 px-3 pb-[max(env(safe-area-inset-bottom),12px)] pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label className="relative flex flex-1 items-center rounded-full bg-white/10 focus-within:bg-white/15">
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(clip(e.target.value))}
            placeholder="chat"
            enterKeyHint="send"
            className="w-full bg-transparent py-3.5 pl-5 pr-14 text-lg font-semibold outline-none placeholder:text-white/30"
          />
          {left <= 30 && (
            <span className={`absolute right-4 text-sm font-black ${left <= 0 ? "text-red-400" : "text-white/40"}`}>{left}</span>
          )}
        </label>
        <button
          disabled={!text.trim() || busy}
          // keep the keyboard up between messages
          onMouseDown={(e) => e.preventDefault()}
          aria-label="send message"
          className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-accent text-black transition active:scale-90 disabled:opacity-30"
        >
          <ArrowUp size={28} strokeWidth={3} />
        </button>
      </form>

      {!chat.group && (
        <Sheet open={friendMenu} onClose={() => setFriendMenu(false)}>
          <div className="flex flex-col gap-3 px-6 pb-[max(env(safe-area-inset-bottom),24px)]">
            <div className="mb-2 flex items-center gap-4">
              <Avatar name={chat.name} color={chat.color} size={56} />
              <h2 className="truncate text-3xl font-black">@{chat.name}</h2>
            </div>
            <button
              onClick={() => act(api.removeFriend(who), `removed @${who}`)}
              className="flex items-center justify-center gap-2 rounded-full bg-white/10 py-5 text-lg font-bold active:scale-[.98]"
            >
              <UserMinus size={22} /> remove friend
            </button>
            <button
              onClick={() => (confirmBlock ? act(api.block(who), `blocked @${who}`) : setConfirmBlock(true))}
              className="flex items-center justify-center gap-2 rounded-full bg-red-500/15 py-5 text-lg font-bold text-red-400 active:scale-[.98]"
            >
              <Ban size={22} /> {confirmBlock ? "tap again to block" : `block @${who}`}
            </button>
            <p className="text-center text-sm text-white/40">Blocking unfriends you both and stops them finding you again.</p>
          </div>
        </Sheet>
      )}
    </div>
  );
}
