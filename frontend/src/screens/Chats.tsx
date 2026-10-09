import { MessageCircle, Plus } from "lucide-react";
import { Avatar } from "../components/Avatar";
import { PullToRefresh } from "../components/PullToRefresh";
import { Chat, ChatState } from "../lib/api";
import { ago } from "../lib/feel";

// Snapchat colours: snaps in the accent, chat in blue.
const CHAT_BLUE = "#3DC9FF";

const STATE: Record<ChatState, { label: string; mark: "fill" | "line" | "arrow" | "arrowline" | null }> = {
  new: { label: "new snap", mark: "fill" },
  received: { label: "received", mark: "line" },
  delivered: { label: "delivered", mark: "arrow" },
  opened: { label: "opened", mark: "arrowline" },
  none: { label: "tap to snap", mark: null },
};

function Mark({ kind, color }: { kind: (typeof STATE)[ChatState]["mark"]; color: string }) {
  if (!kind) return null;
  if (kind === "fill") return <span className="h-3.5 w-3.5 rounded-[4px]" style={{ background: color }} />;
  if (kind === "line") return <span className="h-3.5 w-3.5 rounded-[4px] border-2" style={{ borderColor: color }} />;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" style={{ color }}>
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

function status(c: Chat) {
  const s = STATE[c.state];
  if (c.state === "new" && c.kind === "chat") return c.unread > 1 ? `${c.unread} new chats` : "new chat";
  if (c.state === "new") return c.snaps.length > 1 ? `${c.snaps.length} new snaps` : "new snap";
  return s.label;
}

export function Chats({
  chats,
  outgoing,
  onOpen,
  onTalk,
  onSnapBack,
  onFriends,
  onNewGroup,
  onRefresh,
}: {
  chats: Chat[];
  outgoing: Outgoing;
  onOpen: (c: Chat) => void;
  onTalk: (c: Chat) => void;
  onSnapBack: (key: string) => void;
  onFriends: () => void;
  onNewGroup: () => void;
  onRefresh: () => Promise<unknown>;
}) {
  return (
    <div className="flex h-full flex-col bg-black text-white">
      <header className="flex items-center justify-between px-5 pb-3 pt-[max(env(safe-area-inset-top),18px)]">
        <h1 className="text-4xl font-black tracking-tight">chats</h1>
        <button onClick={onNewGroup} aria-label="new group" className="flex items-center gap-1.5 rounded-full bg-white/10 py-2.5 pl-3 pr-4 font-bold active:scale-95">
          <Plus size={20} strokeWidth={3} /> group
        </button>
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
        {[...chats.filter((c) => outgoing[c.key]), ...chats.filter((c) => !outgoing[c.key])].map((c) => {
          const isNew = c.state === "new";
          const out = outgoing[c.key];
          const color = c.kind === "chat" ? CHAT_BLUE : "rgb(var(--accent))";
          return (
            <div key={c.key} className="flex items-center gap-1 pr-3">
              <button
                // new snaps play first; otherwise straight to the camera, aimed at them
                onClick={() => (c.away ? undefined : out?.failed ? out.retry() : c.snaps.length ? onOpen(c) : onSnapBack(c.key))}
                className="flex min-w-0 flex-1 items-center gap-4 px-5 py-3 text-left transition active:bg-white/5"
              >
                <Avatar name={c.name} color={c.color} size={52} group={c.group} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-lg font-bold">{c.name}</p>
                  {c.away ? (
                    <p className="text-sm text-white/35">unavailable</p>
                  ) : out ? (
                    <p className={`flex items-center gap-2 text-sm font-bold ${out.failed ? "text-red-400" : "text-accent"}`}>
                      {out.failed ? "didn't send · tap to retry" : <><Sending /> sending…</>}
                    </p>
                  ) : (
                    <p className={`flex items-center gap-2 text-sm ${isNew ? "font-bold" : "text-white/50"}`} style={isNew ? { color } : undefined}>
                      <Mark kind={STATE[c.state].mark} color={color} />
                      {status(c)}
                      {c.at > 0 && c.state !== "none" && <span className="text-white/35">· {ago(c.at)}</span>}
                    </p>
                  )}
                </div>
              </button>
              <button
                onClick={() => onTalk(c)}
                aria-label={`chat with ${c.name}`}
                className="relative grid h-12 w-12 place-items-center rounded-full text-white/60 active:scale-90 active:bg-white/10"
              >
                <MessageCircle size={24} />
                {c.unread > 0 && <span className="absolute right-2 top-2 h-3 w-3 rounded-full ring-2 ring-black" style={{ background: CHAT_BLUE }} />}
              </button>
            </div>
          );
        })}
      </PullToRefresh>
    </div>
  );
}
