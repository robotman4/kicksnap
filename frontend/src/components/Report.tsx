import { Check, Flag, ImagePlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, Reason, TheirText } from "../lib/api";
import { buzz } from "../lib/feel";
import { openTheirTexts, SnapProof } from "../lib/e2e";
import { Sheet } from "./Sheet";

const MAX_TEXTS = 10;
const MAX_SHOTS = 3;

const when = (at: number) => new Date(at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

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
  snapOverlay,
  snapProof,
  text,
  onClose,
  onDone,
  toast,
}: {
  open: boolean;
  username: string;
  /** the snap being looked at, sent along as evidence */
  snap?: Blob | null;
  /** its drawing layer and the sender's signature, so admins can see it's really from them */
  snapOverlay?: Blob | null;
  snapProof?: SnapProof | null;
  /** a text of theirs to start with ticked (reporting from a chat bubble) */
  text?: number;
  onClose: () => void;
  onDone: (blocked: boolean) => void;
  toast: (t: string) => void;
}) {
  const [reason, setReason] = useState<Reason | null>(null);
  const [note, setNote] = useState("");
  const [block, setBlock] = useState(true);
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [texts, setTexts] = useState<TheirText[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [shots, setShots] = useState<{ file: File; url: string }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setReason(null);
    setNote("");
    setBlock(true);
    setAttach(true);
    setPicked(text ? [text] : []);
    shotsRef.current.forEach((s) => URL.revokeObjectURL(s.url));
    setShots([]);
    setTexts([]);
    // E2E texts come encrypted; only the ones this device can open can be picked
    api.reportTexts(username).then((t) => openTheirTexts(username, t)).then(setTexts, () => {});
  }, [open, username, text]);

  // free thumbnails when the sheet goes away
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  useEffect(() => () => shotsRef.current.forEach((s) => URL.revokeObjectURL(s.url)), []);

  const pick = (id: number) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_TEXTS ? p : [...p, id]));

  const addShots = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])].filter((f) => f.type.startsWith("image/"));
    e.target.value = "";
    setShots((s) => [...s, ...files.slice(0, MAX_SHOTS - s.length).map((file) => ({ file, url: URL.createObjectURL(file) }))]);
  };

  const send = async () => {
    if (!reason) return;
    setBusy(true);
    try {
      await api.report(username, reason, note, block, {
        snap: attach ? snap : null,
        snapOverlay: attach ? snapOverlay : null,
        snapProof: attach ? snapProof : null,
        texts: texts.filter((t) => picked.includes(t.id)),
        shots: shots.map((s) => s.file),
      });
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
        <h3 className="mt-5 text-lg font-black">
          proof <span className="font-bold text-white/40">(optional)</span>
        </h3>
        {texts.length > 0 && (
          <>
            <p className="text-sm text-white/50">Tick their texts to send a copy. Texts disappear after 24h, so this is what's left.</p>
            <div className="mt-2 flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded-3xl bg-white/5 p-2">
              {texts.map((t) => {
                const on = picked.includes(t.id);
                return (
                  <button
                    key={t.id}
                    onClick={() => (buzz(4), pick(t.id))}
                    aria-pressed={on}
                    className={`flex items-start gap-3 rounded-2xl px-3 py-2 text-left transition ${on ? "bg-accent/15" : "active:bg-white/5"}`}
                  >
                    <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md ${on ? "bg-accent text-black" : "bg-white/10"}`}>
                      {on && <Check size={16} strokeWidth={4} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block whitespace-pre-wrap break-words font-semibold">{t.body}</span>
                      <span className="text-xs text-white/40">
                        {t.group ? `in ${t.group}` : "to you"} · {when(t.at)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
        <div className="mt-3 flex gap-2">
          {shots.map((s, i) => (
            <div key={s.url} className="relative h-24 w-16 overflow-hidden rounded-xl bg-black">
              <img src={s.url} alt={`screenshot ${i + 1}`} className="h-full w-full object-cover" />
              <button
                onClick={() => (URL.revokeObjectURL(s.url), setShots((all) => all.filter((x) => x !== s)))}
                aria-label={`remove screenshot ${i + 1}`}
                className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/70"
              >
                <X size={14} strokeWidth={3} />
              </button>
            </div>
          ))}
          {shots.length < MAX_SHOTS && (
            <button
              onClick={() => fileInput.current?.click()}
              className="flex h-24 flex-1 items-center justify-center gap-2 rounded-xl border-2 border-dashed border-white/15 font-bold text-white/60 active:bg-white/5"
            >
              <ImagePlus size={22} /> add screenshot
            </button>
          )}
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={addShots} />
        </div>
        <div className="mt-3 flex flex-col">
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
