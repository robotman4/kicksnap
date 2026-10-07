import { ArrowRight, ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PinPad } from "../components/PinPad";
import { api, auth, User } from "../lib/api";
import { buzz } from "../lib/feel";

type Step = "name" | "pin" | "confirm";

/** One input at a time. Name, then PIN. Existing name = sign in, new name = sign up. */
export function Onboard({ onIn }: { onIn: (u: User, created: boolean) => void }) {
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [exists, setExists] = useState(false);
  const [pin, setPin] = useState("");
  const [first, setFirst] = useState("");
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const fail = (msg: string) => {
    buzz([30, 40, 30]);
    setError(msg);
    setShake(true);
    setTimeout(() => setShake(false), 400);
    setPin("");
  };

  const goName = async () => {
    const res = await api.check(name).catch(() => null);
    if (!res) return setError("can't reach the server");
    if (!res.valid) return setError("3-20 letters, numbers, _ or .");
    setError("");
    setExists(res.exists);
    setStep("pin");
  };

  useEffect(() => {
    if (pin.length !== 6) return;
    if (!exists && step === "pin") {
      setFirst(pin);
      setPin("");
      setStep("confirm");
      return;
    }
    if (step === "confirm" && pin !== first) return fail("didn't match, try again");
    api
      .enter(name, pin)
      .then((r) => {
        buzz(15);
        auth.set(r.token);
        onIn(r.user, r.created);
      })
      .catch((e) => fail(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  const title =
    step === "name" ? "what do friends\ncall you?" : step === "confirm" ? "once more" : exists ? `hey @${name}` : "pick a PIN";
  const sub =
    step === "name" ? "" : step === "confirm" ? "so you don't lock yourself out" : exists ? "your PIN" : "6 digits, that's it";

  return (
    <div className="flex h-full flex-col bg-black px-6 pb-[max(env(safe-area-inset-bottom),24px)] pt-[max(env(safe-area-inset-top),24px)] text-white">
      <div className="h-12">
        {step !== "name" && (
          <button
            className="-ml-2 grid h-12 w-12 place-items-center rounded-full active:bg-white/10"
            onClick={() => {
              setStep("name");
              setPin("");
              setError("");
            }}
            aria-label="back"
          >
            <ChevronLeft size={30} />
          </button>
        )}
      </div>

      <div className="mt-6">
        <div className="mb-6 h-14 w-14 rounded-2xl bg-accent" />
        <h1 className="whitespace-pre-line text-5xl font-black leading-[0.95] tracking-tight">{title}</h1>
        <p className="mt-3 h-6 text-lg text-white/50">{error ? <span className="text-[#FF5C8A]">{error}</span> : sub}</p>
      </div>

      {step === "name" ? (
        <form
          className="mt-auto flex items-center gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            name && goName();
          }}
        >
          <label className="flex flex-1 items-center rounded-full bg-white/10 px-6 py-5 text-2xl font-bold focus-within:bg-white/15">
            <span className="text-white/40">@</span>
            <input
              ref={input}
              value={name}
              onChange={(e) => {
                setName(e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, ""));
                setError("");
              }}
              autoCapitalize="none"
              autoComplete="username"
              autoCorrect="off"
              spellCheck={false}
              maxLength={20}
              className="w-full bg-transparent outline-none placeholder:text-white/25"
              placeholder="yourname"
            />
          </label>
          <button
            disabled={name.length < 3}
            className="grid h-[72px] w-[72px] shrink-0 place-items-center rounded-full bg-accent text-black transition active:scale-90 disabled:opacity-30"
            aria-label="next"
          >
            <ArrowRight size={32} strokeWidth={3} />
          </button>
        </form>
      ) : (
        <div className="mt-auto">
          <PinPad value={pin} onChange={setPin} shake={shake} />
        </div>
      )}
    </div>
  );
}
