import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountSyncPanel } from "./AccountSyncPanel";
import type { SyncStatus } from "../../lib/cloud";

const invokeMock = vi.fn();
const openUrlMock = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (event: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return Promise.resolve(() => listeners.delete(name));
  },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

const signedOut: SyncStatus = {
  signedIn: false,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  pendingChanges: 3,
  lastReport: null,
  baseUrl: "https://openkoto.app",
  user: null,
};

const signedIn: SyncStatus = {
  ...signedOut,
  signedIn: true,
  lastSyncAt: "2026-09-28T10:00:00Z",
  pendingChanges: 0,
  user: { id: "u1", email: "me@example.com", plan: "free" },
};

describe("AccountSyncPanel", () => {
  afterEach(() => {
    cleanup();
    invokeMock.mockReset();
    openUrlMock.mockReset();
    listeners.clear();
  });

  it("starts the browser sign-in and refreshes when the auth event arrives", async () => {
    let status: SyncStatus = signedOut;
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "cloud_sync_status":
          return Promise.resolve(status);
        case "cloud_login_start":
          return Promise.resolve({ authorizeUrl: "https://openkoto.app/auth/native/authorize", redirectUri: "openkoto://auth/callback", method: "deep-link" });
        case "cloud_account":
          return Promise.resolve({ signedIn: true, user: { id: "u1", email: "me@example.com" }, plan: "plus" });
        default:
          return Promise.resolve(null);
      }
    });

    render(<AccountSyncPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Sign in/ }));
    expect(invokeMock).toHaveBeenCalledWith("cloud_login_start");
    expect(await screen.findByText("Finish signing in in your browser…")).toBeInTheDocument();

    status = signedIn;
    listeners.get("cloud://auth-changed")?.({ payload: { signedIn: true } });

    expect(await screen.findByTestId("account-email")).toHaveTextContent("me@example.com");
    expect(screen.getByText("plus")).toBeInTheDocument();
  });

  it("shows sync status, syncs on demand, links to the account page and signs out", async () => {
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "cloud_sync_status":
          return Promise.resolve(signedIn);
        case "cloud_account":
          return Promise.resolve({ signedIn: true, user: signedIn.user, plan: "free" });
        case "cloud_sync_now":
          return Promise.resolve({ ...signedIn, lastError: "QUOTA_EXCEEDED (402): limit" });
        default:
          return Promise.resolve(null);
      }
    });

    render(<AccountSyncPanel />);
    expect(await screen.findByTestId("account-email")).toHaveTextContent("me@example.com");

    await userEvent.click(screen.getByRole("button", { name: /Sync now/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cloud_sync_now"));
    expect(await screen.findByTestId("sync-error")).toHaveTextContent("QUOTA_EXCEEDED");

    await userEvent.click(screen.getByRole("button", { name: /Manage account/ }));
    expect(openUrlMock).toHaveBeenCalledWith("https://openkoto.app/account");

    await userEvent.click(screen.getByRole("button", { name: /Sign out/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cloud_logout"));
  });
});
