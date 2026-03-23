# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**cpi** (spoken "zippy") is a pre-configured [pi coding agent](https://github.com/badlogic/pi-mono) harness that replicates Claude Code's UX. It is NOT a fork of pi — it's a pi package containing extensions, skills, and an installer. Users run `curl -fsSL https://contextone.dev/install | bash` and get a fully configured coding agent.

## Running Locally

Requires Node.js >= 20 (mise config pins Node 24):

```bash
# Run pi with all cpi extensions loaded
pi -e ./extensions/auto-memory.ts -e ./extensions/permissions.ts -e ./extensions/plan-mode.ts -e ./extensions/subagent.ts -e ./extensions/hooks-compat.ts -e ./extensions/init.ts --skill ./skills/commit --skill ./skills/review
```

There is no build step — pi loads TypeScript extensions directly via jiti.

## Architecture

Six extensions in `extensions/`, each a standalone pi extension exporting `default function(pi: ExtensionAPI)`. They communicate through pi's event bus (`pi.events.emit`/`pi.events.on`), not direct imports.

**Extension dependency graph:**
```
auto-memory.ts ──emits──▶ subagent:spawn-async ──▶ subagent.ts
subagent.ts ───emits──▶ subagent:start/stop ────▶ hooks-compat.ts
hooks-compat.ts reads .claude/settings.json for hook definitions
permissions.ts and plan-mode.ts hook into tool_call independently
init.ts is standalone (only runs on /init command)
```

**Key event bus contracts:**
- `subagent:spawn-async` — fire-and-forget subagent spawn (used by auto-memory for extraction)
- `subagent:spawn` — awaited subagent spawn (returns SubagentResult via `_resolve`)
- `subagent:start` / `subagent:stop` — lifecycle events consumed by hooks-compat

## Extension Conventions

Every extension follows this pattern:
- Track `projectCwd` via `session_start` + `session_switch` handlers
- Clear session state on both events (not just `session_start`)
- Use `{ recursive: true }` for `mkdirSync`, never guard with `existsSync` (TOCTOU)
- Use `{ flag: "wx" }` for atomic exclusive file creation
- Extract file paths from tool input via `String(input.file_path || input.path || "")`
- Return `{ block: true, reason: "..." }` from `tool_call` handlers to deny execution

## Claude Code Compatibility

The hooks-compat extension reads `.claude/settings.json` hook definitions and maps them to pi events. The format is identical to Claude Code's — users can bring their existing hook configs.

The auto-memory extension uses Claude Code's path slug encoding (`/` → `-`) and MEMORY.md index format so memories are compatible if users switch between tools.

Permissions match Claude Code's UX: auto-approve safe commands, prompt for regular commands, strong warning for dangerous ones.

## Skills

Skills are `SKILL.md` files in `skills/<name>/` with YAML frontmatter (`name`, `description`). Pi discovers them automatically. They are loaded on-demand when the LLM determines they're relevant.
