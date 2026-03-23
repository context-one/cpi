# cpi (zippy)

A pre-configured [pi](https://github.com/badlogic/pi-mono) coding agent harness with Claude Code-like UX. Not a fork — a pi package that adds extensions, skills, and sensible defaults.

**For end users:** `curl -fsSL https://contextone.dev/install | bash`

## Getting started

### Prerequisites

- Node.js >= 20 (the repo pins Node 24 via `.mise.toml`)
- pi installed globally: `npm install -g @mariozechner/pi-coding-agent`

### Run locally

There is no build step. Pi loads TypeScript extensions directly.

```bash
pi \
  -e ./extensions/auto-memory.ts \
  -e ./extensions/permissions.ts \
  -e ./extensions/plan-mode.ts \
  -e ./extensions/subagent.ts \
  -e ./extensions/hooks-compat.ts \
  -e ./extensions/init.ts \
  -e ./extensions/mcp.ts \
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
| `subagent` | `agent` tool + event bus API for spawning isolated pi processes |
| `init` | `/init` — bootstraps a project, integrates existing `.claude/` config |
| `mcp` | MCP server support — reads `.mcp.json`, spawns stdio/HTTP servers, registers tools |
| `rules` | Loads `.claude/rules/*.md` with path-scoped frontmatter into system prompt |
| `doctor` | `/doctor` — diagnostic health check for installation and configuration |

| Skill | What it does |
|---|---|
| `commit` | Structured git commit workflow |
| `review` | Code review for bugs, security, and quality |
