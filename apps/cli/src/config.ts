// Config & credential storage for koto (and the MCP server, which reuses the CLI login).
// Layout (XDG): $XDG_CONFIG_HOME/koto or ~/.config/koto
//   config.json       user settings (api base, BYOK provider)
//   credentials.json  tokens, mode 0600

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenStore, Tokens } from "@openkoto/client";

export const DEFAULT_API_BASE = "https://openkoto.com";

export type Env = Record<string, string | undefined>;

export function configDir(env: Env = process.env): string {
  if (env.KOTO_CONFIG_DIR) return env.KOTO_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "koto");
}

export interface ByokConfig {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
  base_url?: string;
  api_key?: string;
  model?: string;
}

export interface KotoConfig {
  api_base?: string;
  byok?: ByokConfig;
}

/** Keys accepted by `koto config set/get`. */
export const CONFIG_KEYS = ["api_base", "byok.base_url", "byok.api_key", "byok.model"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

export interface StoredCredentials extends Tokens {
  baseUrl?: string;
  /** Epoch ms of the last successful "CLI is included in your plan" check. */
  cliEntitledAt?: number | null;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

async function writeJson(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: mode ?? 0o644 });
  if (mode !== undefined) await chmod(path, mode);
}

export class ConfigStore {
  constructor(readonly dir: string) {}

  get configPath(): string {
    return join(this.dir, "config.json");
  }

  get credentialsPath(): string {
    return join(this.dir, "credentials.json");
  }

  async load(): Promise<KotoConfig> {
    return (await readJson<KotoConfig>(this.configPath)) ?? {};
  }

  async save(config: KotoConfig): Promise<void> {
    // May hold a BYOK api key → keep it private too.
    await writeJson(this.configPath, config, 0o600);
  }

  async get(key: ConfigKey): Promise<string | undefined> {
    const config = await this.load();
    if (key === "api_base") return config.api_base;
    const sub = key.slice("byok.".length) as keyof ByokConfig;
    return config.byok?.[sub];
  }

  async set(key: ConfigKey, value: string | undefined): Promise<void> {
    const config = await this.load();
    if (key === "api_base") {
      if (value === undefined) delete config.api_base;
      else config.api_base = value;
    } else {
      const sub = key.slice("byok.".length) as keyof ByokConfig;
      config.byok = { ...(config.byok ?? {}) };
      if (value === undefined) delete config.byok[sub];
      else config.byok[sub] = value;
    }
    await this.save(config);
  }

  async readCredentials(): Promise<StoredCredentials | null> {
    return readJson<StoredCredentials>(this.credentialsPath);
  }

  async writeCredentials(creds: StoredCredentials | null): Promise<void> {
    if (!creds) {
      await rm(this.credentialsPath, { force: true });
      return;
    }
    await writeJson(this.credentialsPath, creds, 0o600);
  }
}

/** TokenStore backed by credentials.json; keeps `baseUrl` and the entitlement cache across refreshes. */
export class FileTokenStore implements TokenStore {
  constructor(
    private readonly store: ConfigStore,
    private readonly baseUrl: string,
  ) {}

  async get(): Promise<Tokens | null> {
    const creds = await this.store.readCredentials();
    if (!creds?.accessToken) return null;
    return creds;
  }

  async set(tokens: Tokens | null): Promise<void> {
    if (!tokens) return this.store.writeCredentials(null);
    const previous = await this.store.readCredentials();
    await this.store.writeCredentials({ ...previous, ...tokens, baseUrl: this.baseUrl });
  }
}

/** Static bearer token (KOTO_API_KEY = ok_live_…); never refreshes. */
export class ApiKeyTokenStore implements TokenStore {
  constructor(private readonly key: string) {}
  async get(): Promise<Tokens | null> {
    return { accessToken: this.key };
  }
  async set(): Promise<void> {
    // API keys are not stored or rotated.
  }
}

export interface ResolvedAuth {
  baseUrl: string;
  tokenStore: TokenStore;
  source: "api_key" | "credentials" | "none";
}

/** KOTO_API_KEY wins over the stored login; KOTO_API_BASE > credentials.baseUrl > config.api_base > default. */
export async function resolveAuth(store: ConfigStore, env: Env = process.env): Promise<ResolvedAuth> {
  const [config, creds] = await Promise.all([store.load(), store.readCredentials()]);
  const baseUrl = (env.KOTO_API_BASE || (env.KOTO_API_KEY ? undefined : creds?.baseUrl) || config.api_base || DEFAULT_API_BASE).replace(/\/+$/, "");
  const apiKey = env.KOTO_API_KEY?.trim();
  if (apiKey) return { baseUrl, tokenStore: new ApiKeyTokenStore(apiKey.replace(/^Bearer\s+/i, "")), source: "api_key" };
  return { baseUrl, tokenStore: new FileTokenStore(store, baseUrl), source: creds?.accessToken ? "credentials" : "none" };
}
