// OpenKoto cloud account & sync — thin wrappers over the Rust commands in src-tauri/src/cloud.
import { invoke } from "@tauri-apps/api/core";

export const ACCOUNT_URL = "https://openkoto.app/account";

export const CLOUD_EVENTS = {
  authChanged: "cloud://auth-changed",
  syncStatus: "cloud://sync-status",
  dataChanged: "cloud://data-changed",
} as const;

export interface CloudUser {
  id: string;
  email: string;
  name?: string | null;
  plan?: string | null;
}

export interface SyncReport {
  pulled: number;
  applied: number;
  pushed: number;
  conflicts: number;
  repushRounds: number;
  rejected: { type: string; id: string; code: string; message?: string | null }[];
  rebuilt: boolean;
  replayedCards: string[];
  diagnostics: string[];
  deduped?: number;
}

export interface SyncStatus {
  signedIn: boolean;
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingChanges: number;
  lastReport: SyncReport | null;
  baseUrl: string;
  user: CloudUser | null;
  /** "keychain" or "file" (encrypted file fallback when no keychain is available). */
  tokenStorage?: "keychain" | "file" | string;
  /** Signed in to a different account than last time; waiting for the user's choice. */
  pendingAccountSwitch?: PendingAccountSwitch | null;
}

export interface PendingAccountSwitch {
  userId: string;
  email: string;
  previousUserId: string;
  previousEmail?: string | null;
}

/** `GET /api/v1/me` passthrough (plus `signedIn` / `offline`). */
export interface CloudAccount {
  signedIn: boolean;
  offline?: boolean;
  error?: string;
  user?: CloudUser | null;
  plan?: string | null;
  credits?: number;
}

export interface LoginStart {
  authorizeUrl: string;
  redirectUri: string;
  method: "deep-link" | "loopback";
}

export interface AuthChangedPayload {
  signedIn: boolean;
  needsAccountChoice?: boolean;
  user?: CloudUser | null;
  error?: string;
}

export const cloudLoginStart = () => invoke<LoginStart>("cloud_login_start");
export const cloudLoginCancel = () => invoke<void>("cloud_login_cancel");
export const cloudLogout = () => invoke<void>("cloud_logout");
export const cloudAccount = () => invoke<CloudAccount>("cloud_account");
export const cloudSyncNow = () => invoke<SyncStatus>("cloud_sync_now");
export const cloudSyncStatus = () => invoke<SyncStatus>("cloud_sync_status");
/** Account switch: upload this computer's data to the new account, or keep it local-only. */
export const cloudResolveAccountSwitch = (upload: boolean) => invoke<SyncStatus>("cloud_resolve_account_switch", { upload });

/** Account URL on the same origin as the configured API (self-hosted / staging aware). */
export function accountUrl(baseUrl?: string | null): string {
  if (!baseUrl) return ACCOUNT_URL;
  return `${baseUrl.replace(/\/+$/, "")}/account`;
}
