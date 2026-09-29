// HTTP client for the OpenKoto API (auth-spec.md, sync-protocol-spec.md §5).
// Runtime-agnostic: needs only `fetch` and WebCrypto (browsers, Node ≥ 20, workers, React Native w/ polyfills).

import {
  PROTOCOL_VERSION,
  type Plan,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type RecordType,
  type SyncStats,
} from "@openkoto/core";

// MARK: - types

export interface TokenUser {
  id: string;
  email: string;
  name?: string;
  plan?: Plan;
}

export interface Tokens {
  accessToken: string;
  /** Absent for API keys (`ok_live_…`), which never refresh. */
  refreshToken?: string | null;
  /** Epoch ms after which the access token is considered expired (client-side estimate). */
  expiresAt?: number | null;
  deviceId?: string | null;
  user?: TokenUser | null;
}

export interface TokenStore {
  get(): Promise<Tokens | null>;
  set(tokens: Tokens | null): Promise<void>;
}

/** Raw `/api/v1/auth/token` response. */
export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  deviceId: string;
  user: TokenUser;
}

export interface DeviceInfo {
  platform: string;
  name: string;
  appVersion?: string;
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

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface CreatedApiKey {
  id: string;
  /** Full secret; shown once. */
  key: string;
  prefix: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
}

export interface AccountSummary {
  user: { id: string; email: string; name: string; image: string | null; createdAt: string };
  plan: Plan;
  /** cliDailyLimit: CLI/MCP calls per UTC day on the free plan; null = unlimited. */
  entitlements: { sync: boolean; cli: boolean; cliDailyLimit?: number | null; apiKeys: boolean; hostedAi: boolean };
  subscriptions: unknown[];
  credits: number;
  pendingDeletion: string | null;
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}

export interface PullOptions {
  limit?: number;
  types?: RecordType[];
}

/** The part of the API the sync engine needs; `OpenKotoClient.sync` implements it. */
export interface SyncTransport {
  pull(cursor: string | null, opts?: PullOptions): Promise<PullResponse>;
  push(req: PushRequest): Promise<PushResponse>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds, from `Retry-After` (429). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Same values as the DOM `RequestCredentials` (declared here so the client also type-checks without DOM libs). */
export type FetchCredentials = "include" | "omit" | "same-origin";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OpenKotoClientOptions {
  /** e.g. "https://openkoto.com" (no trailing slash needed). */
  baseUrl: string;
  /** `X-OpenKoto-Client`, "<platform>/<version>", e.g. "ios/1.5.0". */
  clientName: string;
  /** Bearer mode token storage. Not used in cookie mode. */
  tokenStore?: TokenStore;
  fetch?: FetchLike;
  /** "include" = web cookie session: no bearer header, cookies sent. */
  credentials?: FetchCredentials;
  /** Called once when refresh fails and the stored tokens were cleared (user must sign in again). */
  onSessionExpired?: () => void;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  /** Attach auth and refresh on 401 (default true). */
  auth?: boolean;
}

/** Refresh this long before the estimated expiry. */
const EXPIRY_SKEW_MS = 30_000;
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("aborted", "AbortError");
}

// MARK: - PKCE (RFC 7636)

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomUrlSafe(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** S256 pair; the verifier is 43 chars (32 random bytes). */
export async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = randomUrlSafe(32);
  return { codeVerifier, codeChallenge: await pkceChallenge(codeVerifier) };
}

export function tokensFromResponse(res: TokenResponse, now: number = Date.now()): Tokens {
  return {
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    expiresAt: now + res.expiresIn * 1000,
    deviceId: res.deviceId,
    user: res.user,
  };
}

// MARK: - client

export class OpenKotoClient {
  readonly baseUrl: string;
  private readonly clientName: string;
  private readonly tokenStore?: TokenStore;
  private readonly fetchImpl: FetchLike;
  private readonly credentials?: FetchCredentials;
  private readonly onSessionExpired?: () => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private refreshing: Promise<Tokens> | null = null;

  constructor(opts: OpenKotoClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.clientName = opts.clientName;
    this.tokenStore = opts.tokenStore;
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.credentials = opts.credentials;
    this.onSessionExpired = opts.onSessionExpired;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private get cookieMode(): boolean {
    return this.credentials === "include";
  }

  // ---- low level ----------------------------------------------------------

  url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async send(method: string, path: string, opts: RequestOptions, accessToken: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-OpenKoto-Protocol": String(PROTOCOL_VERSION),
      "X-OpenKoto-Client": this.clientName,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    // `credentials` is absent from some runtimes' RequestInit typings (Cloudflare Workers).
    if (this.credentials) (init as RequestInit & { credentials?: FetchCredentials }).credentials = this.credentials;
    return this.fetchImpl(this.url(path, opts.query), init);
  }

  private static async toError(res: Response): Promise<ApiError> {
    let code = `HTTP_${res.status}`;
    let message = res.statusText || code;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
    } catch {
      // non-JSON error body
    }
    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfter = retryAfterHeader !== null && retryAfterHeader !== "" ? Number(retryAfterHeader) : undefined;
    return new ApiError(res.status, code, message, Number.isFinite(retryAfter) ? retryAfter : undefined);
  }

  private static async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Authenticated JSON request with one transparent refresh-and-retry on 401. */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const useBearer = opts.auth !== false && !this.cookieMode && !!this.tokenStore;
    let tokens = useBearer ? await this.tokenStore!.get() : null;

    if (useBearer && tokens && this.isExpired(tokens)) {
      tokens = await this.refreshOrNull(tokens);
    }

    let res = await this.send(method, path, opts, tokens?.accessToken ?? null);
    if (res.status === 401 && useBearer && tokens?.refreshToken) {
      const err = await OpenKotoClient.toError(res);
      if (err.code !== "TOKEN_EXPIRED" && err.code !== "UNAUTHENTICATED") throw err;
      const fresh = await this.refreshAfterFailure(tokens);
      if (!fresh) throw err;
      res = await this.send(method, path, opts, fresh.accessToken);
    }
    if (!res.ok) throw await OpenKotoClient.toError(res);
    return OpenKotoClient.parse<T>(res);
  }

  private isExpired(tokens: Tokens): boolean {
    return !!tokens.refreshToken && typeof tokens.expiresAt === "number" && this.now() >= tokens.expiresAt - EXPIRY_SKEW_MS;
  }

  private async refreshOrNull(tokens: Tokens): Promise<Tokens | null> {
    try {
      return await this.refreshWith(tokens);
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return null;
      throw err;
    }
  }

  /**
   * After a 401: another request may already have rotated the token — reuse that instead of
   * refreshing again (a second refresh with the rotated token would trip reuse detection).
   */
  private async refreshAfterFailure(used: Tokens): Promise<Tokens | null> {
    if (this.refreshing) return this.refreshing.catch(() => null);
    const current = await this.tokenStore!.get();
    if (!current?.refreshToken) return null;
    if (current.accessToken !== used.accessToken) return current;
    return this.refreshOrNull(current);
  }

  /** Force a refresh-token rotation (single-flight). */
  async refresh(): Promise<Tokens> {
    const tokens = await this.tokenStore?.get();
    if (!tokens?.refreshToken) throw new ApiError(401, "UNAUTHENTICATED", "no refresh token");
    return this.refreshWith(tokens);
  }

  private refreshWith(tokens: Tokens): Promise<Tokens> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const res = await this.send("POST", "/api/v1/auth/token", { body: { grant_type: "refresh_token", refresh_token: tokens.refreshToken } }, null);
          if (!res.ok) {
            const err = await OpenKotoClient.toError(res);
            if (err.status < 500) {
              await this.tokenStore?.set(null);
              this.onSessionExpired?.();
            }
            throw err;
          }
          const next = tokensFromResponse(await OpenKotoClient.parse<TokenResponse>(res), this.now());
          await this.tokenStore?.set(next);
          return next;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  // ---- account ------------------------------------------------------------

  me(): Promise<AccountSummary> {
    return this.request("GET", "/api/v1/me");
  }

  async devices(): Promise<Device[]> {
    return (await this.request<{ devices: Device[] }>("GET", "/api/v1/devices")).devices;
  }

  async revokeDevice(id: string): Promise<void> {
    await this.request("DELETE", `/api/v1/devices/${encodeURIComponent(id)}`);
  }

  readonly apiKeys = {
    list: () => this.request<{ keys: ApiKeyInfo[]; availableScopes: string[] }>("GET", "/api/v1/keys"),
    create: (input: { name?: string; scopes?: string[]; expiresInDays?: number }) =>
      this.request<CreatedApiKey>("POST", "/api/v1/keys", { body: input }),
    revoke: async (id: string) => {
      await this.request("DELETE", `/api/v1/keys/${encodeURIComponent(id)}`);
    },
  };

  /** Revokes this device server-side (bearer mode) or ends the cookie session, then clears local tokens. */
  async logout(): Promise<void> {
    try {
      if (this.cookieMode) {
        await this.request("POST", "/api/auth/sign-out", { body: {}, auth: false });
      } else {
        const tokens = await this.tokenStore?.get();
        if (tokens?.refreshToken) {
          await this.request("POST", "/api/v1/auth/logout", { body: { refreshToken: tokens.refreshToken }, auth: false });
        }
      }
    } finally {
      await this.tokenStore?.set(null);
    }
  }

  // ---- sync ---------------------------------------------------------------

  readonly sync: SyncTransport & { stats(): Promise<SyncStats> } = {
    pull: (cursor, opts = {}) =>
      this.request<PullResponse>("GET", "/api/v1/sync/pull", {
        query: { cursor, limit: opts.limit, types: opts.types?.length ? opts.types.join(",") : undefined },
      }),
    push: (req) => this.request<PushResponse>("POST", "/api/v1/sync/push", { body: req }),
    stats: () => this.request<SyncStats>("GET", "/api/v1/sync/stats"),
  };

  // ---- auth flows ---------------------------------------------------------

  private async tokenGrant(body: Record<string, unknown>): Promise<Tokens> {
    const res = await this.request<TokenResponse>("POST", "/api/v1/auth/token", { body, auth: false });
    const tokens = tokensFromResponse(res, this.now());
    await this.tokenStore?.set(tokens);
    return tokens;
  }

  /** RFC 8628 step 1 (CLI). */
  startDeviceLogin(device: DeviceInfo = { platform: "cli", name: "koto CLI" }, clientId = "cli"): Promise<DeviceCodeResponse> {
    return this.request("POST", "/api/v1/auth/device/code", { body: { clientId, device }, auth: false });
  }

  /**
   * RFC 8628 polling. Waits `interval` seconds between polls, adds 5 s on `slow_down`,
   * resolves with stored tokens once approved; throws ApiError for
   * `expired_token` / `access_denied` / `invalid_grant`, or the abort reason.
   */
  async pollDeviceLogin(deviceCode: string, interval = 5, signal?: AbortSignal): Promise<Tokens> {
    let waitS = Math.max(interval, 1);
    for (;;) {
      await this.sleep(waitS * 1000, signal);
      try {
        return await this.tokenGrant({ grant_type: DEVICE_CODE_GRANT, device_code: deviceCode });
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.code === "authorization_pending") continue;
        if (err.code === "slow_down") {
          waitS += 5;
          continue;
        }
        throw err;
      }
    }
  }

  /** URL to open in the system browser for the native authorization-code + PKCE flow. */
  buildNativeAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
    return this.url("/auth/native/authorize", {
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    });
  }

  /** Exchange the one-time code from the redirect (caller must verify `state` first). */
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; device?: DeviceInfo }): Promise<Tokens> {
    return this.tokenGrant({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      ...(input.device ? { device: input.device } : {}),
    });
  }

  /** iOS native Sign in with Apple. */
  signInWithApple(input: { identityToken: string; nonce?: string; fullName?: { givenName?: string; familyName?: string }; device: DeviceInfo }): Promise<Tokens> {
    return this.request<TokenResponse>("POST", "/api/v1/auth/apple", { body: input, auth: false }).then(async (res) => {
      const tokens = tokensFromResponse(res, this.now());
      await this.tokenStore?.set(tokens);
      return tokens;
    });
  }
}

/** Simple in-memory TokenStore (tests, short-lived CLIs). */
export class MemoryTokenStore implements TokenStore {
  constructor(private tokens: Tokens | null = null) {}
  async get(): Promise<Tokens | null> {
    return this.tokens;
  }
  async set(tokens: Tokens | null): Promise<void> {
    this.tokens = tokens;
  }
}
