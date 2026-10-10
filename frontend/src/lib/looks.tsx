/**
 * Photo filters and the custom colour bar, shared by the editor's preview and its output.
 * Same numbers as `looks` / `spectrum` in app/lib/screens/compose.dart.
 */

/** 5x4 colour matrices, row-major, offsets in 0..255. */
export const LOOKS: { name: string; m: number[] | null; vignette?: boolean }[] = [
  { name: "original", m: null },
  { name: "vivid", m: [1.4627, -0.3476, -0.0351, 0, -10.24, -0.1033, 1.2184, -0.0351, 0, -10.24, -0.1033, -0.3476, 1.5309, 0, -10.24, 0, 0, 0, 1, 0] },
  { name: "warm", m: [1.1435, -0.0758, -0.0077, 0, 12, -0.0213, 1.0285, -0.0072, 0, 4, -0.0183, -0.0615, 0.9398, 0, 0, 0, 0, 0, 1, 0] },
  { name: "cool", m: [0.9354, -0.0322, -0.0032, 0, 0, -0.0106, 1.0142, -0.0036, 0, 4, -0.0115, -0.0386, 1.1301, 0, 16, 0, 0, 0, 1, 0] },
  { name: "mono", m: [0.2126, 0.7152, 0.0722, 0, 0, 0.2126, 0.7152, 0.0722, 0, 0, 0.2126, 0.7152, 0.0722, 0, 0, 0, 0, 0, 1, 0] },
  { name: "noir", m: [0.3083, 1.037, 0.1047, 0, -67.6, 0.3083, 1.037, 0.1047, 0, -67.6, 0.3083, 1.037, 0.1047, 0, -67.6, 0, 0, 0, 1, 0] },
  { name: "fade", m: [0.5558, 0.3083, 0.0567, 0, 37.04, 0.1175, 0.7095, 0.0513, 0, 37.04, 0.0965, 0.2373, 0.4681, 0, 37.04, 0, 0, 0, 1, 0] },
  { name: "vignette", m: null, vignette: true },
];

/** Darker edges: clear in the middle, a circle out to the corners. Same stops as paintVignette in compose.dart. */
const VIGNETTE: [number, number][] = [[0.45, 0], [0.7, 0.18], [1, 0.65]];
export const vignetteCss = `radial-gradient(circle farthest-corner, ${VIGNETTE.map(([s, a]) => `rgba(0,0,0,${a}) ${s * 100}%`).join(", ")})`;
export const hasVignette = (name: string) => !!LOOKS.find((l) => l.name === name)?.vignette;

/** SVG filter defs for the live preview (feColorMatrix wants offsets in 0..1, and sRGB like the canvas). */
export function LookDefs() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <defs>
        {LOOKS.filter((l) => l.m).map((l) => (
          <filter key={l.name} id={`look-${l.name}`} colorInterpolationFilters="sRGB">
            <feColorMatrix type="matrix" values={l.m!.map((v, i) => (i % 5 === 4 ? v / 255 : v)).join(" ")} />
          </filter>
        ))}
      </defs>
    </svg>
  );
}

export const lookCss = (name: string) => (name === "original" ? undefined : `url(#look-${name})`);

/** Bake a look into pixels (the canvas output; ctx.filter isn't in Safari). */
export function applyLook(ctx: CanvasRenderingContext2D, w: number, h: number, name: string) {
  if (hasVignette(name)) {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
    for (const [s, a] of VIGNETTE) g.addColorStop(s, `rgba(0,0,0,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  const m = LOOKS.find((l) => l.name === name)?.m;
  if (!m) return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    d[i] = m[0] * r + m[1] * g + m[2] * b + m[4];
    d[i + 1] = m[5] * r + m[6] * g + m[7] * b + m[9];
    d[i + 2] = m[10] * r + m[11] * g + m[12] * b + m[14];
  }
  ctx.putImageData(img, 0, 0);
}

/** The custom colour bar, top to bottom. */
export const SPECTRUM = ["#FFFFFF", "#FF0000", "#FF8000", "#FFFF00", "#00FF00", "#00FFFF", "#0000FF", "#8000FF", "#FF00FF", "#000000"];

/** The colour at 0..1 down the bar, as #RRGGBB. */
export function spectrumAt(t: number) {
  const p = Math.min(1, Math.max(0, t)) * (SPECTRUM.length - 1);
  const i = Math.min(SPECTRUM.length - 2, Math.floor(p));
  const f = p - i;
  const a = parseInt(SPECTRUM[i].slice(1), 16);
  const b = parseInt(SPECTRUM[i + 1].slice(1), 16);
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f);
  return "#" + ((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0").toUpperCase();
}

/** Relative luminance 0..1, for picking an outline that shows. */
export function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** The camera's viewfinder and photos are cropped to this (portrait width / height). */
export const VIEW_ASPECT = 3 / 5;

/** The centre part of a w x h frame with the viewfinder's shape (portrait or landscape, following the frame). */
export function cropRect(w: number, h: number, aspect = VIEW_ASPECT) {
  const a = w > h ? 1 / aspect : aspect;
  const cw = w / h > a ? h * a : w;
  const ch = cw / a;
  return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
}
