import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

declare global {
  // Chrome/Android ship this; Safari doesn't, so there we decode frames with jsQR.
  // eslint-disable-next-line no-var
  var BarcodeDetector: { new (o: { formats: string[] }): { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> } } | undefined;
}

type Detect = (v: HTMLVideoElement) => Promise<string | undefined>;

/** Native detector when the browser has one, otherwise jsQR on a downscaled frame. */
async function makeDetector(): Promise<Detect> {
  if (globalThis.BarcodeDetector) {
    const d = new globalThis.BarcodeDetector({ formats: ["qr_code"] });
    return async (v) => (await d.detect(v).catch(() => []))[0]?.rawValue;
  }
  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  return async (v) => {
    const scale = Math.min(1, 640 / v.videoWidth);
    const w = (canvas.width = Math.round(v.videoWidth * scale));
    const h = (canvas.height = Math.round(v.videoHeight * scale));
    ctx.drawImage(v, 0, 0, w, h);
    return jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" })?.data;
  };
}

/** Full-screen QR scanner with a "type it instead" fallback. Accepts anything starting with kiks (or kicksnap, from before the rename). */
export function Scanner({ hint, onClose, onCode }: { hint: string; onClose: () => void; onCode: (c: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const cb = useRef({ onClose, onCode });
  cb.current = { onClose, onCode };
  const [typed, setTyped] = useState("");
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    if (typing) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let dead = false;
    Promise.all([makeDetector(), navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })]).then(
      ([detect, s]) => {
        stream = s;
        if (dead) return s.getTracks().forEach((t) => t.stop());
        if (!video.current) return;
        video.current.srcObject = s;
        const tick = async () => {
          if (dead) return;
          if (video.current?.readyState === 4) {
            const hit = await detect(video.current);
            if (dead) return;
            if (hit && /^(kiks|kicksnap)/i.test(hit)) return cb.current.onCode(hit);
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      },
      () => !dead && setTyping(true)
    );
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [typing]);

  // Portaled to <body>: inside the swipe pager, a transformed parent would pin
  // "fixed" to the pager track instead of the screen.
  return createPortal(
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
    </div>,
    document.body
  );
}
