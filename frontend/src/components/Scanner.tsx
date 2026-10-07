import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

declare global {
  // Chrome/Android ship this; Safari doesn't yet, so we fall back to typing the code.
  // eslint-disable-next-line no-var
  var BarcodeDetector: { new (o: { formats: string[] }): { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> } } | undefined;
}

export const canScan = () => typeof globalThis.BarcodeDetector !== "undefined";

/** Full-screen QR scanner with a "type it instead" fallback. Accepts anything starting with kicksnap. */
export function Scanner({ hint, onClose, onCode }: { hint: string; onClose: () => void; onCode: (c: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const cb = useRef({ onClose, onCode });
  cb.current = { onClose, onCode };
  const [typed, setTyped] = useState("");
  const [typing, setTyping] = useState(!canScan());

  useEffect(() => {
    if (typing) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    const detector = new globalThis.BarcodeDetector!({ formats: ["qr_code"] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then(
      (s) => {
        stream = s;
        if (!video.current) return;
        video.current.srcObject = s;
        const tick = async () => {
          if (video.current?.readyState === 4) {
            const [hit] = await detector.detect(video.current).catch(() => []);
            if (hit?.rawValue.toLowerCase().startsWith("kicksnap")) return cb.current.onCode(hit.rawValue);
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      },
      () => setTyping(true)
    );
    return () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [typing]);

  return (
    <div className="fixed inset-0 z-50 bg-black text-white" data-nodrag>
      {!typing && (
        <>
          <video ref={video} autoPlay playsInline muted className="h-full w-full object-cover" />
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="h-64 w-64 animate-pulse rounded-[2.5rem] border-[6px] border-accent shadow-[0_0_0_100vmax_rgba(0,0,0,.6)]" />
          </div>
        </>
      )}
      {typing && (
        <form
          className="flex h-full flex-col items-center justify-center gap-6 px-8"
          onSubmit={(e) => {
            e.preventDefault();
            typed && onCode(typed);
          }}
        >
          <p className="text-center text-3xl font-black">type the code</p>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value.toUpperCase())}
            maxLength={20}
            autoCapitalize="characters"
            autoCorrect="off"
            className="w-full rounded-3xl bg-white/10 py-5 text-center font-mono text-4xl font-black tracking-[0.3em] outline-none focus:bg-white/15"
          />
          <button className="w-full rounded-full bg-accent py-5 text-2xl font-black text-black transition active:scale-95">go</button>
        </form>
      )}
      <button onClick={onClose} className="absolute left-4 top-[max(env(safe-area-inset-top),14px)] grid h-14 w-14 place-items-center rounded-full bg-black/40" aria-label="close">
        <X size={30} strokeWidth={2.75} />
      </button>
      {!typing && (
        <div className="absolute inset-x-0 bottom-[max(env(safe-area-inset-bottom),32px)] flex flex-col items-center gap-4">
          <p className="text-xl font-black">{hint}</p>
          <button onClick={() => setTyping(true)} className="rounded-full bg-white/15 px-6 py-3 font-bold backdrop-blur active:scale-95">
            type it instead
          </button>
        </div>
      )}
    </div>
  );
}
