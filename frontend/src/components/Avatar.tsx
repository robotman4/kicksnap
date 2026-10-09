import { Users } from "lucide-react";
import { onColor } from "../lib/feel";

export function Avatar({ name, color, size = 48, ring, group }: { name: string; color: string; size?: number; ring?: boolean; group?: boolean }) {
  return (
    <div
      className={`grid shrink-0 place-items-center rounded-full font-black uppercase ${ring ? "ring-4 ring-accent ring-offset-2 ring-offset-black" : ""}`}
      style={{ width: size, height: size, background: color, color: onColor(color), fontSize: size * 0.42 }}
    >
      {group ? <Users size={size * 0.48} strokeWidth={2.75} /> : name.slice(0, 1)}
    </div>
  );
}
