import { ReactNode, useEffect, useRef, useState } from "react";
import { buzz } from "../lib/feel";

/**
 * Horizontal swipe pager that loops: past the last panel comes the first again.
 * Vertical scrolling is left to the browser (touch-action: pan-y), horizontal
 * drags move between panels.
 */
export function Pager({ index, onChange, children }: { index: number; onChange: (i: number) => void; children: ReactNode[] }) {
  const n = children.length;
  const [drag, setDrag] = useState(0);
  const start = useRef<{ x: number; y: number; t: number; axis?: "x" | "y" } | null>(null);
  const width = () => window.innerWidth;

  // Each panel sits at -1 (left), 0 (showing) or +1 (right) relative to the current one.
  const rel = (i: number) => ((i - index + n + 1) % n) - 1;
  // A panel that jumps from one side to the other must not animate across the screen.
  const lastRel = useRef<number[]>([]);
  const rels = children.map((_, i) => rel(i));
  useEffect(() => {
    lastRel.current = rels;
  });

  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-nodrag]")) return;
    start.current = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const move = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.axis && Math.hypot(dx, dy) > 8) {
      s.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      // keep getting events even if the finger leaves the element mid-swipe
      if (s.axis === "x") (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    if (s.axis !== "x") return;
    setDrag(dx);
  };
  const up = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || s.axis !== "x") return setDrag(0);
    const dx = e.clientX - s.x;
    const fast = Math.abs(dx) / (performance.now() - s.t) > 0.4;
    let next = index;
    if (dx < -width() / 4 || (fast && dx < -30)) next = (index + 1) % n;
    if (dx > width() / 4 || (fast && dx > 30)) next = (index - 1 + n) % n;
    setDrag(0);
    if (next !== index) {
      buzz(6);
      onChange(next);
    }
  };
  // The browser took the gesture over (scroll, image drag, callout): its coordinates
  // are meaningless, so just settle back.
  const cancel = () => {
    start.current = null;
    setDrag(0);
  };

  return (
    <div
      className="relative h-full w-full touch-pan-y overflow-hidden"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onDragStart={(e) => e.preventDefault()}
    >
      {children.map((c, i) => {
        const r = rels[i];
        const jumped = lastRel.current[i] !== undefined && Math.abs(lastRel.current[i] - r) > 1;
        return (
          <section
            key={i}
            className={`absolute inset-0 ${drag || jumped ? "" : "transition-transform duration-500 ease-spring"}`}
            style={{ transform: `translate3d(calc(${r * 100}% + ${drag}px), 0, 0)` }}
            aria-hidden={r !== 0}
          >
            {c}
          </section>
        );
      })}
    </div>
  );
}
