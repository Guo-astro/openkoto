// stdio entry: `npx @openkoto/mcp` / `openkoto-mcp`.
// Auth: KOTO_API_KEY (ok_live_…) or the credentials saved by `koto login`.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LibraryClient, OpenKotoClient } from "@openkoto/client";
import { ConfigStore, configDir, resolveAuth } from "@openkoto/cli";
import { createOpenKotoMcpServer, SERVER_VERSION } from "@openkoto/mcp-tools";
import { createGuard } from "./guard";

const store = new ConfigStore(configDir(process.env));
const auth = await resolveAuth(store, process.env);
const client = new OpenKotoClient({ baseUrl: auth.baseUrl, clientName: `mcp/${SERVER_VERSION}`, tokenStore: auth.tokenStore });
const server = createOpenKotoMcpServer(new LibraryClient(client), { guard: createGuard(auth.source, () => client.me()) });
await server.connect(new StdioServerTransport());
if (auth.source === "none") console.error("openkoto-mcp: not signed in — run `koto login` or set KOTO_API_KEY. Tools will return an error until then.");
