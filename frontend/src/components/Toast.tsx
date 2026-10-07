import { useEffect } from "react";

export function Toast({ text, onDone }: { text: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(onDone, 2200);
    return () => clearTimeout(t);
  }, [text, onDone]);
  return (
    <div
      className={`pointer-events-none fixed inset-x-0 top-[max(env(safe-area-inset-top),12px)] z-50 flex justify-center transition-all duration-300 ease-spring ${
        text ? "translate-y-0 opacity-100" : "-translate-y-8 opacity-0"
      }`}
    >
      <div className="rounded-full bg-white px-5 py-2.5 text-sm font-bold text-black shadow-2xl">{text}</div>
    </div>
  );
}
