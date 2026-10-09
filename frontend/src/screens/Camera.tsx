import { Images, MessageCircle, RefreshCcw, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Friend } from "../lib/api";
import { buzz, containRect, pref } from "../lib/feel";

export type Capture = { blob: Blob; kind: "photo" | "video"; url: string };

// Ask for a big 4:3 stream: 4:3 is the sensor's native shape, so this is the full
// field of view. Browsers pick the closest mode the camera really has.
// resizeMode "none" asks for a native mode rather than a cropped/scaled one.
const STREAM = { width: { ideal: 3264 }, height: { ideal: 2448 }, aspectRatio: { ideal: 4 / 3 }, resizeMode: { ideal: "none" } } as MediaTrackConstraints;
const VIDEO_BPS = 6_000_000; // keeps a 10s clip around 7-8 MB

// Focus/zoom constraints aren't in the DOM typings yet.
type CamCaps = MediaTrackCapabilities & { focusMode?: string[]; pointsOfInterest?: unknown };
type ImageCaptureT = { takePhoto(o?: { imageWidth?: number; imageHeight?: number }): Promise<Blob>; getPhotoCapabilities(): Promise<{ imageWidth?: { max: number }; imageHeight?: { max: number } }> };
declare global {
  // eslint-disable-next-line no-var
  var ImageCapture: { new (track: MediaStreamTrack): ImageCaptureT } | undefined;
}

async function setFocus(track: MediaStreamTrack, mode: "continuous" | "single-shot", point?: { x: number; y: number }) {
  const caps = (track.getCapabilities?.() ?? {}) as CamCaps;
  if (!caps.focusMode?.includes(mode)) return false;
  const c: Record<string, unknown> = { focusMode: mode };
  if (point && caps.pointsOfInterest !== undefined) c.pointsOfInterest = [point];
  await track.applyConstraints({ advanced: [c as MediaTrackConstraintSet] }).catch(() => {});
  return true;
}

/** Re-encode a blob mirrored, for selfies taken through ImageCapture. */
async function mirror(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d")!;
  ctx.translate(c.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(bmp, 0, 0);
  return new Promise((ok) => c.toBlob((b) => ok(b ?? blob), "image/jpeg", 0.92));
}

// Every iPhone browser is WebKit; Chrome on iOS says CriOS, not Chrome/.
const IS_WEBKIT = /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Android/.test(navigator.userAgent);

const MAX_VIDEO_MS = 10_000;
const HOLD_MS = 220;

function pickMime() {
  const options = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return options.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";
}

export function Camera({
  me,
  active,
  unread,
  onCapture,
  onChats,
  onFriends,
  onSettings,
}: {
  me: Friend;
  active: boolean;
  unread: number;
  onCapture: (c: Capture) => void;
  onChats: () => void;
  onFriends: () => void;
  onSettings: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const backdrop = useRef<HTMLVideoElement>(null);
  const [focusAt, setFocusAt] = useState<{ x: number; y: number; n: number } | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const holdTimer = useRef<number>();
  const stopTimer = useRef<number>();
  const lastTap = useRef(0);
  const [facing, setFacing] = useState<"user" | "environment">(() => pref.get("facing", "environment") as never);
  const [denied, setDenied] = useState(false);
  const [recording, setRecording] = useState(false);
  const [flash, setFlash] = useState(false);
  const mirrored = facing === "user";

  const gen = useRef(0);
  const stop = () => {
    gen.current++;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  const start = useCallback(async () => {
    stop();
    const mine = gen.current;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, ...STREAM }, audio: false });
      // stopped or restarted while iOS was asking for the camera: drop this one
      if (mine !== gen.current) return s.getTracks().forEach((t) => t.stop());
      stream.current = s;
      if (video.current) video.current.srcObject = s;
      if (backdrop.current) backdrop.current.srcObject = s;
      const track = s.getVideoTracks()[0];
      setFocus(track, "continuous");
      // iOS ends the track when something else grabs the camera; come back instead of staying black
      track.addEventListener("ended", () => stream.current === s && start());
      setDenied(false);
    } catch {
      setDenied(true);
    }
  }, [facing]);

  // Camera runs while the camera panel is showing and the app is visible.
  useEffect(() => {
    if (!active) return stop();
    start();
    const vis = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", vis);
    return () => {
      document.removeEventListener("visibilitychange", vis);
      stop();
    };
  }, [active, start]);

  const flip = () => {
    buzz(6);
    const next = facing === "user" ? "environment" : "user";
    pref.set("facing", next);
    setFacing(next);
  };

  /** Last resort: copy the current preview frame at full stream resolution. */
  const grabFrame = (v: HTMLVideoElement) =>
    new Promise<Blob | null>((ok) => {
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext("2d")!;
      if (mirrored) {
        ctx.translate(c.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(v, 0, 0);
      c.toBlob(ok, "image/jpeg", 0.92);
    });

  const photo = async () => {
    const v = video.current;
    const track = stream.current?.getVideoTracks()[0];
    if (!v || !v.videoWidth || !track) return;
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
    buzz(12);
    let blob: Blob | null = null;
    // A real still from the sensor (full resolution, autofocused) on Chrome/Android.
    // Not on iPhone: WebKit's takePhoto reconfigures the camera mid-stream, which
    // blanks the preview, can hang, and can leave the track dead. The frame there
    // is already full stream resolution.
    if (globalThis.ImageCapture && !IS_WEBKIT) {
      try {
        const ic = new globalThis.ImageCapture(track);
        const shot = (async () => {
          const caps = await ic.getPhotoCapabilities().catch(() => null);
          const max = caps?.imageWidth ? { imageWidth: caps.imageWidth.max } : undefined;
          // some devices reject an explicit size; the default is still a full still
          return ic.takePhoto(max).catch(() => ic.takePhoto());
        })();
        blob = await Promise.race([shot, new Promise<null>((ok) => setTimeout(() => ok(null), 3000))]);
        if (blob && mirrored) blob = await mirror(blob);
      } catch {
        blob = null;
      }
    }
    if (!blob && v.videoWidth) blob = await grabFrame(v);
    if (blob) onCapture({ blob, kind: "photo", url: URL.createObjectURL(blob) });
  };

  const tapFocus = (e: React.MouseEvent) => {
    const track = stream.current?.getVideoTracks()[0];
    const v = video.current;
    if (!track || !v) return;
    // tap point -> 0..1 in the frame (which is letterboxed with object-contain)
    const r = containRect(v.videoWidth, v.videoHeight, v.clientWidth, v.clientHeight);
    let x = (e.clientX - r.x) / r.w;
    const y = (e.clientY - r.y) / r.h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    if (mirrored) x = 1 - x;
    setFocusAt({ x: e.clientX, y: e.clientY, n: Date.now() });
    setFocus(track, "single-shot", { x, y }).then((ok) => ok && setTimeout(() => setFocus(track, "continuous"), 2500));
  };

  // finger is on the shutter (set on down, cleared on up/cancel)
  const holding = useRef(false);

  const startRecording = async () => {
    if (!stream.current) return;
    const tracks = [...stream.current.getVideoTracks()];
    // Mic is only requested the first time someone actually records.
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    // let go (or left the camera) while the mic was being set up: don't start
    if (!holding.current || !stream.current) return mic?.getTracks().forEach((t) => t.stop());
    mic?.getAudioTracks().forEach((t) => tracks.push(t));
    const mime = pickMime();
    const rec = new MediaRecorder(new MediaStream(tracks), { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: VIDEO_BPS });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      mic?.getTracks().forEach((t) => t.stop());
      // the recorder can also stop on its own (iOS ends it when the camera track ends),
      // so the button always resets here, not only when the finger lifts
      if (recorder.current === rec) recorder.current = null;
      clearTimeout(stopTimer.current);
      setRecording(false);
      const blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
      if (blob.size) onCapture({ blob, kind: "video", url: URL.createObjectURL(blob) });
    };
    rec.start();
    recorder.current = rec;
    setRecording(true);
    buzz(15);
    stopTimer.current = window.setTimeout(endRecording, MAX_VIDEO_MS);
  };

  const endRecording = () => {
    clearTimeout(stopTimer.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
    recorder.current = null;
    setRecording(false);
  };

  // Leaving the camera (preview, chats, app in background) drops any half-made recording state.
  useEffect(() => {
    if (active) return;
    holding.current = false;
    clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
    endRecording();
  }, [active]);

  const shutterDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    holding.current = true;
    clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = undefined;
      startRecording();
    }, HOLD_MS);
  };

  const shutterUp = () => {
    if (!holding.current) return;
    holding.current = false;
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = undefined;
      photo();
    } else {
      endRecording();
    }
  };

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    onCapture({ blob: f, kind: f.type.startsWith("video") ? "video" : "photo", url: URL.createObjectURL(f) });
  };

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-black"
      onClick={(e) => {
        // tap to focus, double tap anywhere on the viewfinder flips the camera
        if (e.target !== e.currentTarget && e.target !== video.current && e.target !== backdrop.current) return;
        const t = Date.now();
        if (t - lastTap.current < 300) flip();
        else tapFocus(e);
        lastTap.current = t;
      }}
    >
      {/* the whole frame, uncropped, on a blurred copy of itself */}
      <video
        ref={backdrop}
        autoPlay
        playsInline
        muted
        aria-hidden
        className="absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-2xl"
        style={{ transform: mirrored ? "scaleX(-1.1) scaleY(1.1)" : undefined }}
      />
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 h-full w-full object-contain"
        style={{ transform: mirrored ? "scaleX(-1)" : undefined }}
      />

      {focusAt && (
        <div
          key={focusAt.n}
          className="pointer-events-none absolute h-20 w-20 -translate-x-1/2 -translate-y-1/2 animate-[focus_.9s_ease-out_forwards] rounded-full border-4 border-accent"
          style={{ left: focusAt.x, top: focusAt.y }}
        />
      )}

      {denied && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-gradient-to-b from-zinc-900 to-black px-10 text-center text-white">
          <div className="text-6xl">📷</div>
          <p className="text-2xl font-black leading-tight">camera's off</p>
          <p className="text-white/50">Allow camera access in your browser, or pick something from your gallery.</p>
          <button onClick={start} className="rounded-full bg-accent px-7 py-3.5 text-lg font-bold text-black active:scale-95">
            try again
          </button>
        </div>
      )}

      <div className={`pointer-events-none absolute inset-0 bg-white transition-opacity duration-100 ${flash ? "opacity-80" : "opacity-0"}`} />

      {/* top bar */}
      <div className="absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/40 to-transparent px-4 pb-10 pt-[max(env(safe-area-inset-top),14px)]">
        <button onClick={onSettings} className="transition active:scale-90" aria-label="you">
          <Avatar name={me.username} color={me.color} size={52} />
        </button>
        <div className="flex flex-col gap-3">
          <IconButton label="flip camera" onClick={flip}>
            <RefreshCcw size={26} strokeWidth={2.5} />
          </IconButton>
          <label className="grid h-14 w-14 cursor-pointer place-items-center rounded-full bg-black/30 text-white backdrop-blur active:scale-90" aria-label="gallery">
            <Images size={26} strokeWidth={2.5} />
            <input type="file" accept="image/*,video/*" className="hidden" onChange={pickFile} />
          </label>
        </div>
      </div>

      {/* bottom bar */}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/40 to-transparent px-8 pb-[max(env(safe-area-inset-bottom),20px)] pt-16">
        <IconButton label="chats" onClick={onChats} big>
          <MessageCircle size={32} strokeWidth={2.5} />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 grid h-7 min-w-7 animate-bounce place-items-center rounded-full bg-accent px-1.5 text-xs font-black text-black">
              {unread}
            </span>
          )}
        </IconButton>

        <button
          data-nodrag
          aria-label="tap for photo, hold for video"
          onPointerDown={shutterDown}
          onPointerUp={shutterUp}
          onPointerCancel={shutterUp}
          onContextMenu={(e) => e.preventDefault()}
          className={`relative grid h-[100px] w-[100px] touch-none select-none place-items-center rounded-full transition-transform duration-300 ease-spring ${
            recording ? "scale-125" : "active:scale-90"
          }`}
        >
          <svg className="absolute inset-0 -rotate-90" viewBox="0 0 88 88">
            <circle cx="44" cy="44" r="34" className="fill-white/15" />
            <circle cx="44" cy="44" r="40" fill="none" stroke="white" strokeWidth="6" />
            {recording && (
              <circle
                cx="44"
                cy="44"
                r="40"
                fill="none"
                strokeWidth="6"
                strokeLinecap="round"
                className="stroke-accent"
                strokeDasharray="251.3"
                style={{ animation: `ring ${MAX_VIDEO_MS}ms linear forwards` }}
              />
            )}
          </svg>
          <span className={`rounded-full transition-all duration-300 ${recording ? "h-8 w-8 bg-[#FF3D5A]" : "h-0 w-0"}`} />
        </button>

        <IconButton label="friends" onClick={onFriends} big>
          <Users size={32} strokeWidth={2.5} />
        </IconButton>
      </div>
    </div>
  );
}

function IconButton({ children, label, onClick, big }: { children: React.ReactNode; label: string; onClick: () => void; big?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`relative grid place-items-center rounded-full bg-black/30 text-white backdrop-blur transition active:scale-90 ${
        big ? "h-16 w-16" : "h-14 w-14"
      }`}
    >
      {children}
    </button>
  );
}
