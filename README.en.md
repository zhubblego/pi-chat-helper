# pi-chat-helper

[中文](README.md) ｜ **English**

An extension package for [pi coding agent](https://github.com/earendil-works/pi-coding-agent): **replay full session trajectories in the browser** (trajectory-web), and **jump back to any past question inside the TUI** (question-panel). The trajectory viewer is not limited to pi — whichever agent has sessions on the host gets a lit button in the left-hand agent selector bar (currently pi and Codex).

![Light theme](screenshots/light.png)

*Light theme: session sidebar + question sidebar + trajectory segmented by question, tool calls paired with results*

![Dark theme](screenshots/dark.png)

*Dark theme: the detail modal — Markdown tables and mermaid diagrams; theme follows the system or can be pinned*

## Key Features

### Trajectory replay · trajectory-web

- **Full trajectories segmented by question**: session sidebar on the left (grouped by project in mode B, live sessions with a live badge) + question sidebar; on the right the trajectory is segmented by question — the original question, chain of thought, tool calls paired with results, output text, errors, and context events in order; errors and turn outputs are highlighted, turns can be collapsed; the frontend refreshes incrementally every 2 seconds.
- **Detail modal**: click any entry to open a centered modal with Markdown rendering (markdown-it: GFM tables, task lists, strikethrough), ```mermaid``` code blocks rendered automatically as SVG diagrams (lazy-loaded, failures keep the source code), tool parameters/results, tokens and durations, and sub-calls; the modal is draggable and resizable from its bottom-right corner.
- **Multiple agent sources**: native parsing for pi (branch tree, tool pairing, usage stats) plus a translation layer for Codex (messages, thinking, tool pairing, compaction, model switches, effort levels); the agent selector bar lights up every source available on the host, and the URL hash remembers source/session/detail position so everything restores after a refresh.
- **Derived session jumps** (Codex source): every `spawn_agent` call in the trajectory is a derived-session row — click it to enter the child session it spawned, or click `⟨ 主会话` to go back to the parent session with that row highlighted; pi sub-agents are nested inside the parent session, no jump needed.
- **Search and filters**: session-level full-text index (space-separated AND, case-insensitive, hit highlighting, turns without hits auto-hidden); a collapsible filter button group in the question sidebar (question/thinking/tool/output/context/error) plus multi-select tool-name filters (grouped by built-in / `MCP:` / extension package).
- **Translate and copy**: Markdown paragraphs and system prompt sections translated paragraph by paragraph (Microsoft / Google channels, no key required), bilingual side-by-side or translation-only, target language selectable (simplified/traditional Chinese, English, Japanese); one-click copy of the original or the translation.
- **Persistent habits**: filter state, tool exclusions, theme, and translation preferences are persisted server-side in SQLite and inherited across sessions and sources.
- **Light and dark themes**: deepseek-style design tokens, follow the system or pin manually; the first frame is injected by the server to prevent flashing.

### Chat page · chat

Ask pi directly in the browser about any trajectory session — without touching the TUI session you are working in:

- **Independent RPC child process**: the server answers via a `pi --mode rpc` child process; `/new` starts a new thread, `/resume` switches back to a historical thread; one child per trajectory session, at most 2 globally, idle ones recycled after 15 minutes.
- **Context as a tool**: check trajectory entries to send a `<trajectory_index>` list along with your message; the model fetches full texts by id through the read-only `read_trajectory` tool (6k chars per entry / 12k per call); works for both pi and Codex sources.
- **Models and skills**: `/model` lists the models in your explicit configuration set and switches via `set_model` (current model + effort level shown in a single trigger); `/skill` reuses pi's native command expansion, project skills optional.
- **Three tool profiles**: `no-tools` (chat only) / `read-only` (default: read-only trajectory tools + read project files) / `full` (write files and run commands, approval per turn).
- **Console forwarding**: switch to "forward" to send your question straight into a pi TUI console that has pi-chat-helper loaded — answers and tool approvals happen in the console; idle consoles send immediately, busy ones queue by default (interrupt optional), and multiple consoles pop up a candidate picker; a single toggle flips between "independent / forward".
- **Threads stored separately**: chat threads are independent pi sessions under `<agentDir>/pi-chat-helper/chats`, invisible to pi's own `/resume`; deleting them does not affect trajectory history.
- **Safe defaults**: loopback-only listening, Host/Origin validation on POST; chat is automatically disabled when listening on a non-loopback address (trajectory viewing is unaffected).

### TUI question panel · question-panel

`/questions` opens a floating panel (docked to the top-right): single-click an entry to jump the transcript back to that question; double-click / `d` to enter the turn analysis view (thinking → tools → output node tree, `t` shows only the chain of thought); `/questions 50` (columns) or `/questions 60%` (percent) adjusts the width; ↑↓ to select, Enter to jump, q / Esc to close.

## Install

```bash
pi install git:github.com/zhubblego/pi-chat-helper
# or, published on npm:
pi install npm:pi-chat-helper
```

Takes effect in new sessions. Use `pi list` to see installed packages and `pi remove git:github.com/zhubblego/pi-chat-helper` to remove it.

Requires **Node >= 22.19** (the state store uses `node:sqlite`).

Try it once without writing to your config:

```bash
pi -e git:github.com/zhubblego/pi-chat-helper
```

## Quick Start

Two things work out of the box after installation:

**1. Jump back to any past question in the TUI**

```text
/questions
```

**2. Watch session trajectories in the browser**

```text
/deepseek-trail start               # default 127.0.0.1:7717, all sessions of the current project (auto-falls back on port conflicts)
/deepseek-trail start --codex       # current project: pi + Codex (codex filtered by the current working directory)
/deepseek-trail start --all         # all project histories + all available sources
/deepseek-trail start --port 7799   # port can be combined with either switch above
/deepseek-trail stop                # stop the service
```

You can also run a standalone server outside pi to watch **all pi history** including live sessions (grouped by project, with a live badge), plus local **Codex history**:

```bash
npm run dev        # default http://127.0.0.1:7788
# equivalent: node trajectory-web/server/main.mjs --scope all --port 7788
```

## Two startup modes

|  | Mode A (pi plugin) | Mode B (standalone web server) |
|---|---|---|
| Start | run `/deepseek-trail start [port] [--codex] [--all]` inside pi | `npm run dev` (default 7788) |
| Scope | all sessions of the current project by default; `--all` same as mode B | all pi history + live sessions (grouped by project) |
| Sources | pi only by default; `--codex` adds Codex, `--all` all available | lists every agent available on the host (pi, Codex, …) |
| Lifetime | bound to this pi instance, stops when it exits | standalone and persistent, independent of pi |
| Implementation | in-process HTTP service | separate node process |

## Trajectory sources

| Source | Location | Projection |
|---|---|---|
| pi | `~/.pi/agent/sessions/--<cwd>--/*.jsonl` | native parsing (branch tree, tool pairing, usage) |
| Codex | `~/.codex/sessions/year/month/day/rollout-*.jsonl` | translation layer: rollout event streams are translated into pi entry streams and reuse the same projection (messages, thinking, tool pairing, compaction, model switches, effort levels); consecutive context injections are merged into one "system context" event; UI event streams and internal state are skipped |

List scans only read file headers (pi 256KB, Codex chunked with early stop) and cache by mtime+size; `live` means written within the last 30 seconds. The service only reads session files and listens on the loopback address only.

## Known limitations

- Chat page interactions are verified with automated headless Chromium; no manual visual acceptance in a real Chrome yet.
- Console forwarding only supports pi TUI consoles that loaded pi-chat-helper at startup (older consoles are not retrofitted); forward mode does not mirror console answers and does not carry the sidebar context, model, skills, or profile.
- The Codex `read_trajectory` tool is supported, but the Codex send context path has no e2e coverage.
- `/resume` offers thread selection only — no rename/delete; no image/audio/multimodal input.

## Development & Testing

```bash
git clone git:github.com/zhubblego/pi-chat-helper
cd pi-chat-helper

# dev load (the root index.ts is the aggregate entry, registering /questions and /deepseek-trail)
pi -e .
pi -ne -e .        # load only this repo's dev version, without stacking other installed extensions
```

```bash
# trajectory-web (pure node, no PI_HOME needed)
node tests/test-projection.cjs   # projection: grouping/tool pairing/stats/branch rebuild/light truncation
node tests/test-sessions.cjs     # session scanning: list fields/project scope/trailing session names/live/sorting
node tests/test-chat.cjs         # chat host: RPC/threads/SSE/context/approval/process pool/security pure functions
node tests/test-console.cjs      # console bridge: registration/heartbeat/state/token/forward/forward client timeout
node tests/test-server.cjs       # HTTP: multi-session lists/named sessions/incremental/details/dual scope/hot update/chat/console/security/exit
node tests/test-web-lib.cjs      # frontend pure functions: filter mapping/Markdown escaping/session list helpers/search hit splitting
node tests/test-codex.cjs        # Codex source: rollout scanning/translation mapping (messages/thinking/tool pairing/redacted/sub-agent dispatch)/projection reuse
node tests/test-tool-origins.cjs # tool-origin static scan: grouping/protection rules/similarity competition
node tests/test-state-db.cjs     # SQLite state store: schema/WAL/CRUD/legacy JSON migration/permissions/degradation

# trajectory-web extension commands (needs PI_HOME for jiti)
PI_HOME=<pi install dir> node tests/test-extension.cjs

# question-panel (headless, needs PI_HOME)
PI_HOME=<pi install dir> node tests/test-question-panel.cjs
PI_HOME=<pi install dir> node tests/test-render.cjs
PI_HOME=<pi install dir> node tests/test-turn.cjs
PI_HOME=<pi install dir> node tests/test-headless-tui.cjs

# type check (no local typescript in the repo; use the npx cache path)
# first link the pi install's dependency chain in (node_modules is in .gitignore; tsc/LSP resolve types through it):
#   ln -s <pi install dir>/node_modules node_modules
node ~/.npm/_npx/483d2954a4c5190c/node_modules/typescript/bin/tsc -p tsconfig.json
```

The `PI_HOME` environment variable points to the local pi install directory: the legacy layout requires `dist/` and `node_modules/` at the `PI_HOME` root. A managed install's package directory usually only has its own `dist/`, while `test-turn`/`test-render`/`test-question-panel`/`test-headless-tui` also need `@earendil-works/pi-tui`; you can build a temporary two-level PI_HOME:

```bash
mkdir -p /tmp/pi-home
ln -s <pi install dir>/node_modules /tmp/pi-home/node_modules
ln -s <pi install dir>/node_modules/@earendil-works/pi-coding-agent/dist /tmp/pi-home/dist
PI_HOME=/tmp/pi-home node tests/test-turn.cjs
```

## License

MIT. `trajectory-web/web/tokens.css` is reproduced from the `ui-theme` module of [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT, upstream commit `571902028a`); see [LICENSE](LICENSE) for attribution. It is a generated artifact — do not edit by hand.
