import { RefreshCw } from "lucide-react";
import { ReactNode, useEffect, useRef, useState } from "react";
import { buzz } from "../lib/feel";

const TRIGGER = 72;

/**
 * Scroll container with pull-to-refresh. Uses touch events (not pointer events)
 * because the browser cancels pointer streams once it starts a native scroll.
 */
export function PullToRefresh({ onRefresh, children, className = "" }: { onRefresh: () => Promise<unknown>; children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const live = useRef({ y0: null as number | null, pull: 0, armed: false, busy: false });
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

  useEffect(() => {
    const el = box.current!;
    const s = live.current;
    const start = (e: TouchEvent) => {
      s.y0 = el.scrollTop <= 0 && !s.busy ? e.touches[0].clientY : null;
    };
    const move = (e: TouchEvent) => {
      if (s.y0 === null) return;
      const dy = e.touches[0].clientY - s.y0;
      if (dy <= 0) {
        s.pull = 0;
        setPull(0);
        return;
      }
      e.preventDefault(); // we own this gesture now, no rubber band
      s.pull = Math.min(130, dy * 0.5);
      if (s.pull >= TRIGGER && !s.armed) buzz(8);
      s.armed = s.pull >= TRIGGER;
      setPull(s.pull);
    };
    const end = async () => {
      if (s.y0 === null) return;
      s.y0 = null;
      if (!s.armed) return setPull(0);
      s.armed = false;
      s.busy = true;
      setBusy(true);
      setPull(TRIGGER * 0.8);
      await refresh.current().catch(() => {});
      s.busy = false;
      setBusy(false);
      setPull(0);
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, []);

  const settling = !live.current.y0;
  return (
    <div ref={box} className={`relative overflow-y-auto overflow-x-hidden overscroll-contain ${className}`}>
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 flex justify-center ${settling ? "transition-transform duration-300 ease-spring" : ""}`}
        style={{ transform: `translateY(${pull - 56}px)` }}
      >
        <div className="grid h-12 w-12 place-items-center rounded-full bg-accent text-black shadow-xl">
          <RefreshCw size={24} strokeWidth={3} className={busy ? "animate-spin" : ""} style={busy ? undefined : { transform: `rotate(${pull * 3}deg)` }} />
        </div>
      </div>
      <div className={settling ? "transition-transform duration-300 ease-spring" : ""} style={{ transform: `translateY(${pull}px)` }}>
        {children}
      </div>
    </div>
  );
}
