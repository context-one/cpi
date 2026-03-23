import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Auto Memory Extension for cpi
 *
 * Implements Claude Code's persistent, file-based memory system with two mechanisms:
 *
 * 1. **Inline memory** — MEMORY.md index loaded into system prompt each turn.
 *    The LLM can read/write memory files directly using pi's built-in tools.
 *
 * 2. **Background extraction subagent** — After each agent turn, a separate
 *    message is injected that triggers the LLM to review recent messages and
 *    extract memories it may have missed during the main conversation.
 *
 * Memories stored per-project at ~/.pi/agent/projects/<project-slug>/memory/
 *
 */

const MEMORY_INDEX = "MEMORY.md";
const MAX_INDEX_LINES = 200;
const EXTRACT_MESSAGE_WINDOW = 10; // analyze last N messages

// --- Path helpers ---

function projectPathSlug(cwd: string): string {
  // Match Claude Code's encoding: replace / with - (leading slash becomes leading -)
  return cwd.replace(/[/\\]/g, "-");
}

function getMemoryDir(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const piDir = path.join(home, ".pi", "agent");
  const slug = projectPathSlug(cwd);
  return path.join(piDir, "projects", slug, "memory");
}

function ensureMemoryDir(memoryDir: string): void {
  fs.mkdirSync(memoryDir, { recursive: true });
  const indexPath = path.join(memoryDir, MEMORY_INDEX);
  try {
    fs.writeFileSync(indexPath, "# Memory Index\n\nNo memories saved yet.\n", { flag: "wx" });
  } catch {
    // File already exists — expected
  }
}

function loadMemoryIndex(memoryDir: string): string {
  const indexPath = path.join(memoryDir, MEMORY_INDEX);
  let content: string;
  try {
    content = fs.readFileSync(indexPath, "utf8");
  } catch {
    return "";
  }
  const lines = content.split("\n");
  if (lines.length > MAX_INDEX_LINES) {
    return (
      lines.slice(0, MAX_INDEX_LINES).join("\n") +
      `\n\n> WARNING: ${MEMORY_INDEX} is ${lines.length} lines (limit: ${MAX_INDEX_LINES}). Only the first ${MAX_INDEX_LINES} lines were loaded. Move detailed content into separate topic files and keep ${MEMORY_INDEX} as a concise index.`
    );
  }
  return content;
}

function countMemoryFiles(memoryDir: string): number {
  try {
    return fs
      .readdirSync(memoryDir)
      .filter((f) => f.endsWith(".md") && f !== MEMORY_INDEX).length;
  } catch {
    return 0;
  }
}

// --- System prompt builders ---

function buildMemoryPrompt(memoryDir: string, memoryIndex: string): string {
  return `
# auto memory

You have a persistent auto memory directory at \`${memoryDir}/\`. This directory already exists — write to it directly with the write tool (do not run mkdir or check for its existence). Its contents persist across conversations.

As you work, consult your memory files to build on previous experience. When you encounter a mistake that seems like it could be common, check your memory for relevant notes — and if nothing is written yet, record what you learned.

## How to save memories:
- Organize memory semantically by topic, not chronologically
- Use the write and edit tools to update your memory files
- \`${MEMORY_INDEX}\` is always loaded into your conversation context — lines after ${MAX_INDEX_LINES} will be truncated, so keep it concise
- Create separate topic files (e.g., \`debugging.md\`, \`patterns.md\`) for detailed notes and link to them from MEMORY.md
- Update or remove memories that turn out to be wrong or outdated
- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.

Save memories using this frontmatter format:

\`\`\`markdown
---
name: {{memory name}}
description: {{one-line description — used to decide relevance in future conversations, so be specific}}
---

{{memory content}}
\`\`\`

## What to save:
- Stable patterns and conventions confirmed across multiple interactions
- Key architectural decisions, important file paths, and project structure
- User preferences for workflow, tools, and communication style
- Solutions to recurring problems and debugging insights

## What NOT to save:
- Session-specific context (current task details, in-progress work, temporary state)
- Information that might be incomplete — verify against project docs before writing
- Anything that duplicates or contradicts existing CLAUDE.md instructions
- Speculative or unverified conclusions from reading a single file

## Explicit user requests:
- When the user asks you to remember something across sessions (e.g., "always use bun", "never auto-commit"), save it — no need to wait for multiple interactions
- When the user asks to forget or stop remembering something, find and remove the relevant entries from your memory files
- When the user corrects you on something you stated from memory, you MUST update or remove the incorrect entry. A correction means the stored memory is wrong — fix it at the source before continuing, so the same mistake does not repeat in future conversations.

## When to access memories:
- When memories seem relevant, or the user references prior-conversation work.
- You MUST access memory when the user explicitly asks you to check, recall, or remember.
- If the user asks you to *ignore* memory: don't cite, compare against, or mention it — answer as if absent.
- Memory records can become stale. Before acting on a memory, verify it against current state.

## Searching past context

When looking for past context:
1. Search topic files in your memory directory:
\`\`\`
read the files in ${memoryDir}/
\`\`\`
2. Use narrow search terms (error messages, file paths, function names) rather than broad keywords.

## Current memory index

${memoryIndex || "(empty — no memories saved yet)"}
`;
}

function buildExtractionPrompt(messageCount: number): string {
  return `You are now acting as the memory extraction subagent. Any prior instruction to not write memory files applies to the main conversation — in this role, writing is your job. Analyze the most recent ~${messageCount} messages above and use them to update your persistent memory systems.

## You MUST save memories when:
- You encounter information that might be useful in future conversations. Whenever you find new information, think to yourself whether it would be helpful to have if you started a new conversation tomorrow. If the answer is yes, save it immediately before continuing work on the task.
- When the user describes what they are working on, their goals, or the broader context of their project (e.g., "I'm building...", "we're migrating to...", "the goal is..."), save this so you can reference it in future sessions.
- When in doubt about whether something is worth saving, save it — it is better to prune and curate memories later than it is to fail to remember and have users correct you later.

## What to save in memories:
- Reusable patterns and conventions within the project that are not otherwise documented in the CLAUDE.md files
- Project or goal information that might help you understand the intent of future work
- Architectural decisions, important file paths, and project structure
- User preferences for workflow, tools, or communication style. Especially if the user corrects or guides you during the conversation.
- Solutions to problems that are likely to recur or insights that may help you with future debugging.
- Any information the user explicitly has asked you to remember for later.

## What not to save in memories:
- Ephemeral task details: information that is only relevant to the current task at hand like in-progress work or temporary state
- Information that duplicates or contradicts existing CLAUDE.md instructions.

## Explicit user requests:
- If a user explicitly asks you to remember a piece of information, you MUST save it immediately. Messages like this will often begin with "never...", "always...", "next time...", "remember..." etc.
- If a user explicitly asks you to forget or stop remembering information, you MUST find and remove the relevant entry from the appropriate memory.

## How to save memories:
- Organize memory semantically by topic, not chronologically
- Use the write and edit tools to update your memory files
- \`${MEMORY_INDEX}\` is always loaded into your system prompt — lines after ${MAX_INDEX_LINES} will be truncated, so keep it concise
- Create separate topic files (e.g., \`debugging.md\`, \`patterns.md\`) for detailed notes and link to them from MEMORY.md
- Update or remove memories that turn out to be wrong or outdated
- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.`;
}

// --- Extension ---

export default function autoMemory(pi: ExtensionAPI) {
  let memoryDir = "";
  let memoryIndex = "";
  let extractEnabled = true;
  let turnsSinceExtraction = 0;
  const EXTRACT_EVERY_N_TURNS = 3; // run extraction every N turns

  pi.on("session_start", async (_event, ctx) => {
    memoryDir = getMemoryDir(ctx.cwd);
    turnsSinceExtraction = 0;

    try {
      ensureMemoryDir(memoryDir);
      memoryIndex = loadMemoryIndex(memoryDir);
    } catch (err) {
      ctx.ui.notify(
        `Auto-memory: failed to set up memory dir: ${err}`,
        "warning"
      );
    }


  });

  pi.on("session_switch", async (_event, ctx) => {
    memoryDir = getMemoryDir(ctx.cwd);
    turnsSinceExtraction = 0;
    try {
      ensureMemoryDir(memoryDir);
      memoryIndex = loadMemoryIndex(memoryDir);
    } catch {
      // Non-critical
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!memoryDir) return;

    // Reload index each turn (LLM or extraction may have modified it)
    try {
      memoryIndex = loadMemoryIndex(memoryDir);
    } catch {
      // Non-critical
    }

    return {
      systemPrompt: event.systemPrompt + buildMemoryPrompt(memoryDir, memoryIndex),
    };
  });

  // After each agent turn, trigger background memory extraction via subagent
  pi.on("agent_end", async (_event, ctx) => {
    if (!memoryDir || !extractEnabled) return;

    turnsSinceExtraction++;
    if (turnsSinceExtraction < EXTRACT_EVERY_N_TURNS) return;
    turnsSinceExtraction = 0;

    const fileCountBefore = countMemoryFiles(memoryDir);
    const currentIndex = memoryIndex;
    const extractionPrompt = [
      buildExtractionPrompt(EXTRACT_MESSAGE_WINDOW),
      "",
      `Memory directory: ${memoryDir}`,
      "",
      `Current MEMORY.md contents:`,
      "```",
      currentIndex || "(empty)",
      "```",
      "",
      "Review the conversation context and save any useful memories to the directory above.",
      "Write memory files with frontmatter (name, description) and update MEMORY.md.",
    ].join("\n");

    // Spawn via subagent extension's event bus (background, fire-and-forget)
    pi.events.emit("subagent:spawn-async", {
      prompt: extractionPrompt,
      description: "memory extraction",
      background: true,
      cwd: ctx.cwd,
      onComplete: (result: { success: boolean; output: string }) => {
        if (result.success) {
          try {
            memoryIndex = loadMemoryIndex(memoryDir);
            const fileCountAfter = countMemoryFiles(memoryDir);
            const newMemories = fileCountAfter - fileCountBefore;
            if (newMemories > 0) {
              ctx.ui.notify(
                `Wrote ${newMemories} ${newMemories === 1 ? "memory" : "memories"}`,
                "info"
              );
            }
          } catch {
            // Non-critical
          }
        }
      },
    });
  });

  // Register /memory command
  pi.registerCommand("memory", {
    description: "Show auto-memory status and index",
    handler: async (_args, ctx) => {
      if (!memoryDir) {
        ctx.ui.notify("Memory directory not initialized", "warning");
        return;
      }

      const index = loadMemoryIndex(memoryDir);
      const fileCount = countMemoryFiles(memoryDir);

      const lines = [
        "Auto-Memory Status",
        "",
        `  Directory:    ${memoryDir}`,
        `  Memory files: ${fileCount}`,
        `  Extraction:   ${extractEnabled ? "enabled" : "disabled"} (every ${EXTRACT_EVERY_N_TURNS} turns)`,
        "",
        "--- MEMORY.md ---",
        "",
        index || "(empty)",
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // Register /forget command
  pi.registerCommand("forget", {
    description: "Clear all saved memories (with confirmation)",
    handler: async (_args, ctx) => {
      if (!memoryDir) {
        ctx.ui.notify("Memory directory not initialized", "warning");
        return;
      }

      const ok = await ctx.ui.confirm(
        "Clear all memories?",
        `This will delete all memory files in:\n${memoryDir}\n\nThis cannot be undone.`
      );

      if (!ok) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      try {
        const files = fs
          .readdirSync(memoryDir)
          .filter((f) => f.endsWith(".md"));
        for (const file of files) {
          fs.unlinkSync(path.join(memoryDir, file));
        }
        fs.writeFileSync(
          path.join(memoryDir, MEMORY_INDEX),
          "# Memory Index\n\nNo memories saved yet.\n"
        );
        memoryIndex = "";
        ctx.ui.setStatus("memory", undefined);
        ctx.ui.notify(`Cleared ${files.length} memory files`, "info");
      } catch (err) {
        ctx.ui.notify(`Failed to clear memories: ${err}`, "error");
      }
    },
  });

  // Register /memory-extract command to toggle extraction
  pi.registerCommand("memory-extract", {
    description: "Toggle background memory extraction on/off",
    handler: async (_args, ctx) => {
      extractEnabled = !extractEnabled;
      ctx.ui.notify(
        `Memory extraction: ${extractEnabled ? "enabled" : "disabled"}`,
        "info"
      );
    },
  });
}
