// Generates an Ed25519 signing key for access tokens.
// Usage: node scripts/gen-jwt-key.mjs | npx wrangler secret put JWT_PRIVATE_KEY
import { generateKeyPairSync } from "node:crypto";
const { privateKey } = generateKeyPairSync("ed25519");
process.stdout.write(privateKey.export({ type: "pkcs8", format: "pem" }));
