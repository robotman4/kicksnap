import { Check, LogOut } from "lucide-react";
import { Avatar } from "../components/Avatar";
import { Sheet } from "../components/Sheet";
import { User } from "../lib/api";
import { ACCENTS, buzz, onColor, timerLabel, TIMERS } from "../lib/feel";

export function Settings({
  open,
  me,
  seconds,
  onClose,
  onColor: setColor,
  onSeconds,
  onLogout,
}: {
  open: boolean;
  me: User;
  seconds: number;
  onClose: () => void;
  onColor: (c: string) => void;
  onSeconds: (s: number) => void;
  onLogout: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="px-6 pb-[max(env(safe-area-inset-bottom),24px)]">
        <div className="flex flex-col items-center gap-3 pt-2">
          <Avatar name={me.username} color={me.color} size={88} />
          <p className="text-2xl font-black">@{me.username}</p>
        </div>

        <p className="mb-3 mt-8 text-sm font-bold uppercase tracking-wider text-white/40">your colour</p>
        <div className="flex flex-wrap gap-3">
          {ACCENTS.map((c) => (
            <button
              key={c}
              onClick={() => {
                buzz(6);
                setColor(c);
              }}
              className="grid h-11 w-11 place-items-center rounded-full transition active:scale-90"
              style={{ background: c, color: onColor(c) }}
              aria-label={c}
            >
              {c.toLowerCase() === me.color.toLowerCase() && <Check size={22} strokeWidth={3.5} />}
            </button>
          ))}
        </div>

        <p className="mb-3 mt-8 text-sm font-bold uppercase tracking-wider text-white/40">photos show for</p>
        <div className="flex gap-2">
          {TIMERS.map((t) => (
            <button
              key={t}
              onClick={() => {
                buzz(5);
                onSeconds(t);
              }}
              className={`flex-1 rounded-full py-3 text-lg font-bold transition active:scale-95 ${
                t === seconds ? "bg-accent text-black" : "bg-white/10"
              }`}
            >
              {timerLabel(t)}
            </button>
          ))}
        </div>

        <button
          onClick={onLogout}
          className="mt-10 flex w-full items-center justify-center gap-2 rounded-full bg-white/5 py-4 font-bold text-white/60 active:scale-[.98]"
        >
          <LogOut size={20} /> sign out
        </button>
      </div>
    </Sheet>
  );
}
