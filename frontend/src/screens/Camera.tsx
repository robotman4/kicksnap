import { Images, MessageCircle, RefreshCcw, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "../components/Avatar";
import { User } from "../lib/api";
import { buzz, pref } from "../lib/feel";

export type Capture = { blob: Blob; kind: "photo" | "video"; url: string; mirrored: boolean };

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
  me: User;
  active: boolean;
  unread: number;
  onCapture: (c: Capture) => void;
  onChats: () => void;
  onFriends: () => void;
  onSettings: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
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

  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  const start = useCallback(async () => {
    stop();
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1080 }, height: { ideal: 1920 } },
        audio: false,
      });
      stream.current = s;
      if (video.current) video.current.srcObject = s;
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

  const photo = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d")!;
    if (mirrored) {
      ctx.translate(c.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(v, 0, 0);
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
    buzz(12);
    c.toBlob((blob) => blob && onCapture({ blob, kind: "photo", url: URL.createObjectURL(blob), mirrored: false }), "image/jpeg", 0.9);
  };

  const startRecording = async () => {
    if (!stream.current) return;
    const tracks = [...stream.current.getVideoTracks()];
    // Mic is only requested the first time someone actually records.
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    mic?.getAudioTracks().forEach((t) => tracks.push(t));
    const mime = pickMime();
    const rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      mic?.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
      if (blob.size) onCapture({ blob, kind: "video", url: URL.createObjectURL(blob), mirrored });
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

  const shutterDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = undefined;
      startRecording();
    }, HOLD_MS);
  };

  const shutterUp = () => {
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
    onCapture({ blob: f, kind: f.type.startsWith("video") ? "video" : "photo", url: URL.createObjectURL(f), mirrored: false });
  };

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-black"
      onClick={(e) => {
        // double tap anywhere on the viewfinder flips the camera
        if (e.target !== e.currentTarget && e.target !== video.current) return;
        const t = Date.now();
        if (t - lastTap.current < 300) flip();
        lastTap.current = t;
      }}
    >
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 h-full w-full object-cover"
        style={{ transform: mirrored ? "scaleX(-1)" : undefined }}
      />

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
          <Avatar name={me.username} color={me.color} size={42} />
        </button>
        <div className="flex flex-col gap-3">
          <IconButton label="flip camera" onClick={flip}>
            <RefreshCcw size={24} />
          </IconButton>
          <label className="grid h-11 w-11 cursor-pointer place-items-center rounded-full bg-black/30 text-white backdrop-blur active:scale-90" aria-label="gallery">
            <Images size={24} />
            <input type="file" accept="image/*,video/*" className="hidden" onChange={pickFile} />
          </label>
        </div>
      </div>

      {/* bottom bar */}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/40 to-transparent px-8 pb-[max(env(safe-area-inset-bottom),20px)] pt-16">
        <IconButton label="chats" onClick={onChats} big>
          <MessageCircle size={28} />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 grid h-6 min-w-6 place-items-center rounded-full bg-accent px-1.5 text-xs font-black text-black">
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
          className={`relative grid h-[88px] w-[88px] touch-none select-none place-items-center rounded-full transition-transform duration-300 ease-spring ${
            recording ? "scale-125" : "active:scale-90"
          }`}
        >
          <svg className="absolute inset-0 -rotate-90" viewBox="0 0 88 88">
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
          <Users size={28} />
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
        big ? "h-14 w-14" : "h-11 w-11"
      }`}
    >
      {children}
    </button>
  );
}
