import { onColor } from "../lib/feel";

export function Avatar({ name, color, size = 48, ring }: { name: string; color: string; size?: number; ring?: boolean }) {
  return (
    <div
      className={`grid shrink-0 place-items-center rounded-full font-black uppercase ${ring ? "ring-4 ring-accent ring-offset-2 ring-offset-black" : ""}`}
      style={{ width: size, height: size, background: color, color: onColor(color), fontSize: size * 0.42 }}
    >
      {name.slice(0, 1)}
    </div>
  );
}
