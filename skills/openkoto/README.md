# OpenKoto skill, CLI and MCP server

This directory is an agent skill (`SKILL.md` + `workflows/`). It teaches agents such as Claude Code to use the `koto` CLI against a user's OpenKoto library.

## Install the CLI

```bash
npm i -g @openkoto/cli     # Node.js ≥ 20
koto login                 # shows a code and opens openkoto.app/device to approve
koto whoami
```

The CLI (and MCP) are part of **OpenKoto Plus**. On the free plan, `koto login`, `koto whoami` and `koto config` still work, and every other command exits with code 4 and an upgrade hint.

- Credentials are stored in `~/.config/koto/credentials.json` (mode 0600, respects `$XDG_CONFIG_HOME`).
- For CI or headless use, set `KOTO_API_KEY=ok_live_…` (created at openkoto.app → Settings → API keys). It takes precedence over the stored login.
- `KOTO_API_BASE` overrides the server (default `https://openkoto.app`).
- To translate lyrics with your own OpenAI-compatible provider (the `--byok` flag):
  ```bash
  koto config set byok.base_url https://api.openai.com/v1
  koto config set byok.api_key sk-...
  koto config set byok.model gpt-4o-mini
  koto lyrics translate song.lrc --to zh --byok --save
  ```

## Install the skill

Copy or symlink this directory into your agent's skills folder:

```bash
# Claude Code (per user)
mkdir -p ~/.claude/skills && ln -s "$(pwd)/skills/openkoto" ~/.claude/skills/openkoto
```

## MCP server

The same MCP tools are available two ways:

- **Remote (recommended):** `https://openkoto.app/mcp`, over Streamable HTTP. Nothing to install, and it works in Claude on the web, desktop and mobile.
- **Local stdio:** `npx -y @openkoto/mcp`. It reuses your `koto login` session or `KOTO_API_KEY`.

**Tools:**

- Read: `search_library`, `list_due_vocab`, `get_review_stats`, `get_lyrics`, `list_books`, `read_chapter`
- Write \*: `add_vocab`, `update_vocab`, `review_vocab`, `save_lyrics_translation`, `create_lyrics`
- Hosted AI \*†: `translate_lyrics`, `create_word_pack_from_text`

\* These tools modify user data and say so in their description, so MCP clients ask before running them.
† These tools spend AI credits.

No delete tools are exposed. Agent access (MCP and CLI) needs **OpenKoto Plus**.

### Remote server (`https://openkoto.app/mcp`)

The server supports the MCP OAuth flow: discovery, dynamic client registration, and PKCE. Clients that support it only need the URL:

- **Claude (web / desktop):** go to Settings → Connectors → *Add custom connector*, and enter
  `https://openkoto.app/mcp`. Claude opens an OpenKoto sign-in and consent page. Click **Allow**. The connection then appears under openkoto.app → Account → Devices, where you can revoke it.
- **Claude Code:**
  ```bash
  claude mcp add --transport http openkoto https://openkoto.app/mcp
  # then run /mcp inside Claude Code to authenticate in the browser
  ```
- **With an API key instead of OAuth** (CI, or clients without OAuth support): create a key with `koto keys create --name mcp --scopes vocab:read,vocab:write,library:read,library:write,ai:use`, then:
  ```bash
  claude mcp add --transport http openkoto https://openkoto.app/mcp --header "Authorization: Bearer ok_live_xxx"
  ```

OAuth connections get a reduced scope set: vocabulary, library and AI. They do not get raw sync or account management.

### Local stdio server

**Claude Code:**

```bash
claude mcp add openkoto -- npx -y @openkoto/mcp
# or with an API key instead of `koto login`:
claude mcp add openkoto -e KOTO_API_KEY=ok_live_xxx -- npx -y @openkoto/mcp
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "openkoto": {
      "command": "npx",
      "args": ["-y", "@openkoto/mcp"],
      "env": { "KOTO_API_KEY": "ok_live_xxx" }
    }
  }
}
```

Leave out `env` to reuse the `koto login` session.
