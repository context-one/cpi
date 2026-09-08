# cpi (zippy)

A pre-configured [pi](https://github.com/badlogic/pi-mono) coding agent harness with Claude Code-like UX. Not a fork — a pi package that adds extensions, skills, and sensible defaults.

**For end users:** `curl -fsSL https://contextone.dev/install | bash`

## Getting started

### Prerequisites

- Node.js >= 22.19 (the repo pins Node 24 via `.mise.toml`)
- pi installed globally: `npm install -g @earendil-works/pi-coding-agent`

### Run locally

There is no build step. Pi loads TypeScript extensions directly. Install the package dependencies and subagent companion first:

```bash
npm install
pi install npm:pi-subagents@0.66.0
```

The CPI installer and ContextOne install companions from `cpi.extensions` automatically.

```bash
pi \
  -e ./extensions/auto-memory.ts \
  -e ./extensions/permissions.ts \
  -e ./extensions/plan-mode.ts \
  -e ./extensions/subagent.ts \
  -e ./extensions/hooks-compat.ts \
  -e ./extensions/init.ts \
  -e ./extensions/rules.ts \
  -e ./extensions/doctor.ts \
  --skill ./skills/commit \
  --skill ./skills/review
```

### Test a single extension

```bash
pi -e ./extensions/plan-mode.ts
```

### Authenticate

```bash
pi /login
```

## What's included

| Extension | What it does |
|---|---|
| `auto-memory` | Persistent per-project memory with background extraction subagent |
| `hooks-compat` | Reads Claude Code hooks from `.claude/settings.json` (command + HTTP types) |
| `permissions` | Configurable allow/deny/ask rules with pattern matching, built-in safety fallbacks |
| `plan-mode` | `/plan` and `/exitplan` — read-only planning with structured output |
| `subagent` | Compatibility bridge to pi-subagents for CPI memory extraction and lifecycle hooks |
| `init` | `/init` — bootstraps a project, integrates existing `.claude/` config |
| `rules` | Loads `.claude/rules/*.md` with path-scoped frontmatter into system prompt |
| `doctor` | `/doctor` — diagnostic health check for installation and configuration |

| Skill | What it does |
|---|---|
| `commit` | Structured git commit workflow |
| `review` | Code review for bugs, security, and quality |

## Subagents

CPI installs [pi-subagents](https://github.com/nicobailon/pi-subagents) as a companion, pinned to `0.66.0`. It provides the `subagent` tool, built-in agents such as `delegate`, `scout`, `worker`, and `reviewer`, parallel workflows, background runs, status, and cancellation. The previous custom `agent` tool and `/agents` command are replaced by the companion's tool and `/subagents` commands.

Ask Pi: "Run two reviewers in parallel: one for correctness and one for tests." Use `/subagents-doctor` to check setup, or ask for the status of running subagents. Existing sessions need the companion installed and Pi reloaded; new ContextOne sessions install it during startup after this change reaches CPI's `main` branch.

Foreground children (`async: false`) run in isolated sessions inside the parent process and do not inherit ambient CPI permission or hook extensions. Background children (`async: true`) run in a detached process and can report completion while the parent session remains alive. MCP tools and provider extensions require background children and appropriate agent tool/extension configuration; the built-in delegate does not inherit arbitrary extension tools. See the upstream [agent configuration](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md).

CPI's `subagent:spawn` and `subagent:spawn-async` events use the companion's public structured delegation API. Both run a foreground leaf internally; the async event returns immediately to its caller and delivers `onComplete` later. Memory extraction forks the parent conversation. These CPI requests retain the `subagent:start`/`subagent:stop` hook events and are cancelled on session change or shutdown. Detached children do not start their own automatic memory extraction.

## Tests

```bash
npm install
npm test
```

The integration test uses Pi 0.85.1, an isolated configuration, and a local model stub. It checks companion loading, parallel child execution, detached completion, and CPI memory delegation without real API keys or model charges.
