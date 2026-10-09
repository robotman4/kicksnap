import { Check, Download, Pencil, Send, Timer, Type, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Media } from "../components/Media";
import { Sheet } from "../components/Sheet";
import { buzz, containRect, pref, Rect, timerLabel, TIMERS } from "../lib/feel";
import { useVisualViewport } from "../lib/viewport";
import { Capture } from "./Camera";

// Strokes and text are stored in 0..1 coordinates of the screen. The photo is shown
// whole (object-fit: contain), and on send they're mapped onto the full-resolution
// image through that same rect, so nothing is cropped or upscaled.
type Pt = [number, number];
type Stroke = { color: string; width: number; pts: Pt[] };
type TextStyle = "bar" | "big";
type Label = { text: string; style: TextStyle; color: string; x: number; y: number };

const INKS = ["#FFFFFF", "#000000", "#FF3D5A", "#FF8A3D", "#FFE14D", "#C6FF3D", "#3DD9FF", "#7C5CFF", "#FF5CD6"];
const BRUSH = 0.012; // of screen width
// font sizes as a fraction of screen height, shared by DOM preview and canvas output
const FONT = { bar: 0.028, big: 0.065 };

function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width * w;
    ctx.beginPath();
    s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
    if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] * w + 0.1, s.pts[0][1] * h);
    ctx.stroke();
  }
}

function drawLabel(ctx: CanvasRenderingContext2D, l: Label, w: number, h: number, r: Rect) {
  if (!l.text.trim()) return;
  const size = FONT[l.style] * h;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (l.style === "bar") {
    ctx.font = `600 ${size}px system-ui, -apple-system, sans-serif`;
    const bh = size * 2;
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.fillRect(r.x, l.y * h - bh / 2, r.w, bh);
    ctx.fillStyle = "#fff";
    ctx.fillText(l.text, r.x + r.w / 2, l.y * h, r.w * 0.94);
  } else {
    ctx.font = `900 ${size}px system-ui, -apple-system, sans-serif`;
    ctx.lineWidth = size * 0.14;
    ctx.strokeStyle = l.color === "#000000" ? "#fff" : "#000";
    ctx.strokeText(l.text, l.x * w, l.y * h, r.w * 0.94);
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, l.x * w, l.y * h, r.w * 0.94);
  }
}

const MAX_SIDE = 4096;

/**
 * Bake drawing + text into what gets sent, at the media's own resolution.
 * Photos come out as one JPEG; videos keep their file and get a PNG layer the same size.
 */
async function compose(capture: Capture, dims: { w: number; h: number }, strokes: Stroke[], label: Label | null) {
  const decorated = strokes.length > 0 || !!label?.text.trim();
  // Photos always get re-encoded: that also strips EXIF (GPS etc.) from gallery picks.
  if (capture.kind === "video" && !decorated) return { file: capture.blob, overlay: null };

  const fit = Math.min(1, MAX_SIDE / Math.max(dims.w, dims.h));
  const W = Math.round(dims.w * fit);
  const H = Math.round(dims.h * fit);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;

  if (capture.kind === "photo") {
    const img = new Image();
    img.src = capture.url;
    await img.decode();
    ctx.drawImage(img, 0, 0, W, H);
  }
  // screen px -> image px, through the rect the media is shown in
  const sw = window.innerWidth;
  const sh = window.innerHeight;
  const r = containRect(dims.w, dims.h, sw, sh);
  const k = W / r.w;
  ctx.setTransform(k, 0, 0, k, -r.x * k, -r.y * k);
  drawStrokes(ctx, strokes, sw, sh);
  if (label) drawLabel(ctx, label, sw, sh, r);

  const out = (type: string, q?: number) => new Promise<Blob>((ok) => c.toBlob((b) => ok(b!), type, q));
  return capture.kind === "photo"
    ? { file: await out("image/jpeg", 0.92), overlay: null }
    : { file: capture.blob, overlay: await out("image/png") };
}

const l0 = (l: Label | null) => l?.style;

/** After the shutter: doodle, add text, pick people, send. */
export function Preview({
  capture,
  targets,
  preselect,
  onClose,
  onSend,
  onAddFriends,
}: {
  capture: Capture;
  /** friends and groups, as chat keys */
  targets: { key: string; name: string; color: string; group: boolean }[];
  preselect: string[];
  onClose: () => void;
  /** Called right away; `make` renders the final file, so the heavy work happens after the editor closes. */
  onSend: (make: () => Promise<{ file: Blob; overlay: Blob | null }>, to: string[], seconds: number) => void;
  onAddFriends: () => void;
}) {
  const [seconds, setSeconds] = useState(() => Number(pref.get("seconds", "5")));
  const [mode, setMode] = useState<"look" | "draw" | "text">("look");
  const [ink, setInk] = useState(INKS[5]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [label, setLabel] = useState<Label | null>(null);
  const [picking, setPicking] = useState(false);
  const [to, setTo] = useState<string[]>(preselect);
  const [sending, setSending] = useState(false);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const rect = containRect(dims.w, dims.h);
  const vv = useVisualViewport();
  const typing = mode === "text";
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<Stroke | null>(null);
  const textInput = useRef<HTMLInputElement>(null);
  const dragText = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);

  // redraw strokes whenever they change
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = window.innerWidth * dpr;
    c.height = window.innerHeight * dpr;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    drawStrokes(ctx, drawing.current ? [...strokes, drawing.current] : strokes, c.width, c.height);
  });

  useEffect(() => {
    if (mode === "text") textInput.current?.focus();
  }, [mode]);

  const rel = (e: React.PointerEvent): Pt => [e.clientX / window.innerWidth, e.clientY / window.innerHeight];
  const [, force] = useState(0);

  const drawDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drawing.current = { color: ink, width: BRUSH, pts: [rel(e)] };
    force((n) => n + 1);
  };
  const drawMove = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    drawing.current.pts.push(rel(e));
    force((n) => n + 1);
  };
  const drawUp = () => {
    const done = drawing.current;
    drawing.current = null;
    if (done) setStrokes((s) => [...s, done]);
  };

  const tapText = () => {
    buzz(6);
    if (mode === "text" && label) {
      // second tap on T flips the style, like Snapchat
      setLabel({ ...label, style: label.style === "bar" ? "big" : "bar" });
      return;
    }
    // start text in the lower part of the photo itself, not on the blurred fill
    const y = (rect.y + rect.h * 0.75) / window.innerHeight;
    setLabel((l) => l ?? { text: "", style: "bar", color: ink, x: 0.5, y });
    setMode("text");
  };

  const finishText = () => {
    setMode("look");
    setLabel((l) => (l && l.text.trim() ? l : null));
  };

  const cycleTimer = () => {
    buzz(5);
    setSeconds(TIMERS[(TIMERS.indexOf(seconds as never) + 1) % TIMERS.length]);
  };

  const nameOf = (key: string) => {
    const t = targets.find((x) => x.key === key);
    return t ? (t.group ? t.name : `@${t.name}`) : key.slice(2);
  };

  const toggle = (name: string) => {
    buzz(5);
    setTo((t) => (t.includes(name) ? t.filter((n) => n !== name) : [...t, name]));
  };

  const send = (recipients = to) => {
    if (!recipients.length || sending) return;
    setSending(true);
    onSend(() => compose(capture, dims, strokes, label), recipients, seconds);
  };

  const save = async () => {
    const { file, overlay } = await compose(capture, dims, strokes, label);
    for (const [blob, ext] of [[file, capture.kind === "video" ? "webm" : "jpg"], [overlay, "png"]] as const) {
      if (!blob) continue;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `kicksnap-${Date.now()}.${ext}`;
      a.click();
    }
    buzz(8);
  };

  // While typing, the text sits just above the keyboard (Snapchat-style) and drops
  // back to its spot when done. The photo itself never moves.
  const typingSpot = { top: vv.height - 24, transform: l0(label) === "bar" ? "translateY(-100%)" : "translate(-50%,-100%)" };
  const labelStyle = (l: Label): React.CSSProperties => ({ ...baseLabelStyle(l), ...(typing ? typingSpot : {}) });
  const baseLabelStyle = (l: Label): React.CSSProperties =>
    l.style === "bar"
      ? { top: `${l.y * 100}%`, left: rect.x, width: rect.w, fontSize: `${FONT.bar * 100}vh`, transform: "translateY(-50%)" }
      : {
          top: `${l.y * 100}%`,
          left: `${l.x * 100}%`,
          fontSize: `${FONT.big * 100}vh`,
          transform: "translate(-50%,-50%)",
          color: l.color,
          WebkitTextStroke: `${FONT.big * 14}vh ${l.color === "#000000" ? "#fff" : "#000"}`,
          paintOrder: "stroke fill",
        };

  return (
    <div
      className="fixed inset-0 z-30 animate-[pop_.25s_ease-out] touch-none bg-black text-white"
      data-nodrag
      // iOS pans the page up to show the focused field; undo that so the photo stays put
      style={typing && vv.top ? { transform: `translateY(${vv.top}px)` } : undefined}
    >
      <Media src={capture.url} kind={capture.kind} loop onDims={setDims} />

      <canvas
        ref={canvas}
        className={`absolute inset-0 h-full w-full ${mode === "draw" ? "" : "pointer-events-none"}`}
        onPointerDown={drawDown}
        onPointerMove={drawMove}
        onPointerUp={drawUp}
        onPointerCancel={drawUp}
      />

      {/* tap the picture to start typing */}
      {mode === "look" && <button className="absolute inset-0" onClick={tapText} aria-label="add text" />}

      {label && (
        <div
          className={`absolute whitespace-nowrap text-center ${label.style === "bar" ? "bg-black/55 py-[1.4vh] font-semibold backdrop-blur-sm" : "font-black"}`}
          style={labelStyle(label)}
          onPointerDown={(e) => {
            if (mode !== "look") return;
            e.stopPropagation();
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            const [x, y] = rel(e);
            dragText.current = { dx: x - label.x, dy: y - label.y, moved: false };
          }}
          onPointerMove={(e) => {
            if (!dragText.current) return;
            const [x, y] = rel(e);
            dragText.current.moved = true;
            setLabel({ ...label, x: x - dragText.current.dx, y: Math.min(0.92, Math.max(0.08, y - dragText.current.dy)) });
          }}
          onPointerUp={() => {
            const tapped = dragText.current && !dragText.current.moved;
            dragText.current = null;
            if (tapped) setMode("text");
          }}
        >
          {mode === "text" ? (
            <input
              ref={textInput}
              value={label.text}
              maxLength={80}
              onChange={(e) => setLabel({ ...label, text: e.target.value })}
              onBlur={finishText}
              onKeyDown={(e) => e.key === "Enter" && finishText()}
              className="w-[90vw] bg-transparent text-center outline-none"
              style={{ color: "inherit", font: "inherit" }}
            />
          ) : (
            label.text
          )}
        </div>
      )}

      {/* top-left: close / undo */}
      <div className="absolute left-4 top-[max(env(safe-area-inset-top),14px)] flex gap-3">
        <Round onClick={onClose} label="discard">
          <X size={32} strokeWidth={2.75} />
        </Round>
        {mode === "draw" && strokes.length > 0 && (
          <Round onClick={() => (buzz(5), setStrokes((s) => s.slice(0, -1)))} label="undo">
            <Undo2 size={28} strokeWidth={2.5} />
          </Round>
        )}
      </div>

      {/* right rail: tools */}
      <div className="absolute right-4 top-[max(env(safe-area-inset-top),14px)] flex flex-col items-center gap-3">
        <Round onClick={tapText} label="text" on={mode === "text"}>
          <Type size={28} strokeWidth={2.75} />
        </Round>
        <Round onClick={() => (buzz(6), setMode(mode === "draw" ? "look" : "draw"))} label="draw" on={mode === "draw"} tint={mode === "draw" ? ink : undefined}>
          <Pencil size={26} strokeWidth={2.75} />
        </Round>
        {mode === "draw" && (
          <div className="mt-1 flex flex-col items-center gap-2 rounded-full bg-black/30 p-2 backdrop-blur">
            {INKS.map((c) => (
              <button
                key={c}
                onClick={() => (buzz(4), setInk(c))}
                aria-label={`ink ${c}`}
                className={`h-8 w-8 rounded-full border-[3px] transition ease-spring ${c === ink ? "scale-125 border-white" : "border-white/30"}`}
                style={{ background: c }}
              />
            ))}
          </div>
        )}
        {mode !== "draw" && capture.kind === "photo" && (
          <Round onClick={cycleTimer} label="view timer">
            <div className="flex flex-col items-center leading-none">
              <Timer size={22} strokeWidth={2.75} />
              <span className="mt-0.5 text-xs font-black">{timerLabel(seconds)}</span>
            </div>
          </Round>
        )}
        {mode !== "draw" && (
          <Round onClick={save} label="save">
            <Download size={26} strokeWidth={2.75} />
          </Round>
        )}
      </div>

      {mode === "look" && (
        <div className="absolute inset-x-0 bottom-0 flex justify-end px-4 pb-[max(env(safe-area-inset-bottom),20px)]">
          <button
            onClick={() => (preselect.length ? send(preselect) : setPicking(true))}
            disabled={sending}
            className="flex items-center gap-3 rounded-full bg-accent py-5 pl-8 pr-6 text-2xl font-black text-black shadow-[0_6px_0_rgba(0,0,0,.35)] transition ease-spring active:translate-y-1 active:scale-95 active:shadow-none disabled:opacity-60"
          >
            {preselect.length ? nameOf(preselect[0]) : "send to"}
            <Send size={26} strokeWidth={2.75} />
          </button>
        </div>
      )}
      {mode === "draw" && (
        <div className="absolute inset-x-0 bottom-0 flex justify-center pb-[max(env(safe-area-inset-bottom),24px)]">
          <button onClick={() => setMode("look")} className="rounded-full bg-white px-8 py-4 text-xl font-black text-black active:scale-95">
            done
          </button>
        </div>
      )}

      <Sheet open={picking} onClose={() => setPicking(false)}>
        <div className="px-6 pb-2">
          <h2 className="text-3xl font-black">send to</h2>
        </div>
        {targets.length === 0 ? (
          <div className="flex flex-col items-center gap-4 px-8 pb-12 pt-6 text-center">
            <p className="text-lg text-white/60">No friends yet. Share your code and you're set.</p>
            <button onClick={onAddFriends} className="rounded-full bg-accent px-8 py-4 text-xl font-black text-black active:scale-95">
              add friends
            </button>
          </div>
        ) : (
          <div className="grid max-h-[50vh] grid-cols-3 gap-y-6 overflow-y-auto px-4 pb-36 pt-3">
            {targets.map((f) => {
              const on = to.includes(f.key);
              return (
                <button key={f.key} onClick={() => toggle(f.key)} className="flex flex-col items-center gap-2 transition ease-spring active:scale-90">
                  <div className="relative">
                    <Avatar name={f.name} color={f.color} size={76} ring={on} group={f.group} />
                    {on && (
                      <span className="absolute -bottom-1 -right-1 grid h-8 w-8 place-items-center rounded-full bg-accent text-black">
                        <Check size={20} strokeWidth={4} />
                      </span>
                    )}
                  </div>
                  <span className={`max-w-full truncate text-sm font-bold ${on ? "text-white" : "text-white/60"}`}>{f.name}</span>
                </button>
              );
            })}
          </div>
        )}
        <div
          className={`absolute inset-x-0 bottom-0 flex items-center gap-3 bg-accent px-6 pb-[max(env(safe-area-inset-bottom),16px)] pt-4 text-black transition-transform duration-300 ease-spring ${
            to.length ? "translate-y-0" : "translate-y-full"
          }`}
        >
          <p className="flex-1 truncate text-xl font-black">{to.map(nameOf).join(", ")}</p>
          <button
            onClick={() => send()}
            disabled={sending}
            className="grid h-16 w-16 place-items-center rounded-full bg-black text-accent transition active:scale-90 disabled:opacity-50"
            aria-label="send"
          >
            <Send size={28} strokeWidth={2.75} />
          </button>
        </div>
      </Sheet>
    </div>
  );
}

function Round({ children, onClick, label, on, tint }: { children: React.ReactNode; onClick: () => void; label: string; on?: boolean; tint?: string }) {
  return (
    <button
      onClick={onClick}
      // keep focus in the text field so tapping T while typing flips the style
      onMouseDown={(e) => e.preventDefault()}
      aria-label={label}
      className={`relative z-10 grid h-14 w-14 place-items-center rounded-full backdrop-blur transition ease-spring active:scale-90 ${
        on ? "bg-white text-black" : "bg-black/35 text-white"
      }`}
      style={tint ? { background: tint, color: tint === "#000000" ? "#fff" : "#000" } : undefined}
    >
      {children}
    </button>
  );
}
