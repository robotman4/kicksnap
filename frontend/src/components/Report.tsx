import { Check, Flag } from "lucide-react";
import { useEffect, useState } from "react";
import { api, Reason } from "../lib/api";
import { buzz } from "../lib/feel";
import { Sheet } from "./Sheet";

const REASONS: { reason: Reason; label: string }[] = [
  { reason: "harassment", label: "bullying or harassment" },
  { reason: "nudity", label: "nudity or sexual stuff" },
  { reason: "violence", label: "violence or threats" },
  { reason: "spam", label: "spam or scam" },
  { reason: "other", label: "something else" },
];

/** Report someone to this server's admins. Blocks them too unless you untick it. */
export function ReportSheet({
  open,
  username,
  snap,
  onClose,
  onDone,
  toast,
}: {
  open: boolean;
  username: string;
  /** the snap being looked at, sent along as evidence */
  snap?: Blob | null;
  onClose: () => void;
  onDone: (blocked: boolean) => void;
  toast: (t: string) => void;
}) {
  const [reason, setReason] = useState<Reason | null>(null);
  const [note, setNote] = useState("");
  const [block, setBlock] = useState(true);
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setReason(null);
      setNote("");
      setBlock(true);
      setAttach(true);
    }
  }, [open]);

  const send = async () => {
    if (!reason) return;
    setBusy(true);
    try {
      await api.report(username, reason, note, block, attach ? snap : null);
      buzz(10);
      toast(block ? `reported and blocked @${username}` : `reported @${username}`);
      onDone(block);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const Toggle = ({ on, set, children }: { on: boolean; set: (v: boolean) => void; children: React.ReactNode }) => (
    <button onClick={() => set(!on)} className="flex items-center gap-3 py-2 text-left font-bold">
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${on ? "bg-accent text-black" : "bg-white/10"}`}>{on && <Check size={18} strokeWidth={4} />}</span>
      {children}
    </button>
  );

  return (
    <Sheet open={open} onClose={onClose}>
      <div className="max-h-[80vh] overflow-y-auto px-6 pb-[max(env(safe-area-inset-bottom),24px)]">
        <h2 className="flex items-center gap-2 text-3xl font-black">
          <Flag size={26} /> report @{username}
        </h2>
        <p className="mt-1 text-white/50">Goes to the people who run this server. They don't tell @{username} who reported.</p>
        <div className="mt-5 flex flex-col gap-2">
          {REASONS.map((r) => (
            <button
              key={r.reason}
              onClick={() => (buzz(5), setReason(r.reason))}
              className={`rounded-full py-3.5 text-lg font-bold transition active:scale-[.98] ${reason === r.reason ? "bg-accent text-black" : "bg-white/10"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 500))}
          placeholder="anything they should know (optional)"
          rows={2}
          className="mt-4 w-full resize-none rounded-3xl bg-white/10 px-5 py-3 text-lg font-semibold outline-none placeholder:text-white/30"
          style={{ userSelect: "text", WebkitUserSelect: "text" }}
        />
        <div className="mt-2 flex flex-col">
          {snap && (
            <Toggle on={attach} set={setAttach}>
              send this snap with the report
            </Toggle>
          )}
          <Toggle on={block} set={setBlock}>
            block @{username} too
          </Toggle>
        </div>
        <button
          onClick={send}
          disabled={!reason || busy}
          className="mt-4 w-full rounded-full bg-red-500 py-5 text-xl font-black text-white transition active:scale-95 disabled:opacity-30"
        >
          report
        </button>
      </div>
    </Sheet>
  );
}
