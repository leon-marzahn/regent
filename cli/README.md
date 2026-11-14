# regent — Elizabeth's Proxy CLI

Launcher for [Elizabeth's Proxy](../README.md): starts the server, runs it in the tray, manages auto-start, and points local AI tools (Claude Code, Codex, OpenCode, …) at a running server.

## ⚡ Quick Start

Not published to npm yet. Build and install from this repo:

```bash
npm run cli:pack                         # from the repo root: builds and packs cli/
npm install -g ./regent-*.tgz
regent
```

Or run the server in Docker (see [DOCKER.md](../DOCKER.md)).

Dashboard opens at `http://localhost:20128`.

## 🚀 CLI Options

```bash
regent                     # Start with default settings
regent --port 8080         # Custom port
regent --no-browser        # Don't open browser
regent --help              # Show all options
```

**Dashboard**: `http://localhost:20128/dashboard`

---

## 🔌 Connect to a Remote Elizabeth's Proxy

Already running Elizabeth's Proxy on another machine (e.g. a team server on your LAN)? Point this machine's CLI tools at it — no local server is started:

```bash
regent connect http://<server-host>:20128                       # pick tools interactively
regent connect http://<server-host>:20128 --tools claude,codex  # or choose up front
regent connect --reset --tools claude,codex                     # undo
```

It logs in with the dashboard password (hidden prompt), reuses or creates an API key named `cli-<hostname>`, and writes each tool's config (backing up the original once as `*.bak-regent`).

Supported tools: `claude`, `codex`, `opencode`, `droid`, `crush`, `kilo`, `cline`, `pi`, `omp`, or `all`.

### Models

Models come from the **server's own CLI-tools configuration**, so a client gets whatever the operator already picked on the dashboard. Nothing is hardcoded.

| Tool | Model taken from (first match wins) |
|---|---|
| `claude` | tier flag (`--opus` …) → server's Claude tier → *left unset* (Claude Code's own default) |
| others | `--model` → that tool's own model on the server → server's OpenCode model → *tool skipped* |

`kilo` has no readable model on the server, so it always uses `--model` or the OpenCode model. `omp` (Oh My Pi) needs no model: it uses proxy discovery, so every server model appears under `regent` in `/model`. A Claude tier the server doesn't set is removed from your config rather than kept from an earlier run. A skipped tool makes the command exit `1`.

### Overriding the server's models

```bash
# One Claude tier; the other tiers still come from the server
regent connect http://<server-host>:20128 --tools claude --sonnet cc/claude-sonnet-5-5

# Every Claude tier
regent connect http://<server-host>:20128 --tools claude \
  --fable cc/claude-fable-5-2 --opus cc/claude-opus-5-5 \
  --sonnet cc/claude-sonnet-5-5 --haiku cc/claude-haiku-4-5-20251001

# All non-Claude tools at once
regent connect http://<server-host>:20128 --tools codex,opencode,kilo --model ocg/deepseek-flash

# Claude and other tools in one run
regent connect http://<server-host>:20128 --tools claude,codex --opus cc/claude-opus-5-5 --model gpt-6

# A different model per tool: --model covers every non-Claude tool in a run, so run once per tool
regent connect http://<server-host>:20128 --tools codex --model gpt-6
regent connect http://<server-host>:20128 --tools opencode --model ocg/glm-5.3
```

A model the server doesn't list is still written, with a `not listed by server` warning. To see the ids it serves: `curl http://<server-host>:20128/v1/models -H "Authorization: Bearer <your key>"`.

### Checking the current config

`regent show` prints what each CLI tool on this machine is currently set to — base URL, masked API key and models. It only reads local files and never contacts a server.

```bash
regent show                 # every supported tool
regent show claude          # one tool
regent show claude codex    # several
regent show claude --json   # machine-readable (key still masked)
```

```
✅ Claude Code
   File:     ~/.claude/settings.json
   Base URL: http://<server-host>:20128/v1
   API key:  sk-a1b…9f3c
   Models:
     fable   cc/claude-fable-5-2
     opus    cc/claude-opus-5-5
     sonnet  cc/claude-sonnet-5-5
```

Tools not pointed at Elizabeth's Proxy are listed as `not configured`. For Codex, OpenCode and Cline it also warns when an Elizabeth's Proxy entry exists but another provider is the active one.

### Other options

| Option | Purpose |
|---|---|
| `--password <pw>` | Dashboard password (or `NINE_ROUTER_PASSWORD`); prompted if omitted — preferred, keeps it out of shell history |
| `--save` | After a successful login, save the password for this server to `~/.regent/connect.env` (plain text, mode 600) so later runs skip the prompt. Delete the file to forget it |
| `--api-key <key>` | Use this key and skip login. The server's models can't be read without a login, so pass model flags |
| `--key-name <name>` | API key name to reuse/create (default `cli-<hostname>`) |
| `--print-env` | Also print `OPENAI_BASE_URL` / `OPENAI_API_KEY` for other CLIs |
| `--reset` | Remove the Elizabeth's Proxy settings from the selected tools |

See `regent connect --help` for the full list.

> ⚠️ Over plain `http://` the password and API key are sent unencrypted — use a trusted LAN/VPN or put HTTPS in front. The API key is stored in each tool's config file.

---

## 🛠️ Supported CLI Tools

Claude-Code • OpenClaw • Codex • OpenCode • Cursor • Antigravity • Cline • Continue • Droid • Roo • Copilot • Kilo Code • Gemini CLI • Qwen Code • iFlow • Crush • Crusher • Aider

Any tool supporting OpenAI/Claude-compatible API works.

---

## 💾 Data Location

- **macOS/Linux**: `~/.regent/db/data.sqlite`
- **Windows**: `%APPDATA%/regent/db/data.sqlite`
- **Docker**: `/app/data/db/data.sqlite` (mount `$HOME/.regent` to persist)

---

## 📚 Documentation

- **Source**: https://github.com/leon-marzahn/regent
- **Full README**: [../README.md](../README.md)

---

## 🙏 Acknowledgments

- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** - Original Go implementation

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.
