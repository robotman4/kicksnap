import { Check, Download, Pencil, Send, Timer, Type, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Sheet } from "../components/Sheet";
import { Friend } from "../lib/api";
import { buzz, pref, timerLabel, TIMERS } from "../lib/feel";
import { Capture } from "./Camera";

// Everything is stored in 0..1 coordinates of the screen so the preview and the
// sent image line up exactly, whatever the output resolution.
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

function drawLabel(ctx: CanvasRenderingContext2D, l: Label, w: number, h: number) {
  if (!l.text.trim()) return;
  const size = FONT[l.style] * h;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (l.style === "bar") {
    ctx.font = `600 ${size}px system-ui, -apple-system, sans-serif`;
    const bh = size * 2;
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.fillRect(0, l.y * h - bh / 2, w, bh);
    ctx.fillStyle = "#fff";
    ctx.fillText(l.text, w / 2, l.y * h, w * 0.94);
  } else {
    ctx.font = `900 ${size}px system-ui, -apple-system, sans-serif`;
    ctx.lineWidth = size * 0.14;
    ctx.strokeStyle = l.color === "#000000" ? "#fff" : "#000";
    ctx.strokeText(l.text, l.x * w, l.y * h, w * 0.94);
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, l.x * w, l.y * h, w * 0.94);
  }
}

/** Bake media + drawing + text into what actually gets sent. */
async function compose(capture: Capture, strokes: Stroke[], label: Label | null) {
  const h = Math.min(1920, Math.round(window.innerHeight * 2));
  const w = Math.round((h * window.innerWidth) / window.innerHeight);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const decorated = strokes.length > 0 || !!label?.text.trim();

  if (capture.kind === "photo") {
    const img = new Image();
    img.src = capture.url;
    await img.decode();
    // same crop as object-fit: cover
    const scale = Math.max(w / img.width, h / img.height);
    ctx.drawImage(img, (w - img.width * scale) / 2, (h - img.height * scale) / 2, img.width * scale, img.height * scale);
  } else if (!decorated) {
    return { file: capture.blob, overlay: null };
  }
  drawStrokes(ctx, strokes, w, h);
  if (label) drawLabel(ctx, label, w, h);

  const out = (type: string) => new Promise<Blob>((ok) => c.toBlob((b) => ok(b!), type, 0.9));
  return capture.kind === "photo" ? { file: await out("image/jpeg"), overlay: null } : { file: capture.blob, overlay: await out("image/png") };
}

/** After the shutter: doodle, add text, pick people, send. */
export function Preview({
  capture,
  friends,
  preselect,
  onClose,
  onSend,
  onAddFriends,
}: {
  capture: Capture;
  friends: Friend[];
  preselect: string[];
  onClose: () => void;
  onSend: (file: Blob, overlay: Blob | null, to: string[], seconds: number) => Promise<void>;
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
    setLabel((l) => l ?? { text: "", style: "bar", color: ink, x: 0.5, y: 0.62 });
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

  const toggle = (name: string) => {
    buzz(5);
    setTo((t) => (t.includes(name) ? t.filter((n) => n !== name) : [...t, name]));
  };

  const send = async (recipients = to) => {
    if (!recipients.length || sending) return;
    setSending(true);
    try {
      const { file, overlay } = await compose(capture, strokes, label);
      await onSend(file, overlay, recipients, seconds);
    } finally {
      setSending(false);
    }
  };

  const save = async () => {
    const { file, overlay } = await compose(capture, strokes, label);
    for (const [blob, ext] of [[file, capture.kind === "video" ? "webm" : "jpg"], [overlay, "png"]] as const) {
      if (!blob) continue;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `kicksnap-${Date.now()}.${ext}`;
      a.click();
    }
    buzz(8);
  };

  const labelStyle = (l: Label): React.CSSProperties =>
    l.style === "bar"
      ? { top: `${l.y * 100}%`, left: 0, right: 0, fontSize: `${FONT.bar * 100}vh`, transform: "translateY(-50%)" }
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
    <div className="fixed inset-0 z-30 animate-[pop_.25s_ease-out] touch-none bg-black text-white" data-nodrag>
      {capture.kind === "photo" ? (
        <img src={capture.url} className="absolute inset-0 h-full w-full object-cover" alt="" />
      ) : (
        <video
          src={capture.url}
          autoPlay
          loop
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
          style={{ transform: capture.mirrored ? "scaleX(-1)" : undefined }}
        />
      )}

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
            {preselect.length ? `@${preselect[0]}` : "send to"}
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
        {friends.length === 0 ? (
          <div className="flex flex-col items-center gap-4 px-8 pb-12 pt-6 text-center">
            <p className="text-lg text-white/60">No friends yet. Share your code and you're set.</p>
            <button onClick={onAddFriends} className="rounded-full bg-accent px-8 py-4 text-xl font-black text-black active:scale-95">
              add friends
            </button>
          </div>
        ) : (
          <div className="grid max-h-[50vh] grid-cols-3 gap-y-6 overflow-y-auto px-4 pb-36 pt-3">
            {friends.map((f) => {
              const on = to.includes(f.username);
              return (
                <button key={f.username} onClick={() => toggle(f.username)} className="flex flex-col items-center gap-2 transition ease-spring active:scale-90">
                  <div className="relative">
                    <Avatar name={f.username} color={f.color} size={76} ring={on} />
                    {on && (
                      <span className="absolute -bottom-1 -right-1 grid h-8 w-8 place-items-center rounded-full bg-accent text-black">
                        <Check size={20} strokeWidth={4} />
                      </span>
                    )}
                  </div>
                  <span className={`max-w-full truncate text-sm font-bold ${on ? "text-white" : "text-white/60"}`}>{f.username}</span>
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
          <p className="flex-1 truncate text-xl font-black">{to.join(", ")}</p>
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
