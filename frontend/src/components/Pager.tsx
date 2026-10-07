import { ReactNode, useRef, useState } from "react";
import { buzz } from "../lib/feel";

/**
 * Horizontal swipe pager. Vertical scrolling is left to the browser
 * (touch-action: pan-y), horizontal drags move between panels.
 */
export function Pager({ index, onChange, children }: { index: number; onChange: (i: number) => void; children: ReactNode[] }) {
  const [drag, setDrag] = useState(0);
  const start = useRef<{ x: number; y: number; t: number; axis?: "x" | "y" } | null>(null);
  const width = () => window.innerWidth;

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
    // rubber band at the edges
    const atEdge = (index === 0 && dx > 0) || (index === children.length - 1 && dx < 0);
    setDrag(atEdge ? dx / 4 : dx);
  };
  const up = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || s.axis !== "x") return setDrag(0);
    const dx = e.clientX - s.x;
    const fast = Math.abs(dx) / (performance.now() - s.t) > 0.4;
    let next = index;
    if (dx < -width() / 4 || (fast && dx < -30)) next = Math.min(index + 1, children.length - 1);
    if (dx > width() / 4 || (fast && dx > 30)) next = Math.max(index - 1, 0);
    setDrag(0);
    if (next !== index) {
      buzz(6);
      onChange(next);
    }
  };

  return (
    <div
      className="relative h-full w-full touch-pan-y overflow-hidden"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div
        className={`flex h-full ${drag ? "" : "transition-transform duration-500 ease-spring"}`}
        style={{ transform: `translate3d(calc(${-index * 100}% + ${drag}px), 0, 0)` }}
      >
        {children.map((c, i) => (
          <section key={i} className="relative h-full w-full shrink-0" aria-hidden={i !== index}>
            {c}
          </section>
        ))}
      </div>
    </div>
  );
}
