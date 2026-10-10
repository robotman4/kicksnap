import { ReactNode, useRef, useState } from "react";

/** Bottom sheet that slides up and closes on swipe down or backdrop tap. */
export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const [dy, setDy] = useState(0);
  const y0 = useRef<number | null>(null);
  return (
    <div className={`fixed inset-x-0 top-0 h-[var(--app-h,100%)] z-40 ${open ? "" : "pointer-events-none"}`} data-nodrag>
      <div
        className={`absolute inset-0 bg-black/60 transition-opacity duration-300 ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <div
        className={`absolute inset-x-0 bottom-0 max-h-[85vh] overflow-hidden rounded-t-[2rem] bg-zinc-900 text-white ${
          dy ? "" : "transition-transform duration-500 ease-spring"
        }`}
        style={{ transform: open ? `translateY(${dy}px)` : "translateY(105%)" }}
      >
        <div
          className="flex touch-none justify-center pb-2 pt-3"
          onPointerDown={(e) => {
            y0.current = e.clientY;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => y0.current !== null && setDy(Math.max(0, e.clientY - y0.current))}
          onPointerUp={() => {
            if (dy > 80) onClose();
            y0.current = null;
            setDy(0);
          }}
        >
          <div className="h-1.5 w-12 rounded-full bg-white/25" />
        </div>
        {children}
      </div>
    </div>
  );
}
