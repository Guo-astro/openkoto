import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { legacyRedirect } from "../src/index";

describe("legacy redirects", () => {
  it("maps old marketing-site paths", () => {
    expect(legacyRedirect("/privacy-policy")).toBe("/privacy");
    expect(legacyRedirect("/zh/privacy-policy")).toBe("/privacy");
    expect(legacyRedirect("/ja/terms-of-service/")).toBe("/terms");
    expect(legacyRedirect("/en/docs/kimi-k2")).toBe("/docs/kimi-k2");
    expect(legacyRedirect("/zh")).toBe("/");
    expect(legacyRedirect("/docs/kimi-k2")).toBeNull();
    expect(legacyRedirect("/zhong")).toBeNull();
    expect(legacyRedirect("/api/health")).toBeNull();
  });

  it("redirects www to the apex and keeps the path", async () => {
    const res = await SELF.fetch("https://www.openkoto.com/pricing?x=1", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://openkoto.com/pricing?x=1");
  });

  it("301s legacy privacy links", async () => {
    const res = await SELF.fetch("https://openkoto.com/zh/privacy-policy", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://openkoto.com/privacy");
  });
});
