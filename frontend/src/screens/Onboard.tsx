import { ArrowRight, ChevronLeft, Fingerprint, Sparkles, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { TermsLink } from "../components/Terms";
import { api, User } from "../lib/api";
import { buzz } from "../lib/feel";
import { passkeysSupported, signInWithPasskey } from "../lib/passkey";

/** First thing a new device sees. Two giant buttons, no passwords anywhere. */
export function Welcome({ onIn }: { onIn: (u: User) => void }) {
  const [step, setStep] = useState<"hi" | "back">("hi");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const fresh = async () => {
    buzz(10);
    setBusy(true);
    try {
      onIn(await api.startFresh());
    } catch {
      setError("can't reach the server");
      setBusy(false);
    }
  };

  const passkey = async () => {
    buzz(10);
    setError("");
    try {
      onIn(await signInWithPasskey());
    } catch (e) {
      if ((e as Error).name !== "NotAllowedError") setError((e as Error).message);
    }
  };

  if (step === "back") return <Back onBack={() => setStep("hi")} onIn={onIn} onPasskey={passkey} error={error} />;

  return (
    <Screen>
      <TermsLink className="absolute right-4 top-[max(env(safe-area-inset-top),14px)]" />
      <div className="mt-[12vh] flex flex-col items-start">
        <Logo />
        <h1 className="mt-8 text-[64px] font-black leading-[0.9] tracking-tight">
          snap it.
          <br />
          <span className="text-accent">send it.</span>
          <br />
          gone.
        </h1>
      </div>
      <div className="mt-auto flex flex-col gap-3">
        {error && <p className="text-center font-bold text-[#FF5C8A]">{error}</p>}
        <BigButton onClick={fresh} disabled={busy} icon={<Sparkles size={30} strokeWidth={2.5} />}>
          I'm new
        </BigButton>
        <BigButton onClick={() => setStep("back")} ghost icon={<ArrowRight size={30} strokeWidth={2.5} />}>
          I've got an account
        </BigButton>
      </div>
    </Screen>
  );
}

/** Returning user on a new device: passkey, or approve this device from your phone. */
function Back({ onBack, onIn, onPasskey, error }: { onBack: () => void; onIn: (u: User) => void; onPasskey: () => void; error: string }) {
  const [link, setLink] = useState<{ code: string; secret: string } | null>(null);
  const [qr, setQr] = useState("");
  const timer = useRef<number>();
  const done = useRef(onIn);
  done.current = onIn;

  // Ask for a link code, show it as QR, poll until another device approves it.
  useEffect(() => {
    let alive = true;
    const begin = async () => {
      const l = await api.linkStart();
      if (!alive) return;
      setLink(l);
      setQr(await QRCode.toDataURL(`kicksnap-link:${l.code}`, { margin: 1, width: 480, color: { dark: "#000", light: "#0000" } }));
      const poll = async () => {
        try {
          const r = await api.linkPoll(l.code, l.secret);
          if (r.approved && r.user) {
            buzz([10, 50, 20]);
            return done.current(r.user);
          }
          if (alive) timer.current = window.setTimeout(poll, 2000);
        } catch {
          if (alive) begin(); // expired, get a fresh code
        }
      };
      poll();
    };
    begin().catch(() => {});
    return () => {
      alive = false;
      clearTimeout(timer.current);
    };
  }, []);

  return (
    <Screen>
      <button className="-ml-2 grid h-14 w-14 place-items-center rounded-full active:bg-white/10" onClick={onBack} aria-label="back">
        <ChevronLeft size={34} />
      </button>
      <h1 className="mt-4 text-5xl font-black leading-[0.95] tracking-tight">welcome back</h1>

      <div className="mt-8 flex items-center gap-5 rounded-[2rem] bg-accent p-5 text-black">
        <div className="h-32 w-32 shrink-0">{qr && <img src={qr} alt="link code" className="h-full w-full" />}</div>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-black opacity-60">
            <Smartphone size={16} /> on your phone
          </p>
          <p className="mt-1 text-lg font-black leading-tight">open kicksnap, tap your face, scan this</p>
          <p className="mt-2 font-mono text-2xl font-black tracking-[0.2em]">{link?.code ?? "······"}</p>
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-3">
        {error && <p className="text-center font-bold text-[#FF5C8A]">{error}</p>}
        {passkeysSupported() && (
          <BigButton onClick={onPasskey} icon={<Fingerprint size={30} strokeWidth={2.5} />}>
            use my passkey
          </BigButton>
        )}
      </div>
    </Screen>
  );
}

/** Right after "I'm new": the only thing we ask for. */
export function PickName({ onDone }: { onDone: (u: User) => void }) {
  const [name, setName] = useState("");
  const [state, setState] = useState<"idle" | "free" | "taken" | "invalid">("idle");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    if (name.length < 3) return setState("idle");
    const t = setTimeout(() => {
      api.nameFree(name).then((r) => setState(!r.valid ? "invalid" : r.free ? "free" : "taken"));
    }, 250);
    return () => clearTimeout(t);
  }, [name]);

  const go = async () => {
    try {
      buzz([10, 50, 20]);
      onDone(await api.pickName(name));
    } catch {
      setState("taken");
    }
  };

  const hint = { idle: "letters, numbers, _ and .", free: "that's yours 🙌", taken: "taken, try another", invalid: "3-20 letters, numbers, _ or ." }[state];

  return (
    <Screen>
      <div className="mt-[8vh]">
        <Logo />
        <h1 className="mt-8 text-5xl font-black leading-[0.95] tracking-tight">
          what do friends
          <br />
          call you?
        </h1>
        <p className={`mt-3 text-lg font-bold ${state === "free" ? "text-accent" : state === "idle" ? "text-white/40" : "text-[#FF5C8A]"}`}>{hint}</p>
      </div>
      <form
        className="mt-auto flex items-center gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          state === "free" && go();
        }}
      >
        <label className="flex min-w-0 flex-1 items-center rounded-full bg-white/10 px-6 py-5 text-3xl font-black focus-within:bg-white/15">
          <span className="text-white/40">@</span>
          <input
            ref={input}
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, ""))}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={20}
            className="w-full min-w-0 bg-transparent outline-none placeholder:text-white/25"
            placeholder="yourname"
          />
        </label>
        <button
          disabled={state !== "free"}
          className="grid h-20 w-20 shrink-0 place-items-center rounded-full bg-accent text-black transition active:scale-90 disabled:opacity-25"
          aria-label="done"
        >
          <ArrowRight size={36} strokeWidth={3} />
        </button>
      </form>
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex h-full flex-col bg-black px-6 pb-[max(env(safe-area-inset-bottom),24px)] pt-[max(env(safe-area-inset-top),20px)] text-white">
      {children}
    </div>
  );
}

function Logo() {
  return (
    <div className="grid h-20 w-20 rotate-[-8deg] place-items-center rounded-[1.6rem] bg-accent shadow-[0_8px_0_rgba(255,255,255,.15)]">
      <div className="grid h-11 w-11 place-items-center rounded-full border-[6px] border-black">
        <div className="h-3.5 w-3.5 rounded-full bg-black" />
      </div>
    </div>
  );
}

export function BigButton({
  children,
  onClick,
  icon,
  ghost,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  icon?: React.ReactNode;
  ghost?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center justify-between rounded-full py-6 pl-8 pr-6 text-2xl font-black transition duration-150 ease-spring active:scale-[.96] disabled:opacity-50 ${
        ghost ? "bg-white/10 text-white" : "bg-accent text-black shadow-[0_6px_0_rgba(255,255,255,.18)] active:translate-y-1 active:shadow-none"
      }`}
    >
      {children}
      {icon}
    </button>
  );
}
