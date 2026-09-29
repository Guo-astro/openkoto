// Generates activation codes (e.g. to sell on Xiaohongshu) and stores only their hashes in D1.
//
//   node scripts/gen-activation-codes.mjs --plan plus --days 365 --count 20 --batch xhs-2026-10
//   node scripts/gen-activation-codes.mjs --credits 3000 --count 10
//   node scripts/gen-activation-codes.mjs --plan pro --days 30 --count 1 --env staging   # Pro codes include 1500 credits per 30 days
//
// Codes are printed once and written to codes-<batch>.csv in the current directory; the
// database cannot recover them later. Must match hashActivationCode() in src/billing/routes.ts.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    plan: { type: "string" },
    days: { type: "string", default: "0" },
    credits: { type: "string", default: "0" },
    count: { type: "string", default: "1" },
    batch: { type: "string", default: new Date().toISOString().slice(0, 10) },
    env: { type: "string" },
  },
});

const plan = values.plan === "plus" || values.plan === "pro" ? values.plan : null;
if (values.plan && !plan) throw new Error("--plan must be plus or pro");
const days = Number(values.days);
// Pro includes AI credits: by default a Pro code carries the same monthly allotment as a paid
// Pro subscription (PRO_MONTHLY_CREDITS in src/billing/catalog.ts) for each 30 days.
const PRO_MONTHLY_CREDITS = 1500;
const credits = values.credits !== "0" || plan !== "pro" ? Number(values.credits) : PRO_MONTHLY_CREDITS * Math.max(1, Math.round(days / 30));
const count = Math.min(Math.max(Number(values.count), 1), 500);
if (!plan && !credits) throw new Error("a code must grant --plan (with --days) or --credits");
if (plan && !(days > 0)) throw new Error("--days is required with --plan");
const batch = values.batch.slice(0, 60).replace(/'/g, "");

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
function randomCode() {
  const limit = 256 - (256 % ALPHABET.length);
  let raw = "";
  while (raw.length < 12) for (const b of randomBytes(24)) if (b < limit && raw.length < 12) raw += ALPHABET[b % ALPHABET.length];
  return `OK-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}
const hash = (code) => createHash("sha256").update(`activation:${code.toUpperCase().replace(/[^0-9A-Z]/g, "")}`).digest("hex");

const now = Date.now();
const codes = Array.from({ length: count }, randomCode);
const sql = codes
  .map((c) => `insert into activation_codes (code_hash, batch, plan, duration_days, credits, created_at) values ('${hash(c)}', '${batch}', ${plan ? `'${plan}'` : "null"}, ${days}, ${credits}, ${now});`)
  .join("\n");

const dir = mkdtempSync(join(tmpdir(), "okcodes-"));
const file = join(dir, "codes.sql");
writeFileSync(file, sql);
const database = values.env === "staging" ? "openkoto-staging" : "openkoto";
try {
  execFileSync("npx", ["wrangler", "d1", "execute", database, "--remote", "--file", file, ...(values.env ? ["--env", values.env] : [])], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "ignore", "inherit"] });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const out = `codes-${batch}${values.env ? `-${values.env}` : ""}.csv`;
writeFileSync(out, `code,plan,days,credits\n${codes.map((c) => `${c},${plan ?? ""},${days},${credits}`).join("\n")}\n`);
console.log(codes.join("\n"));
console.error(`\n${count} codes stored in ${database} (batch ${batch}) and saved to ${out}`);
