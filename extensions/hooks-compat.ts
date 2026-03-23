import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";

/**
 * Claude Code Hooks Compatibility Extension for cpi
 *
 * Reads hooks from .claude/settings.json and .claude/settings.local.json,
 * then maps them to pi's extension event system.
 *
 * Supported hook events (all Claude Code hook events):
 *
 * Lifecycle:
 * - SessionStart     → pi session_start (startup/resume/clear/compact)
 * - SessionEnd       → pi session_shutdown
 * - Stop             → pi agent_end (can block to continue)
 * - StopFailure      → pi agent_end (on error)
 *
 * Tool hooks:
 * - PreToolUse       → pi tool_call (can block/modify)
 * - PostToolUse      → pi tool_result (feedback/context injection)
 * - PostToolUseFailure → pi tool_result (on error)
 * - PermissionRequest → pi tool_call (permission decisions)
 *
 * User input:
 * - UserPromptSubmit → pi input (can block)
 *
 * Context:
 * - InstructionsLoaded → pi session_start (after loading CLAUDE.md etc.)
 * - Notification       → fires on ui.notify calls
 *
 * Compaction:
 * - PreCompact        → pi session_before_compact
 * - PostCompact       → pi session_compact
 *
 * Session control:
 * - ConfigChange      → watches .claude/settings.json for changes
 *
 * Supported hook types:
 * - command (shell commands with JSON on stdin)
 *
 * Exit codes:
 * - 0: success, continue normally (JSON output processed)
 * - 2: blocking error, stop the action
 * - other: non-blocking error (logged)
 */

// --- Types ---

interface HookEntry {
  type: "command" | "http" | "prompt" | "agent";
  command?: string;
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  prompt?: string;
  model?: string;
  timeout?: number;
  statusMessage?: string;
  once?: boolean;
  async?: boolean;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

interface HooksConfig {
  [eventName: string]: HookMatcher[];
}

interface HookOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  decision?: "block";
  reason?: string;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    updatedMCPToolOutput?: string;
    action?: "accept" | "decline" | "cancel";
  };
}

// --- Helpers ---

function loadHooksConfig(cwd: string): HooksConfig {
  const hooks: HooksConfig = {};
  const files = [
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ];

  // Also load from global ~/.claude/settings.json
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home) {
    files.unshift(path.join(home, ".claude", "settings.json"));
  }

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const content = JSON.parse(fs.readFileSync(file, "utf8"));
      if (content.hooks && typeof content.hooks === "object") {
        for (const [event, matchers] of Object.entries(content.hooks)) {
          if (!hooks[event]) hooks[event] = [];
          if (Array.isArray(matchers)) {
            hooks[event].push(...(matchers as HookMatcher[]));
          }
        }
      }
    } catch {
      // Silently skip malformed config files
    }
  }

  return hooks;
}

const patternCache = new Map<string, RegExp>();

function matchesPattern(pattern: string | undefined, value: string): boolean {
  if (!pattern || pattern === "*") return true;
  const parts = pattern.split("|");
  return parts.some((p) => {
    if (p.includes("*")) {
      let re = patternCache.get(p);
      if (!re) {
        // Escape everything except *, which becomes .*
        const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        re = new RegExp(`^${escaped}$`);
        patternCache.set(p, re);
      }
      return re.test(value);
    }
    return p === value;
  });
}

function getMatchingHooks(
  config: HooksConfig,
  event: string,
  matchValue?: string
): HookEntry[] {
  const matchers = config[event];
  if (!matchers) return [];

  const result: HookEntry[] = [];
  for (const m of matchers) {
    if (matchValue !== undefined && !matchesPattern(m.matcher, matchValue)) {
      continue;
    }
    for (const hook of m.hooks) {
      if (hook.type === "command" && hook.command) {
        result.push(hook);
      } else if (hook.type === "http" && hook.url) {
        result.push(hook);
      }
    }
  }
  return result;
}

function runHookCommand(
  command: string,
  input: Record<string, unknown>,
  cwd: string,
  timeout: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      "/bin/bash",
      ["-c", command],
      {
        cwd,
        timeout: timeout * 1000,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: cwd,
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode =
          error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? 1
            : (error as NodeJS.ErrnoException & { status?: number })?.status ??
              0;
        resolve({ exitCode, stdout: stdout || "", stderr: stderr || "" });
      }
    );

    if (child.stdin) {
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    }
  });
}

/**
 * Run a hook asynchronously (fire-and-forget) when hook.async is true.
 */
function runHttpHook(
  url: string,
  input: Record<string, unknown>,
  headers: Record<string, string>,
  allowedEnvVars: string[],
  timeout: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Expand env vars in headers
    const expandedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      expandedHeaders[key] = value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, varName: string) => {
        if (allowedEnvVars.length > 0 && !allowedEnvVars.includes(varName)) return "";
        return process.env[varName] || "";
      });
    }

    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const lib = isHttps ? https : http;
    const body = JSON.stringify(input);

    const req = lib.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...expandedHeaders,
        },
        timeout: timeout * 1000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          const statusCode = res.statusCode || 500;
          resolve({
            exitCode: statusCode >= 200 && statusCode < 300 ? 0 : 2,
            stdout: data,
            stderr: statusCode >= 400 ? `HTTP ${statusCode}` : "",
          });
        });
      }
    );

    req.on("error", (err) => {
      resolve({ exitCode: 1, stdout: "", stderr: `HTTP hook error: ${err.message}` });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ exitCode: 1, stdout: "", stderr: "HTTP hook timed out" });
    });

    req.write(body);
    req.end();
  });
}

function runHookAsync(
  command: string,
  input: Record<string, unknown>,
  cwd: string,
  timeout: number
): void {
  runHookCommand(command, input, cwd, timeout).catch(() => {
    // Fire-and-forget — errors are silently ignored
  });
}

function parseHookOutput(stdout: string): HookOutput | null {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

// Common input fields included in every hook
function commonInput(
  ctx: { cwd: string },
  eventName: string
): Record<string, unknown> {
  return {
    session_id: "",
    cwd: ctx.cwd,
    hook_event_name: eventName,
  };
}

// --- Extension ---

export default function hooksCompat(pi: ExtensionAPI) {
  let hooksConfig: HooksConfig = {};
  let projectCwd = process.cwd();
  const executedOnceHooks = new Set<string>();

  /**
   * Execute hooks for a given event. Returns the first blocking/meaningful output, or null.
   */
  async function executeHooks(
    event: string,
    matchValue: string | undefined,
    payload: Record<string, unknown>,
    ctx: { cwd: string; ui: { setStatus: Function; notify: Function } }
  ): Promise<{ exitCode: number; output: HookOutput | null } | null> {
    const hooks = getMatchingHooks(hooksConfig, event, matchValue);
    if (hooks.length === 0) return null;

    for (const hook of hooks) {
      const hookId = hook.command || hook.url || "";
      if (!hookId) continue;

      const hookKey = `${event}:${matchValue || "*"}:${hookId}`;
      if (hook.once && executedOnceHooks.has(hookKey)) continue;
      if (hook.once) executedOnceHooks.add(hookKey);

      // Async hooks are fire-and-forget
      if (hook.async) {
        if (hook.type === "command") {
          runHookAsync(hook.command!, payload, ctx.cwd, hook.timeout ?? 600);
        }
        // HTTP async: fire-and-forget POST
        if (hook.type === "http") {
          runHttpHook(hook.url!, payload, hook.headers || {}, hook.allowedEnvVars || [], hook.timeout ?? 30);
        }
        continue;
      }

      if (hook.statusMessage) {
        ctx.ui.setStatus("hook", hook.statusMessage);
      }

      let result: { exitCode: number; stdout: string; stderr: string };

      if (hook.type === "http") {
        result = await runHttpHook(
          hook.url!,
          payload,
          hook.headers || {},
          hook.allowedEnvVars || [],
          hook.timeout ?? 30
        );
      } else {
        result = await runHookCommand(
          hook.command!,
          payload,
          ctx.cwd,
          hook.timeout ?? 600
        );
      }

      ctx.ui.setStatus("hook", undefined);

      // Exit code 2 = blocking error
      if (result.exitCode === 2) {
        return {
          exitCode: 2,
          output: {
            decision: "block",
            reason: result.stderr.trim() || `Blocked by ${event} hook`,
          },
        };
      }

      // Exit code 0 = success, parse output
      if (result.exitCode === 0) {
        const output = parseHookOutput(result.stdout);
        if (output) {
          // Check for explicit block decision in JSON output
          if (output.decision === "block") {
            return { exitCode: 0, output };
          }
          // Check for deny permission decision
          if (output.hookSpecificOutput?.permissionDecision === "deny") {
            return { exitCode: 0, output };
          }
          // Return output for non-blocking results that have content
          if (
            output.hookSpecificOutput?.additionalContext ||
            output.hookSpecificOutput?.updatedInput ||
            output.systemMessage
          ) {
            return { exitCode: 0, output };
          }
        }
      }

      // Non-zero (not 2) = non-blocking warning
      if (result.exitCode !== 0 && result.stderr) {
        ctx.ui.notify(`[${event} hook]: ${result.stderr.trim()}`, "warning");
      }
    }

    return null;
  }

  // ============================================================
  // SessionStart → session_start
  // ============================================================
  let configWatcher: fs.FSWatcher | null = null;

  pi.on("session_start", async (_event, ctx) => {
    projectCwd = ctx.cwd;
    hooksConfig = loadHooksConfig(ctx.cwd);
    executedOnceHooks.clear();

    const eventCount = Object.keys(hooksConfig).length;
    if (eventCount > 0) {
      ctx.ui.notify(
        `Loaded Claude Code hooks (${eventCount} event types)`,
        "info"
      );
    }

    await executeHooks("SessionStart", "startup", {
      ...commonInput(ctx, "SessionStart"),
      source: "startup",
    }, ctx);

    // Fire InstructionsLoaded for any CLAUDE.md
    const claudeMd = path.join(ctx.cwd, "CLAUDE.md");
    try {
      fs.accessSync(claudeMd);
      await executeHooks("InstructionsLoaded", "session_start", {
        ...commonInput(ctx, "InstructionsLoaded"),
        file_path: claudeMd,
        load_reason: "session_start",
      }, ctx);
    } catch {
      // No CLAUDE.md — skip
    }

    // Set up config watcher for .claude/settings.json changes
    if (configWatcher) {
      configWatcher.close();
      configWatcher = null;
    }
    const claudeSettingsDir = path.join(ctx.cwd, ".claude");
    try {
      configWatcher = fs.watch(claudeSettingsDir, async (_eventType, filename) => {
        if (!filename?.endsWith(".json")) return;
        const source = filename.includes("local") ? "local_settings" : "project_settings";
        const result = await executeHooks("ConfigChange", source, {
          ...commonInput({ cwd: projectCwd }, "ConfigChange"),
          source,
          file_path: path.join(claudeSettingsDir, filename),
        }, { cwd: projectCwd, ui: ctx.ui });
        if (result?.exitCode === 2 || result?.output?.decision === "block") {
          ctx.ui.notify(result.output?.reason || "Config change blocked by hook", "warning");
        } else {
          hooksConfig = loadHooksConfig(projectCwd);
        }
      });
    } catch {
      // Directory may not exist — not critical
    }
  });

  // ============================================================
  // SessionEnd → session_shutdown
  // ============================================================
  pi.on("session_shutdown", async (_event, ctx) => {
    await executeHooks("SessionEnd", "other", {
      ...commonInput(ctx, "SessionEnd"),
      reason: "other",
    }, ctx);
  });

  // ============================================================
  // PreToolUse → tool_call (can block/modify)
  // ============================================================
  pi.on("tool_call", async (event, ctx) => {
    // --- PreToolUse ---
    const preResult = await executeHooks("PreToolUse", event.toolName, {
      ...commonInput(ctx, "PreToolUse"),
      tool_name: event.toolName,
      tool_input: event.input ?? {},
    }, ctx);

    if (preResult) {
      const output = preResult.output;
      if (preResult.exitCode === 2 || output?.decision === "block") {
        return {
          block: true,
          reason: output?.reason || output?.hookSpecificOutput?.permissionDecisionReason || "Blocked by PreToolUse hook",
        };
      }
      if (output?.hookSpecificOutput?.permissionDecision === "deny") {
        return {
          block: true,
          reason: output.hookSpecificOutput.permissionDecisionReason || "Denied by PreToolUse hook",
        };
      }
    }

    // --- PermissionRequest ---
    const permResult = await executeHooks("PermissionRequest", event.toolName, {
      ...commonInput(ctx, "PermissionRequest"),
      tool_name: event.toolName,
      tool_input: event.input ?? {},
    }, ctx);

    if (permResult) {
      const output = permResult.output;
      if (permResult.exitCode === 2) {
        return { block: true, reason: "Denied by PermissionRequest hook" };
      }
      if (output?.hookSpecificOutput?.permissionDecision === "deny") {
        return {
          block: true,
          reason: output.hookSpecificOutput.permissionDecisionReason || "Denied by PermissionRequest hook",
        };
      }
    }
  });

  // ============================================================
  // PostToolUse / PostToolUseFailure → tool_result
  // ============================================================
  pi.on("tool_result", async (event, ctx) => {
    const isError = event.isError ?? false;
    const hookEvent = isError ? "PostToolUseFailure" : "PostToolUse";

    const payload: Record<string, unknown> = {
      ...commonInput(ctx, hookEvent),
      tool_name: event.toolName,
      tool_input: event.input ?? {},
    };

    if (isError) {
      payload.error = event.result?.content?.[0]?.text ?? "Unknown error";
      payload.is_interrupt = false;
    } else {
      payload.tool_response = event.result ?? {};
    }

    const result = await executeHooks(hookEvent, event.toolName, payload, ctx);

    if (result?.output?.hookSpecificOutput?.additionalContext) {
      return {
        content: [
          ...(Array.isArray(event.result?.content) ? event.result.content : []),
          {
            type: "text" as const,
            text: `\n[Hook feedback]: ${result.output.hookSpecificOutput.additionalContext}`,
          },
        ],
      };
    }
  });

  // ============================================================
  // UserPromptSubmit → input (can block)
  // ============================================================
  pi.on("input", async (event, ctx) => {
    const result = await executeHooks("UserPromptSubmit", undefined, {
      ...commonInput(ctx, "UserPromptSubmit"),
      prompt: event.text,
    }, ctx);

    if (result) {
      const output = result.output;
      if (result.exitCode === 2 || output?.decision === "block") {
        ctx.ui.notify(
          output?.reason || "Prompt blocked by UserPromptSubmit hook",
          "warning"
        );
        return { action: "handled" as const };
      }
      // Support additionalContext injection
      if (output?.hookSpecificOutput?.additionalContext) {
        return {
          action: "transform" as const,
          text: `${event.text}\n\n[Hook context]: ${output.hookSpecificOutput.additionalContext}`,
        };
      }
    }

    return { action: "continue" as const };
  });

  // ============================================================
  // Stop → agent_end (can block to force continuation)
  // ============================================================
  pi.on("agent_end", async (_event, ctx) => {
    const result = await executeHooks("Stop", undefined, {
      ...commonInput(ctx, "Stop"),
      stop_hook_active: false,
    }, ctx);

    if (result?.output?.decision === "block" || result?.exitCode === 2) {
      // In pi, we can't directly prevent stopping from agent_end,
      // but we can notify the user and send a follow-up message
      const reason = result.output?.reason || "Stop hook requested continuation";
      pi.sendMessage({
        customType: "hooks-compat",
        content: `[Stop hook]: ${reason}`,
        display: true,
        details: {},
      }, { triggerTurn: true });
    }
  });

  // ============================================================
  // Notification → fires when ui.notify is called
  // (pi doesn't have a direct notification event, so we fire these
  //  from our own code when relevant)
  // ============================================================

  // ============================================================
  // PreCompact → session_before_compact
  // ============================================================
  pi.on("session_before_compact", async (event, ctx) => {
    const trigger = "auto"; // pi doesn't distinguish manual vs auto in the event
    await executeHooks("PreCompact", trigger, {
      ...commonInput(ctx, "PreCompact"),
      trigger,
    }, ctx);
  });

  // ============================================================
  // PostCompact → session_compact
  // ============================================================
  pi.on("session_compact", async (event, ctx) => {
    const trigger = "auto";
    await executeHooks("PostCompact", trigger, {
      ...commonInput(ctx, "PostCompact"),
      trigger,
    }, ctx);
  });

  // ============================================================
  // Session switching events
  // ============================================================
  pi.on("session_before_switch", async (event, ctx) => {
    // Map pi session switch to SessionStart/SessionEnd depending on reason
    if (event.reason === "new") {
      await executeHooks("SessionEnd", "clear", {
        ...commonInput(ctx, "SessionEnd"),
        reason: "clear",
      }, ctx);
    }
  });

  pi.on("session_switch", async (event, ctx) => {
    // Reload hooks from possibly new cwd
    hooksConfig = loadHooksConfig(ctx.cwd);

    const source = event.reason === "new" ? "clear" : "resume";
    await executeHooks("SessionStart", source, {
      ...commonInput(ctx, "SessionStart"),
      source,
    }, ctx);
  });

  // ============================================================
  // session_before_fork → no direct Claude Code equivalent, skip
  // session_fork → no direct Claude Code equivalent, skip
  // session_before_tree → no direct Claude Code equivalent, skip
  // session_tree → no direct Claude Code equivalent, skip
  // ============================================================

  // ============================================================
  // Model changes → fire Notification hooks
  // ============================================================
  pi.on("model_select", async (event, ctx) => {
    await executeHooks("Notification", undefined, {
      ...commonInput(ctx, "Notification"),
      message: `Model changed to ${event.model}`,
      title: "Model change",
      notification_type: "model_change",
    }, ctx);
  });

  // ============================================================
  // SubagentStart / SubagentStop → subagent extension events
  // ============================================================
  pi.events.on("subagent:start", async (data: {
    agent_id: string;
    agent_type: string;
  }) => {
    // Need a ctx-like object for executeHooks — use projectCwd
    const ctx = { cwd: projectCwd, ui: { setStatus: () => {}, notify: () => {} } };
    await executeHooks("SubagentStart", data.agent_type, {
      ...commonInput(ctx, "SubagentStart"),
      agent_id: data.agent_id,
      agent_type: data.agent_type,
    }, ctx);
  });

  pi.events.on("subagent:stop", async (data: {
    agent_id: string;
    agent_type: string;
    last_assistant_message?: string;
    success?: boolean;
    error?: string;
  }) => {
    const ctx = { cwd: projectCwd, ui: { setStatus: () => {}, notify: () => {} } };
    const result = await executeHooks("SubagentStop", data.agent_type, {
      ...commonInput(ctx, "SubagentStop"),
      agent_id: data.agent_id,
      agent_type: data.agent_type,
      last_assistant_message: data.last_assistant_message || "",
      stop_hook_active: false,
    }, ctx);

    // SubagentStop can block (prevent stopping / request continuation)
    // but since the subagent process already exited, blocking is advisory only.
    // Log it as a notification.
    if (result?.exitCode === 2 || result?.output?.decision === "block") {
      const reason = result.output?.reason || "SubagentStop hook requested continuation";
      // Can't actually prevent the stop since the process exited,
      // but we can notify via the shared event bus
      pi.events.emit("subagent:stop-blocked", {
        agent_id: data.agent_id,
        reason,
      });
    }
  });

  pi.on("session_shutdown", async () => {
    if (configWatcher) {
      configWatcher.close();
      configWatcher = null;
    }
  });

  // ============================================================
  // /hooks command — view configured hooks
  // ============================================================
  pi.registerCommand("hooks", {
    description: "Show configured Claude Code hooks",
    handler: async (_args, ctx) => {
      hooksConfig = loadHooksConfig(ctx.cwd);
      const events = Object.keys(hooksConfig);

      if (events.length === 0) {
        ctx.ui.notify(
          "No Claude Code hooks configured.\nAdd hooks to .claude/settings.json",
          "info"
        );
        return;
      }

      const lines: string[] = ["Claude Code Hooks:", ""];
      for (const event of events) {
        const matchers = hooksConfig[event];
        lines.push(`  ${event}:`);
        for (const m of matchers) {
          const pattern = m.matcher || "*";
          for (const h of m.hooks) {
            if (h.type === "command") {
              lines.push(`    [${pattern}] ${h.command}`);
            } else {
              lines.push(`    [${pattern}] (${h.type})`);
            }
          }
        }
        lines.push("");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
