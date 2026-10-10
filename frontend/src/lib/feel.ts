/** Small tactile + visual helpers shared across screens. */

export const buzz = (ms: number | number[] = 8) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
};

export const ACCENTS = ["#C6FF3D", "#FFE14D", "#FF5C8A", "#FF8A3D", "#7C5CFF", "#3DD9FF", "#3DFFA8", "#FFFFFF"];

export function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

export function applyAccent(hex: string) {
  document.documentElement.style.setProperty("--accent", hexToRgb(hex));
}

/** Text colour that reads on top of a given background. */
export function onColor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 150 ? "#000" : "#fff";
}

export function ago(ts: number) {
  if (!ts) return "";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// stored under the pre-rename prefix so saved settings survive the rename to Kiks
export const pref = {
  get(key: string, fallback: string) {
    try {
      return localStorage.getItem(`kicksnap.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`kicksnap.${key}`, value);
    } catch {
      /* ignore */
    }
  },
};

export const TIMERS = [3, 5, 10, 0] as const;
export const timerLabel = (s: number) => (s === 0 ? "∞" : `${s}s`);

/**
 * Height of the app. A home-screen PWA on iOS can report a viewport shorter than the screen and leave
 * a black strip at the bottom; it always takes the whole screen there, so the screen's height wins.
 */
const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
export function viewH() {
  const h = window.innerHeight;
  if (!iosStandalone) return h;
  const portrait = window.innerWidth < h;
  return Math.max(h, portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height));
}

/** Keep --app-h (the height of html, body and the full-screen layers) in step with viewH. */
export function fitViewport() {
  const set = () => {
    const h = viewH();
    document.documentElement.style.setProperty("--app-h", `${h}px`);
    document.documentElement.style.overflow = h > window.innerHeight ? "hidden" : "";
  };
  set();
  window.addEventListener("resize", set);
  window.addEventListener("orientationchange", () => setTimeout(set, 300));
}

export type Rect = { x: number; y: number; w: number; h: number };

/** Where object-fit: contain puts media of size nw×nh inside a W×H box. */
export function containRect(nw: number, nh: number, W = window.innerWidth, H = viewH()): Rect {
  if (!nw || !nh) return { x: 0, y: 0, w: W, h: H };
  const s = Math.min(W / nw, H / nh);
  return { x: (W - nw * s) / 2, y: (H - nh * s) / 2, w: nw * s, h: nh * s };
}

/** Height of the bar under the picture (shutter on the camera, send in the editor), above the safe area. */
export const BOTTOM_BAR = 104;

let probe: HTMLDivElement | null = null;
/** The space under the bottom bar in px (--bar-gap in index.css, from the safe-area inset). */
export function barGap() {
  if (!probe) {
    probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding-bottom:var(--bar-gap)";
    document.body.appendChild(probe);
  }
  return parseFloat(getComputedStyle(probe).paddingBottom) || 0;
}

/**
 * Where the camera's viewfinder and the editor's media go: the whole screen above the bottom bar.
 * Camera photos are cropped to this shape, so the editor shows them in exactly the same spot.
 */
export function mediaArea(W = window.innerWidth, H = viewH()): Rect {
  return { x: 0, y: 0, w: W, h: Math.max(1, H - barGap() - BOTTOM_BAR) };
}

/** A colour on the "your colour" hue bar (0..1): bright and a little soft, so it works as an accent. */
export function hueColor(t: number) {
  const h = Math.min(1, Math.max(0, t)) * 6;
  const f = (n: number) => {
    const k = (n + h) % 6;
    const v = 1 - 0.75 * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(v * 255);
  };
  return "#" + [f(5), f(3), f(1)].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}
