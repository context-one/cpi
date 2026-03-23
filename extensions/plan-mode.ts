import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Plan Mode Extension for cpi
 *
 * Adds Claude Code-style plan mode:
 * - /plan command to enter plan mode
 * - /exitplan command to leave plan mode
 * - While active: restricts tools to read-only + plan file edits
 * - Injects plan mode instructions into system prompt
 */

const READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "search", "ls", "find"]);
const PLAN_MODE_TOOLS = new Set([...READ_ONLY_TOOLS, "write", "edit"]);

interface PlanState {
  active: boolean;
  planFile: string | null;
}

function getToolFilePath(input: Record<string, unknown>): string {
  return String(input.file_path || input.path || "");
}

export default function planMode(pi: ExtensionAPI) {
  const state: PlanState = { active: false, planFile: null };

  function generatePlanFile(cwd: string): string {
    const plansDir = path.join(cwd, ".pi", "plans");
    fs.mkdirSync(plansDir, { recursive: true });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return path.join(plansDir, `plan-${id}.md`);
  }

  pi.registerCommand("plan", {
    description: "Enter plan mode — restrict to read-only tools + plan file editing",
    handler: async (_args, ctx) => {
      if (state.active) {
        ctx.ui.notify("Already in plan mode", "warning");
        return;
      }

      try {
        state.planFile = generatePlanFile(ctx.cwd);
      } catch (err) {
        ctx.ui.notify(`Failed to create plan directory: ${err}`, "error");
        return;
      }

      state.active = true;

      const allTools = pi.getAllTools();
      pi.setActiveTools(
        allTools.map((t) => t.name).filter((name) => PLAN_MODE_TOOLS.has(name))
      );

      ctx.ui.setStatus("plan-mode", `Plan mode (${path.basename(state.planFile)})`);
      ctx.ui.notify(`Plan mode active. Plan file: ${state.planFile}`, "info");
    },
  });

  pi.registerCommand("exitplan", {
    description: "Exit plan mode — restore all tools",
    handler: async (_args, ctx) => {
      if (!state.active) {
        ctx.ui.notify("Not in plan mode", "warning");
        return;
      }

      state.active = false;
      pi.setActiveTools(pi.getAllTools().map((t) => t.name));

      ctx.ui.setStatus("plan-mode", undefined);
      ctx.ui.notify("Exited plan mode. All tools restored.", "info");

      if (state.planFile) {
        ctx.ui.notify(`Plan saved at: ${state.planFile}`, "info");
      }
      state.planFile = null;
    },
  });

  pi.on("tool_call", async (event) => {
    if (!state.active) return;

    if (READ_ONLY_TOOLS.has(event.toolName)) return;

    if (event.toolName === "write" || event.toolName === "edit") {
      if (!state.planFile) {
        return { block: true, reason: "Plan mode is active but no plan file is set." };
      }
      const targetPath = getToolFilePath(event.input as Record<string, unknown>);
      if (targetPath && path.resolve(targetPath) !== state.planFile) {
        return {
          block: true,
          reason: `Plan mode: only ${state.planFile} can be modified. Use /exitplan to leave.`,
        };
      }
      return;
    }

    return {
      block: true,
      reason: "Plan mode: only read-only tools and plan file edits allowed. Use /exitplan to leave.",
    };
  });

  pi.on("before_agent_start", async (event) => {
    if (!state.active || !state.planFile) return;

    return {
      systemPrompt: event.systemPrompt + `
<plan-mode>
Plan mode is active.

RULES:
- You MUST NOT execute shell commands (bash tool is disabled)
- You MUST NOT modify any files except the plan file
- You CAN read any files to understand the codebase
- Write your plan to: ${state.planFile}
- When the plan is complete, tell the user to run /exitplan

Write a structured plan: Context, Approach, Steps (with file paths), Verification.
</plan-mode>`,
    };
  });

  pi.on("session_start", async () => {
    state.active = false;
    state.planFile = null;
  });
}
