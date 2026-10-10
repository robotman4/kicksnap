import { Check, Download, Pencil, Plus, Send, Sparkles, Timer, Type, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Media } from "../components/Media";
import { Sheet } from "../components/Sheet";
import { buzz, containRect, mediaArea, onColor, pref, Rect, timerLabel, TIMERS } from "../lib/feel";
import { applyLook, hasVignette, LookDefs, lookCss, LOOKS, luminance, SPECTRUM, spectrumAt, vignetteCss } from "../lib/looks";
import { useVisualViewport } from "../lib/viewport";
import { Capture } from "./Camera";

// Strokes and text are stored in 0..1 coordinates of the screen. The photo is shown
// whole (object-fit: contain), and on send they're mapped onto the full-resolution
// image through that same rect, so nothing is cropped or upscaled.
type Pt = [number, number];
type Stroke = { color: string; width: number; pts: Pt[] };
// Text styles, in the order tapping T cycles through them: the full-width bar, then the
// free ones (bold outline, colour pill, soft shadow) that move with a drag, and resize and rotate with two fingers.
type TextStyle = "bar" | "big" | "pill" | "soft";
const STYLES: TextStyle[] = ["bar", "big", "pill", "soft"];
// rotation: two-finger twist of the free styles, radians clockwise
type Label = { text: string; style: TextStyle; color: string; x: number; y: number; scale: number; rotation: number };
const free = (l: Label) => l.style !== "bar";

const INKS = ["#FFFFFF", "#000000", "#FF3D5A", "#FF8A3D", "#FFE14D", "#C6FF3D", "#3DD9FF", "#7C5CFF", "#FF5CD6"];
const BRUSH = 0.012; // of screen width
// font sizes as a fraction of screen height, shared by DOM preview and canvas output
const FONT = { bar: 0.028, big: 0.065, pill: 0.045, soft: 0.055 };
const WEIGHT = { bar: 600, big: 900, pill: 800, soft: 800 };
const SCALE = { min: 0.4, max: 4 };
// the pill's padding and corners, in em
const PILL = { x: 0.45, y: 0.2, r: 0.35, line: 1.2 };
const outlineFor = (c: string) => (luminance(c) < 0.08 ? "#fff" : "#000");
const fontSize = (l: Label, h: number) => FONT[l.style] * h * (free(l) ? l.scale : 1);

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
  const size = fontSize(l, h);
  const x = l.x * w;
  const y = l.y * h;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${WEIGHT[l.style]} ${size}px system-ui, -apple-system, sans-serif`;
  if (l.style === "bar") {
    const bh = size * 2;
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.fillRect(r.x, y - bh / 2, r.w, bh);
    ctx.fillStyle = "#fff";
    ctx.fillText(l.text, r.x + r.w / 2, y, r.w * 0.94);
    return;
  }
  // the free styles are one line, centred on their spot, as wide as the text
  const k = ctx.getTransform().a;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(l.rotation);
  if (l.style === "pill") {
    const bw = ctx.measureText(l.text).width + size * PILL.x * 2;
    const bh = size * (PILL.line + PILL.y * 2);
    ctx.fillStyle = l.color;
    ctx.beginPath();
    ctx.roundRect(-bw / 2, -bh / 2, bw, bh, size * PILL.r);
    ctx.fill();
    ctx.fillStyle = onColor(l.color);
  } else {
    ctx.fillStyle = l.color;
  }
  if (l.style === "big") {
    ctx.lineWidth = size * 0.14;
    ctx.lineJoin = "round";
    ctx.strokeStyle = outlineFor(l.color);
    ctx.strokeText(l.text, 0, 0);
  }
  if (l.style === "soft") {
    // shadows ignore the canvas transform, so scale and turn them by hand
    ctx.shadowColor = "rgba(0,0,0,.6)";
    ctx.shadowOffsetX = -Math.sin(l.rotation) * size * 0.06 * k;
    ctx.shadowOffsetY = Math.cos(l.rotation) * size * 0.06 * k;
    ctx.shadowBlur = size * 0.18 * k;
  }
  ctx.fillText(l.text, 0, 0);
  ctx.restore();
}

const MAX_SIDE = 4096;

/**
 * Bake drawing + text into what gets sent, at the media's own resolution.
 * Photos come out as one JPEG; videos keep their file and get a PNG layer the same size.
 */
async function compose(capture: Capture, dims: { w: number; h: number }, r: Rect, strokes: Stroke[], label: Label | null, look: string) {
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
    applyLook(ctx, W, H, look);
  }
  // screen px -> image px, through the rect the media is shown in
  const sw = window.innerWidth;
  const sh = window.innerHeight;
  const k = W / r.w;
  ctx.setTransform(k, 0, 0, k, -r.x * k, -r.y * k);
  drawStrokes(ctx, strokes, sw, sh);
  if (label) drawLabel(ctx, label, sw, sh, r);

  const out = (type: string, q?: number) => new Promise<Blob>((ok) => c.toBlob((b) => ok(b!), type, q));
  return capture.kind === "photo"
    ? { file: await out("image/jpeg", 0.92), overlay: null }
    : { file: capture.blob, overlay: await out("image/png") };
}


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
  const [mode, setMode] = useState<"look" | "draw" | "text" | "filter">("look");
  const [ink, setInk] = useState(INKS[5]);
  const [look, setLook] = useState("original");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [label, setLabel] = useState<Label | null>(null);
  const [picking, setPicking] = useState(false);
  const [to, setTo] = useState<string[]>(preselect);
  const [sending, setSending] = useState(false);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  // the media fills the space above the send bar, like the camera's viewfinder
  const area = mediaArea();
  const rect = containRect(dims.w, dims.h, area.w, area.h);
  const vv = useVisualViewport();
  const typing = mode === "text";
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<Stroke | null>(null);
  const textInput = useRef<HTMLInputElement>(null);
  const dragText = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  // two fingers anywhere resize the free text
  const fingers = useRef(new Map<number, Pt>());
  const pinch = useRef<{ dist: number; angle: number; scale: number; rotation: number } | null>(null);
  const pinchedAt = useRef(0);

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
      // another tap on T moves on to the next style, like Snapchat
      setLabel({ ...label, style: STYLES[(STYLES.indexOf(label.style) + 1) % STYLES.length] });
      return;
    }
    // start text in the lower part of the photo itself, not on the blurred fill
    const y = (rect.y + rect.h * 0.75) / window.innerHeight;
    setLabel((l) => l ?? { text: "", style: "bar", color: ink, x: 0.5, y, scale: 1, rotation: 0 });
    setMode("text");
  };

  const pickInk = (c: string) => {
    setInk(c);
    if (mode === "text") setLabel((l) => l && { ...l, color: c });
  };

  const pinchDown = (e: React.PointerEvent) => {
    if (e.isPrimary) fingers.current.clear();
    fingers.current.set(e.pointerId, rel(e));
    if (fingers.current.size === 2 && mode === "look" && label && free(label)) {
      const [a, b] = [...fingers.current.values()];
      const dx = (b[0] - a[0]) * window.innerWidth;
      const dy = (b[1] - a[1]) * window.innerHeight;
      pinch.current = { dist: Math.hypot(dx, dy), angle: Math.atan2(dy, dx), scale: label.scale, rotation: label.rotation };
      dragText.current = null;
    }
  };
  const pinchMove = (e: React.PointerEvent) => {
    if (!fingers.current.has(e.pointerId)) return;
    fingers.current.set(e.pointerId, rel(e));
    const p = pinch.current;
    if (!p || fingers.current.size !== 2 || !p.dist) return;
    const [a, b] = [...fingers.current.values()];
    const dx = (b[0] - a[0]) * window.innerWidth;
    const dy = (b[1] - a[1]) * window.innerHeight;
    pinchedAt.current = Date.now();
    setLabel(
      (l) =>
        l && {
          ...l,
          scale: Math.min(SCALE.max, Math.max(SCALE.min, (p.scale * Math.hypot(dx, dy)) / p.dist)),
          rotation: p.rotation + Math.atan2(dy, dx) - p.angle,
        }
    );
  };
  const pinchUp = (e: React.PointerEvent) => {
    fingers.current.delete(e.pointerId);
    if (fingers.current.size < 2) pinch.current = null;
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
    onSend(() => compose(capture, dims, rect, strokes, label, look), recipients, seconds);
  };

  const save = async () => {
    const { file, overlay } = await compose(capture, dims, rect, strokes, label, look);
    for (const [blob, ext] of [[file, capture.kind === "video" ? "webm" : "jpg"], [overlay, "png"]] as const) {
      if (!blob) continue;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `kiks-${Date.now()}.${ext}`;
      a.click();
    }
    buzz(8);
  };

  // While typing, the text sits just above the keyboard (Snapchat-style) and drops
  // back to its spot when done. The photo itself never moves.
  const labelStyle = (l: Label): React.CSSProperties => {
    const h = window.innerHeight;
    // keep a big pinch from overflowing the screen while typing
    const size = typing && free(l) ? Math.min(fontSize(l, h), FONT[l.style] * h * 1.2) : fontSize(l, h);
    const spot: React.CSSProperties = typing
      ? { top: vv.height - 24, transform: free(l) ? "translate(-50%,-100%)" : "translateY(-100%)", ...(free(l) ? { left: "50%" } : {}) }
      : {};
    const base: React.CSSProperties = { fontSize: size, fontWeight: WEIGHT[l.style], top: `${l.y * 100}%` };
    if (l.style === "bar") return { ...base, left: rect.x, width: rect.w, transform: "translateY(-50%)", ...spot };
    const at: React.CSSProperties = { ...base, left: `${l.x * 100}%`, transform: `translate(-50%,-50%) rotate(${l.rotation}rad)`, color: l.color };
    const look: React.CSSProperties =
      l.style === "big"
        ? { WebkitTextStroke: `${size * 0.14}px ${outlineFor(l.color)}`, paintOrder: "stroke fill" }
        : l.style === "pill"
          ? { background: l.color, color: onColor(l.color), padding: `${PILL.y}em ${PILL.x}em`, borderRadius: `${PILL.r}em`, lineHeight: PILL.line }
          : { textShadow: "0 .06em .18em rgba(0,0,0,.6)" };
    return { ...at, ...look, ...spot };
  };

  return (
    <div
      className="fixed inset-0 z-30 animate-[pop_.25s_ease-out] touch-none bg-black text-white"
      data-nodrag
      onPointerDown={pinchDown}
      onPointerMove={pinchMove}
      onPointerUp={pinchUp}
      onPointerCancel={pinchUp}
      // iOS pans the page up to show the focused field; undo that so the photo stays put
      style={typing && vv.top ? { transform: `translateY(${vv.top}px)` } : undefined}
    >
      <LookDefs />
      <Media src={capture.url} kind={capture.kind} loop onDims={setDims} filter={lookCss(look)} frame={rect} overlay={hasVignette(look) ? vignetteCss : undefined} />

      <canvas
        ref={canvas}
        className={`absolute inset-0 h-full w-full ${mode === "draw" ? "" : "pointer-events-none"}`}
        onPointerDown={drawDown}
        onPointerMove={drawMove}
        onPointerUp={drawUp}
        onPointerCancel={drawUp}
      />

      {/* tap the picture to start typing */}
      {mode === "look" && <button className="absolute inset-0" onClick={() => Date.now() - pinchedAt.current > 400 && tapText()} aria-label="add text" />}
      {mode === "filter" && <button className="absolute inset-0" onClick={() => setMode("look")} aria-label="close filters" />}

      {label && (
        <div
          className={`absolute whitespace-nowrap text-center ${label.style === "bar" ? "bg-black/55 py-[1.4vh] backdrop-blur-sm" : ""}`}
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
            setLabel({ ...label, x: x - dragText.current.dx, y: Math.min(0.95, Math.max(0.05, y - dragText.current.dy)) });
          }}
          onPointerUp={() => {
            const tapped = dragText.current && !dragText.current.moved;
            dragText.current = null;
            if (tapped) setMode("text");
          }}
        >
          {mode === "text" ? (
            // an invisible copy of the text sizes the box (the free styles hug it), the field sits on it;
            // one shape for every style, so flipping styles keeps the keyboard up
            <span className={`relative inline-block ${free(label) ? "" : "w-[90vw]"}`}>
              <span className="invisible whitespace-pre">{label.text || " "}</span>
              <input
                ref={textInput}
                value={label.text}
                maxLength={80}
                onChange={(e) => setLabel({ ...label, text: e.target.value })}
                onBlur={finishText}
                onKeyDown={(e) => e.key === "Enter" && finishText()}
                className="absolute inset-0 w-full bg-transparent p-0 text-center outline-none"
                style={{ color: "inherit", font: "inherit" }}
              />
            </span>
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
        {mode !== "text" && (
          <Round onClick={() => (buzz(6), setMode(mode === "draw" ? "look" : "draw"))} label="draw" on={mode === "draw"} tint={mode === "draw" ? ink : undefined}>
            <Pencil size={26} strokeWidth={2.75} />
          </Round>
        )}
        {(mode === "draw" || (mode === "text" && label && free(label))) && <Palette color={ink} onPick={pickInk} />}
        {mode === "look" && capture.kind === "photo" && (
          <Round onClick={() => (buzz(6), setMode("filter"))} label="filters" tint={look !== "original" ? "#FFFFFF" : undefined}>
            <Sparkles size={26} strokeWidth={2.5} />
          </Round>
        )}
        {mode === "look" && capture.kind === "photo" && (
          <Round onClick={cycleTimer} label="view timer">
            <div className="flex flex-col items-center leading-none">
              <Timer size={22} strokeWidth={2.75} />
              <span className="mt-0.5 text-xs font-black">{timerLabel(seconds)}</span>
            </div>
          </Round>
        )}
        {mode === "look" && (
          <Round onClick={save} label="save">
            <Download size={26} strokeWidth={2.75} />
          </Round>
        )}
      </div>

      {mode === "look" && (
        // the send bar: full width, in the bar under the photo
        <div className="absolute inset-x-0 bottom-0 px-4" style={{ paddingBottom: "calc(var(--bar-gap) + 12px)" }}>
          <button
            onClick={() => (preselect.length ? send(preselect) : setPicking(true))}
            disabled={sending}
            className="flex h-[60px] w-full items-center gap-3 rounded-full bg-accent pl-6 pr-5 text-black shadow-[0_4px_0_rgba(0,0,0,.35)] transition ease-spring active:translate-y-1 active:scale-[.97] active:shadow-none disabled:opacity-60"
          >
            <span className="flex-1 truncate text-left text-[22px] font-black">{preselect.length ? `send to ${nameOf(preselect[0])}` : "send to…"}</span>
            {capture.kind === "photo" && (
              <span className="flex items-center gap-1 text-[15px] font-extrabold opacity-60">
                <Timer size={18} strokeWidth={2.75} />
                {timerLabel(seconds)}
              </span>
            )}
            <Send size={26} strokeWidth={2.75} />
          </button>
        </div>
      )}
      {mode === "filter" && (
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-4 pb-[max(env(safe-area-inset-bottom),24px)]">
          <div className="flex w-full gap-2.5 overflow-x-auto px-4">
            {LOOKS.map((f) => (
              <button key={f.name} onClick={() => (buzz(4), setLook(f.name))} className="flex shrink-0 flex-col items-center gap-1 transition ease-spring active:scale-95">
                <span className={`block h-[76px] w-[68px] rounded-[18px] p-[3px] transition ${look === f.name ? "bg-white" : ""}`}>
                  <span className="relative block h-full w-full overflow-hidden rounded-[15px]">
                    <img src={capture.url} alt="" className="h-full w-full object-cover" style={{ filter: lookCss(f.name) }} />
                    {f.vignette && <span className="absolute inset-0" style={{ background: vignetteCss }} />}
                  </span>
                </span>
                <span className={`text-[13px] font-extrabold ${look === f.name ? "text-white" : "text-white/70"}`}>{f.name}</span>
              </button>
            ))}
          </div>
          <button onClick={() => setMode("look")} className="rounded-full bg-white px-8 py-4 text-xl font-black text-black active:scale-95">
            done
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

/** The ink swatches, under a rainbow "+" one that swaps them for a bar to pick any colour from. */
function Palette({ color, onPick }: { color: string; onPick: (c: string) => void }) {
  const [custom, setCustom] = useState(false);
  const [at, setAt] = useState(0.5);
  const [sliding, setSliding] = useState(false);
  const mine = !INKS.includes(color);
  const BAR = 300;
  const slide = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = Math.min(1, Math.max(0, (e.clientY - e.currentTarget.getBoundingClientRect().top) / BAR));
    setAt(t);
    onPick(spectrumAt(t));
  };
  return (
    <div className="mt-1 flex flex-col items-center gap-1.5 rounded-full bg-black/30 p-1.5 backdrop-blur" onMouseDown={(e) => e.preventDefault()}>
      {/* first, so it's easy to find: the rainbow "+" opens the colour bar */}
      <button
        onClick={() => (buzz(4), setCustom(!custom))}
        aria-label="custom colour"
        className={`grid h-[30px] w-[30px] place-items-center rounded-full border-[3px] transition ease-spring ${mine || custom ? "border-white" : "border-white/30"} ${mine && !custom ? "scale-125" : ""}`}
        style={{ background: mine && !custom ? color : "conic-gradient(#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)" }}
      >
        {custom ? <X size={14} strokeWidth={4} /> : !mine && <Plus size={18} strokeWidth={4} className="text-white drop-shadow" />}
      </button>
      {!custom &&
        INKS.map((c) => (
          <button
            key={c}
            onClick={() => (buzz(4), onPick(c))}
            aria-label={`ink ${c}`}
            className={`h-[30px] w-[30px] rounded-full border-[3px] transition ease-spring ${c === color ? "scale-125 border-white" : "border-white/30"}`}
            style={{ background: c }}
          />
        ))}
      {custom && (
        <div
          className="relative flex w-[30px] touch-none justify-center"
          style={{ height: BAR }}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            setSliding(true);
            slide(e);
          }}
          onPointerMove={(e) => sliding && slide(e)}
          onPointerUp={() => setSliding(false)}
          onPointerCancel={() => setSliding(false)}
        >
          <div className="h-full w-[22px] rounded-full border-2 border-white/55" style={{ background: `linear-gradient(${SPECTRUM.join(",")})` }} />
          <div className="absolute h-[30px] w-[30px] rounded-full border-[3px] border-white" style={{ top: at * BAR - 15, background: color }} />
          {sliding && <div className="absolute right-11 h-[52px] w-[52px] rounded-full border-[3px] border-white" style={{ top: at * BAR - 26, background: color }} />}
        </div>
      )}
    </div>
  );
}
