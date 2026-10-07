export type User = { username: string; color: string };
export type Friend = User;
export type SnapMeta = { id: string; kind: "photo" | "video"; seconds: number; caption: string; created_at: number };
export type ChatState = "new" | "received" | "delivered" | "opened" | "none";
export type Chat = User & { state: ChatState; at: number; snaps: SnapMeta[] };
export type FriendLists = { friends: Friend[]; incoming: Friend[]; outgoing: Friend[] };

const TOKEN_KEY = "kicksnap.token";

export const auth = {
  get token() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string | null) {
    try {
      token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private mode: session-only */
    }
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (auth.token) headers.set("Authorization", `Bearer ${auth.token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const detail = await res.json().then((j) => j.detail).catch(() => res.statusText);
    if (res.status === 401 && !path.startsWith("/api/auth")) {
      auth.set(null);
      location.reload();
    }
    throw new ApiError(res.status, typeof detail === "string" ? detail : "something broke");
  }
  return res.headers.get("content-type")?.includes("json") ? res.json() : (res.blob() as Promise<T>);
}

const json = (body: unknown) => JSON.stringify(body);

export const api = {
  check: (username: string) =>
    call<{ exists: boolean; valid: boolean }>("/api/auth/check", { method: "POST", body: json({ username }) }),
  enter: (username: string, pin: string) =>
    call<{ token: string; user: User; created: boolean }>("/api/auth/enter", {
      method: "POST",
      body: json({ username, pin }),
    }),
  logout: () => call("/api/auth/logout", { method: "POST" }),
  me: () => call<User>("/api/me"),
  setColor: (color: string) => call<User>("/api/me", { method: "PATCH", body: json({ color }) }),
  friends: () => call<FriendLists>("/api/friends"),
  addFriend: (username: string) =>
    call<{ username: string; status: "friends" | "requested" }>("/api/friends", {
      method: "POST",
      body: json({ username }),
    }),
  chats: () => call<Chat[]>("/api/chats"),
  send: (blob: Blob, to: string[], seconds: number, caption: string) => {
    const form = new FormData();
    form.append("file", blob, blob.type.startsWith("video") ? "snap.webm" : "snap.jpg");
    form.append("to", to.join(","));
    form.append("seconds", String(seconds));
    form.append("caption", caption);
    return call<{ sent_to: string[] }>("/api/snaps", { method: "POST", body: form });
  },
  media: (id: string) => call<Blob>(`/api/snaps/${id}/media`),
  open: (id: string) => call(`/api/snaps/${id}/open`, { method: "POST" }),
};

export type LiveEvent = { type: "snap"; from: string } | { type: "opened"; by: string } | { type: "friends" };

/** WebSocket with dumb exponential reconnect. Returns a disposer. */
export function live(onEvent: (e: LiveEvent) => void): () => void {
  let ws: WebSocket | null = null;
  let ping: number | undefined;
  let retry = 1000;
  let closed = false;

  const connect = () => {
    if (closed || !auth.token) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(auth.token)}`);
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
