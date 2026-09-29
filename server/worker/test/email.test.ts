import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { parseAddress, sendEmail } from "../src/lib/email";

describe("email", () => {
  it("parses display-name addresses", () => {
    expect(parseAddress("OpenKoto <noreply@openkoto.app>")).toEqual({ name: "OpenKoto", email: "noreply@openkoto.app" });
    expect(parseAddress("noreply@openkoto.app")).toEqual({ email: "noreply@openkoto.app" });
  });

  it("sends through the Cloudflare binding", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "m1" });
    const env = { EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: "OpenKoto <noreply@openkoto.app>", EMAIL: { send } } as unknown as Env;
    await sendEmail(env, { to: "a@example.com", subject: "s", text: "t" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "a@example.com", from: { name: "OpenKoto", email: "noreply@openkoto.app" } }));
  });
});
