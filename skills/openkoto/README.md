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

`@openkoto/mcp` is a stdio MCP server. It uses the `koto login` credentials, or `KOTO_API_KEY`.

It provides these tools: `search_library`, `list_due_vocab`, `add_vocab`\*, `review_vocab`\*, `get_lyrics`, `save_lyrics_translation`\*, `create_lyrics`\*, `list_books`. Tools marked \* modify user data and say so in their description, so the client asks before running them. No delete tools are exposed.

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
