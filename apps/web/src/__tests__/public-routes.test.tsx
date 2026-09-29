import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";

const session = vi.hoisted(() => ({ account: null as unknown, loading: false }));

vi.mock("../lib/session", () => ({
  useSession: () => ({ ...session, refresh: async () => session.account, signOut: async () => {} }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));
// The dashboard reads the local database; a stub is enough to prove which page `/` renders.
vi.mock("../pages/HomePage", () => ({ HomePage: () => <p>dashboard-home</p> }));
vi.mock("../components/SyncIndicator", () => ({ SyncIndicator: () => null }));

const { AppRoutes } = await import("../App");

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe("public routes", () => {
  beforeEach(async () => {
    session.account = null;
    session.loading = false;
    await act(() => i18n.changeLanguage("en"));
  });
  afterEach(() => localStorage.clear());

  it("shows the landing page at / when signed out", () => {
    renderAt("/");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("content you love");
    expect(screen.getAllByRole("link", { name: /get started free/i })[0]).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: /see pricing/i })).toHaveAttribute("href", "/pricing");
    expect(screen.getAllByRole("link", { name: /download from github/i })[0]).toHaveAttribute(
      "href",
      "https://github.com/hikariming/openkoto/releases",
    );
    expect(screen.getAllByRole("link", { name: "Privacy Policy" })[0]).toHaveAttribute("href", "/privacy");
    expect(screen.queryByText("dashboard-home")).not.toBeInTheDocument();
  });

  it("shows the dashboard at / when signed in", () => {
    session.account = { user: { email: "a@example.com", name: "A" }, plan: "free" };
    renderAt("/");
    expect(screen.getByText("dashboard-home")).toBeInTheDocument();
    expect(screen.queryByText(/get started free/i)).not.toBeInTheDocument();
  });

  it("redirects legacy legal URLs", async () => {
    renderAt("/privacy-policy");
    expect(await screen.findByRole("heading", { level: 1, name: "Privacy Policy" })).toBeInTheDocument();
    expect(screen.getByText(/lbm21@tsinghua\.org\.cn/)).toBeInTheDocument();
  });

  it("redirects /:lang/docs/* to /docs/* and switches the language", async () => {
    renderAt("/ja/docs/302ai");
    expect(await screen.findByRole("heading", { level: 1, name: "302.AI API Key の取得" })).toBeInTheDocument();
    expect(i18n.language).toBe("ja");
  });

  it("redirects /:lang/terms-of-service and /:lang", async () => {
    const { unmount } = renderAt("/zh/terms-of-service");
    expect(await screen.findByRole("heading", { level: 1, name: "服务条款" })).toBeInTheDocument();
    unmount();
    await act(() => i18n.changeLanguage("en"));
    renderAt("/ja");
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("言語を学ぼう");
  });

  it("renders the changelog", async () => {
    renderAt("/updates");
    expect(await screen.findByRole("heading", { level: 1, name: "Updates" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "openkoto.com is now the OpenKoto web app" })).toBeInTheDocument();
  });

  it("renders docs", async () => {
    renderAt("/docs");
    expect(await screen.findByRole("heading", { level: 1, name: "Introduction" })).toBeInTheDocument();
    const kimi = screen.getAllByRole("link", { name: "Get a Kimi K2.5 API Key" });
    expect(kimi.length).toBeGreaterThan(0);
    for (const link of kimi) expect(link).toHaveAttribute("href", "/docs/kimi-k2");
  });

  it("shows 404 for unknown paths", () => {
    renderAt("/fr/whatever");
    expect(screen.getByText("404")).toBeInTheDocument();
  });
});
