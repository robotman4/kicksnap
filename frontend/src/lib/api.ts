export type User = { username: string | null; color: string };
export type Friend = { username: string; color: string };
export type SnapMeta = { id: string; kind: "photo" | "video"; seconds: number; has_overlay: number; created_at: number };
export type ChatState = "new" | "received" | "delivered" | "opened" | "none";
export type Chat = Friend & { state: ChatState; at: number; snaps: SnapMeta[] };
export type FriendLists = { friends: Friend[]; incoming: Friend[]; outgoing: Friend[] };
export type Device = { id: number; label: string; created_at: number; seen_at: number; this: boolean };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Auth is an httpOnly device cookie, so there's no token handling here at all.
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!res.ok) {
    const detail = await res.json().then((j) => j.detail).catch(() => res.statusText);
    throw new ApiError(res.status, typeof detail === "string" ? detail : "something broke");
  }
  return res.headers.get("content-type")?.includes("json") ? res.json() : (res.blob() as Promise<T>);
}

const json = (body: unknown) => JSON.stringify(body);
const post = <T>(path: string, body?: unknown) => call<T>(path, { method: "POST", body: body === undefined ? undefined : json(body) });

export const api = {
  me: () => call<User>("/api/me"),
  startFresh: () => post<User>("/api/devices/new"),
  nameFree: (name: string) => call<{ free: boolean; valid: boolean }>(`/api/names/${encodeURIComponent(name)}`),
  pickName: (username: string) => post<User>("/api/me/name", { username }),
  logout: () => post("/api/auth/logout"),
  setColor: (color: string) => call<User>("/api/me", { method: "PATCH", body: json({ color }) }),

  linkStart: () => post<{ code: string; secret: string; expires_in: number }>("/api/link/start"),
  linkPoll: (code: string, secret: string) =>
    call<{ approved: boolean; user?: User }>(`/api/link/${code}?secret=${encodeURIComponent(secret)}`),
  linkApprove: (code: string) => post(`/api/link/${encodeURIComponent(code)}/approve`),
  devices: () => call<{ devices: Device[]; passkeys: number }>("/api/devices"),
  removeDevice: (id: number) => call(`/api/devices/${id}`, { method: "DELETE" }),

  passkeyRegisterBegin: () => post<{ challenge_id: string; options: string }>("/api/passkeys/register/begin"),
  passkeyRegisterFinish: (challenge_id: string, credential: unknown) =>
    post("/api/passkeys/register/finish", { challenge_id, credential }),
  passkeyLoginBegin: () => post<{ challenge_id: string; options: string }>("/api/passkeys/login/begin"),
  passkeyLoginFinish: (challenge_id: string, credential: unknown) =>
    post<User>("/api/passkeys/login/finish", { challenge_id, credential }),

  friends: () => call<FriendLists>("/api/friends"),
  addFriend: (username: string) => post<{ username: string; status: "friends" | "requested" }>("/api/friends", { username }),
  chats: () => call<Chat[]>("/api/chats"),
  send: (blob: Blob, overlay: Blob | null, to: string[], seconds: number) => {
    const form = new FormData();
    form.append("file", blob, blob.type.startsWith("video") ? "snap.webm" : "snap.jpg");
    if (overlay) form.append("overlay", overlay, "overlay.png");
    form.append("to", to.join(","));
    form.append("seconds", String(seconds));
    return call<{ sent_to: string[] }>("/api/snaps", { method: "POST", body: form });
  },
  media: (id: string) => call<Blob>(`/api/snaps/${id}/media`),
  overlay: (id: string) => call<Blob>(`/api/snaps/${id}/overlay`),
  open: (id: string) => post(`/api/snaps/${id}/open`),
};

export type LiveEvent = { type: "snap"; from: string } | { type: "opened"; by: string } | { type: "friends" };

/** WebSocket with dumb exponential reconnect. The cookie authenticates it. */
export function live(onEvent: (e: LiveEvent) => void): () => void {
  let ws: WebSocket | null = null;
  let ping: number | undefined;
  let retry = 1000;
  let closed = false;

  const connect = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 1000;
      ping = window.setInterval(() => ws?.send("ping"), 25000);
    };
    ws.onmessage = (m) => onEvent(JSON.parse(m.data));
    ws.onclose = () => {
      clearInterval(ping);
      if (!closed) setTimeout(connect, (retry = Math.min(retry * 2, 30000)));
    };
  };
  connect();
  return () => {
    closed = true;
    clearInterval(ping);
    ws?.close();
  };
}
