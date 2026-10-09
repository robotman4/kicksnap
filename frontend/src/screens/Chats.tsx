import { Camera as CameraIcon } from "lucide-react";
import { Avatar } from "../components/Avatar";
import { PullToRefresh } from "../components/PullToRefresh";
import { Chat, ChatState } from "../lib/api";
import { ago } from "../lib/feel";

const STATE: Record<ChatState, { label: string; mark: "fill" | "line" | "arrow" | "arrowline" | null }> = {
  new: { label: "new snap", mark: "fill" },
  received: { label: "received", mark: "line" },
  delivered: { label: "delivered", mark: "arrow" },
  opened: { label: "opened", mark: "arrowline" },
  none: { label: "tap to snap", mark: null },
};

function Mark({ kind }: { kind: (typeof STATE)[ChatState]["mark"] }) {
  if (!kind) return null;
  if (kind === "fill") return <span className="h-3.5 w-3.5 rounded-[4px] bg-accent" />;
  if (kind === "line") return <span className="h-3.5 w-3.5 rounded-[4px] border-2 border-accent" />;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="text-accent">
      <path d="M2 1.5 12.5 7 2 12.5 4.5 7Z" fill={kind === "arrow" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export type Outgoing = Record<string, { failed: boolean; retry: () => void }>;

/** Outline arrow that keeps filling in while the snap uploads. */
function Sending() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="text-accent">
      <path d="M2 1.5 12.5 7 2 12.5 4.5 7Z" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" className="animate-[sending_1s_ease-in-out_infinite]" />
    </svg>
  );
}

export function Chats({ chats, outgoing, onOpen, onSnapBack, onFriends, onRefresh }: { chats: Chat[]; outgoing: Outgoing; onOpen: (c: Chat) => void; onSnapBack: (name: string) => void; onFriends: () => void; onRefresh: () => Promise<unknown> }) {
  return (
    <div className="flex h-full flex-col bg-black text-white">
      <header className="px-5 pb-3 pt-[max(env(safe-area-inset-top),18px)]">
        <h1 className="text-4xl font-black tracking-tight">chats</h1>
      </header>
      <PullToRefresh onRefresh={onRefresh} className="flex-1 pb-24">
        {chats.length === 0 && (
          <div className="flex flex-col items-center gap-4 px-10 pt-24 text-center">
            <p className="text-2xl font-black">quiet in here</p>
            <p className="text-white/50">Add a friend and send the first snap.</p>
            <button onClick={onFriends} className="rounded-full bg-accent px-6 py-3 font-bold text-black active:scale-95">
              add friends
            </button>
          </div>
        )}
        {[...chats.filter((c) => outgoing[c.username]), ...chats.filter((c) => !outgoing[c.username])].map((c) => {
          const s = STATE[c.state];
          const isNew = c.state === "new";
          const out = outgoing[c.username];
          return (
            <div key={c.username} className="flex items-center gap-1 pr-3">
              <button
                onClick={() => (out?.failed ? out.retry() : isNew ? onOpen(c) : out ? undefined : onSnapBack(c.username))}
                className="flex min-w-0 flex-1 items-center gap-4 px-5 py-3 text-left transition active:bg-white/5"
              >
                <Avatar name={c.username} color={c.color} size={52} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-lg font-bold">{c.username}</p>
                  {out ? (
                    <p className={`flex items-center gap-2 text-sm font-bold ${out.failed ? "text-red-400" : "text-accent"}`}>
                      {out.failed ? "didn't send · tap to retry" : <><Sending /> sending…</>}
                    </p>
                  ) : (
                    <p className={`flex items-center gap-2 text-sm ${isNew ? "font-bold text-accent" : "text-white/50"}`}>
                      <Mark kind={s.mark} />
                      {isNew && c.snaps.length > 1 ? `${c.snaps.length} new snaps` : s.label}
                      {c.at > 0 && <span className="text-white/35">· {ago(c.at)}</span>}
                    </p>
                  )}
                </div>
              </button>
              <button
                onClick={() => onSnapBack(c.username)}
                aria-label={`snap ${c.username}`}
                className="grid h-11 w-11 place-items-center rounded-full text-white/60 active:scale-90 active:bg-white/10"
              >
                <CameraIcon size={22} />
              </button>
            </div>
          );
        })}
      </PullToRefresh>
    </div>
  );
}
