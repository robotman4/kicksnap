import { Delete } from "lucide-react";
import { buzz } from "../lib/feel";

export function PinPad({ value, onChange, shake }: { value: string; onChange: (v: string) => void; shake?: boolean }) {
  const press = (k: string) => {
    buzz(5);
    if (k === "del") onChange(value.slice(0, -1));
    else if (value.length < 6) onChange(value + k);
  };
  return (
    <div className="flex flex-col items-center gap-10">
      <div className={`flex gap-3 ${shake ? "animate-[shake_.4s]" : ""}`}>
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className={`h-4 w-4 rounded-full transition-all duration-200 ease-spring ${
              i < value.length ? "scale-110 bg-accent" : "bg-white/20"
            }`}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-x-8 gap-y-4">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"].map((k) =>
          k ? (
            <button
              key={k}
              onClick={() => press(k)}
              className="grid h-[72px] w-[72px] place-items-center rounded-full text-3xl font-bold text-white transition active:scale-90 active:bg-white/15"
              aria-label={k === "del" ? "delete" : k}
            >
              {k === "del" ? <Delete size={28} /> : k}
            </button>
          ) : (
            <span key="blank" />
          )
        )}
      </div>
    </div>
  );
}
