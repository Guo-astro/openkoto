// Thin fetch wrapper for the same-origin API. The website authenticates with the
// Better Auth session cookie, so no tokens are handled here.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  headers.set("X-OpenKoto-Protocol", "1");
  headers.set("X-OpenKoto-Client", "web/0.1.0");
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (body ?? {}) as { error?: { code?: string; message?: string }; code?: string; message?: string };
    throw new HttpError(res.status, err.error?.code ?? err.code ?? `HTTP_${res.status}`, err.error?.message ?? err.message ?? res.statusText);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export type Plan = "free" | "plus" | "pro";

export interface AccountSummary {
  user: { id: string; email: string; name: string; image: string | null; createdAt: string };
  plan: Plan;
  entitlements: { sync: boolean; cli: boolean; apiKeys: boolean; hostedAi: boolean };
  subscriptions: { plan: Plan; channel: string; periodEnd: string; autoRenew: boolean }[];
  credits: number;
  pendingDeletion: string | null;
}

export interface Device {
  id: string;
  platform: string;
  name: string;
  appVersion: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export type SocialProvider = "google" | "apple" | "github";

export const authApi = {
  sendOtp: (email: string) => post<{ success: boolean }>("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" }),
  verifyOtp: (email: string, otp: string) => post<{ user: { id: string } }>("/api/auth/sign-in/email-otp", { email, otp }),
  social: (provider: SocialProvider, callbackURL: string) =>
    post<{ url?: string; redirect: boolean }>("/api/auth/sign-in/social", { provider, callbackURL, errorCallbackURL: "/login?error=oauth" }),
  signOut: () => post<{ success: boolean }>("/api/auth/sign-out"),
  providers: () => request<{ providers: SocialProvider[] }>("/api/v1/auth/providers"),
};

export const accountApi = {
  me: () => request<AccountSummary>("/api/v1/me"),
  devices: () => request<{ devices: Device[] }>("/api/v1/devices"),
  revokeDevice: (id: string) => request<{ ok: true }>(`/api/v1/devices/${id}`, { method: "DELETE" }),
  keys: () => request<{ keys: ApiKey[]; availableScopes: string[] }>("/api/v1/keys"),
  createKey: (name: string, scopes: string[], expiresInDays?: number) =>
    post<ApiKey & { key: string }>("/api/v1/keys", { name, scopes, expiresInDays }),
  revokeKey: (id: string) => request<{ ok: true }>(`/api/v1/keys/${id}`, { method: "DELETE" }),
  requestDeletion: () => post<{ ok: true; executeAfter: string }>("/api/v1/account/delete"),
  cancelDeletion: () => post<{ ok: true }>("/api/v1/account/delete/cancel"),
  lookupDevice: (userCode: string) =>
    request<{ userCode: string; device: { platform: string; name: string; appVersion?: string } }>(
      `/api/v1/auth/device/lookup?userCode=${encodeURIComponent(userCode)}`,
    ),
  approveDevice: (userCode: string, approve: boolean) => post<{ ok: true }>("/api/v1/auth/device/approve", { userCode, approve }),
  redeem: (code: string) => post<{ ok: true; plan: Plan | null; credits: number; periodEnd: string | null }>("/api/v1/billing/redeem", { code }),
};
