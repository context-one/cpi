import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Permissions Extension for cpi
 *
 * Claude Code-compatible permission system with configurable rules.
 * Reads allow/deny/ask rules from settings. Pattern matching on tool names
 * and arguments. Precedence: deny, then ask, then allow.
 * Falls back to built-in safety rules when no config exists.
 */

// --- Types ---

interface PermissionRule {
  toolName: string;
  ruleContent?: string;
}

interface PermissionsConfig {
  allow: PermissionRule[];
  deny: PermissionRule[];
  ask: PermissionRule[];
}

interface PermissionsState {
  config: PermissionsConfig;
  sessionApprovals: Set<string>;
  projectRoot: string;
}

// --- Rule parsing ---

function parseRule(ruleStr: string): PermissionRule {
  // Format: "ToolName" or "ToolName(pattern)"
  const match = ruleStr.match(/^([^(]+?)(?:\((.+)\))?$/);
  if (!match) return { toolName: ruleStr };
  return {
    toolName: match[1].trim(),
    ruleContent: match[2]?.trim(),
  };
}

function loadPermissionsConfig(cwd: string): PermissionsConfig {
  const config: PermissionsConfig = { allow: [], deny: [], ask: [] };

  const files = [
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
    path.join(cwd, ".pi", "settings.json"),
  ];

  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home) {
    files.unshift(path.join(home, ".claude", "settings.json"));
  }

  for (const file of files) {
    try {
      const content = JSON.parse(fs.readFileSync(file, "utf8"));
      const perms = content.permissions;
      if (!perms) continue;

      if (Array.isArray(perms.allow)) {
        config.allow.push(...perms.allow.map(parseRule));
      }
      if (Array.isArray(perms.deny)) {
        config.deny.push(...perms.deny.map(parseRule));
      }
      if (Array.isArray(perms.ask)) {
        config.ask.push(...perms.ask.map(parseRule));
      }
    } catch {
      // File doesn't exist or is malformed
    }
  }

  return config;
}

// --- Rule matching ---

function matchesGlob(pattern: string, value: string): boolean {
  // Convert glob to regex: * → [^ ]*, ** → .*, ? → .
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^ ]*")
    .replace(/<<GLOBSTAR>>/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${escaped}$`).test(value);
  } catch {
    return pattern === value;
  }
}

function ruleMatchesTool(rule: PermissionRule, toolName: string, toolInput: Record<string, unknown>): boolean {
  // Tool name must match
  if (rule.toolName !== toolName && !matchesGlob(rule.toolName, toolName)) {
    return false;
  }

  // If no ruleContent, matches all invocations of this tool
  if (!rule.ruleContent) return true;

  // Match ruleContent against tool-specific input
  switch (toolName) {
    case "bash": {
      const command = String(toolInput.command || "");
      return matchesGlob(rule.ruleContent, command);
    }
    case "write":
    case "edit":
    case "read": {
      const filePath = String(toolInput.file_path || toolInput.path || "");
      return matchesGlob(rule.ruleContent, filePath);
    }
    default: {
      // For MCP tools (mcp__server__tool) or others, match against first string arg
      const firstArg = Object.values(toolInput).find((v) => typeof v === "string");
      return firstArg ? matchesGlob(rule.ruleContent, firstArg as string) : false;
    }
  }
}

type RuleDecision = "allow" | "deny" | "ask" | "none";

function evaluateRules(config: PermissionsConfig, toolName: string, toolInput: Record<string, unknown>): RuleDecision {
  // Deny takes highest precedence
  for (const rule of config.deny) {
    if (ruleMatchesTool(rule, toolName, toolInput)) return "deny";
  }

  // Then ask
  for (const rule of config.ask) {
    if (ruleMatchesTool(rule, toolName, toolInput)) return "ask";
  }

  // Then allow
  for (const rule of config.allow) {
    if (ruleMatchesTool(rule, toolName, toolInput)) return "allow";
  }

  return "none";
}

// --- Built-in safety fallbacks (when no rules configured) ---

const SAFE_EXACT = new Set(["pwd", "whoami", "date", "printenv", "uname", "id", "ls"]);
const SAFE_PREFIXES = ["cat ", "ls ", "echo ", "head ", "tail ", "wc ", "file ", "which ", "type ", "env "];
const DANGEROUS_PATTERNS = [
  /rm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r|--force|--recursive)/,
  /git\s+push\s+.*--force/,
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-[a-zA-Z]*f/,
  /git\s+checkout\s+--\s/,
  />\s*\/dev\/sd/,
  /dd\s+if=/,
  /mkfs\./,
  /chmod\s+-R\s+777/,
  /curl.*\|\s*(bash|sh|zsh)/,
  /wget.*\|\s*(bash|sh|zsh)/,
];

function builtinBashDecision(command: string): RuleDecision {
  const trimmed = command.trim();
  if (SAFE_EXACT.has(trimmed)) return "allow";
  if (SAFE_PREFIXES.some((p) => trimmed.startsWith(p))) return "allow";
  if (DANGEROUS_PATTERNS.some((p) => p.test(command))) return "deny";
  return "ask";
}

function isInsideProject(filePath: string, projectRoot: string): boolean {
  const resolved = path.resolve(filePath);
  const root = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
  return resolved === projectRoot || resolved.startsWith(root);
}

// --- Extension ---

export default function permissions(pi: ExtensionAPI) {
  pi.registerFlag("dangerously-skip-permissions", {
    description: "Skip all permission checks and auto-approve every tool call (Claude Code compatible flag)",
    type: "boolean",
    default: false,
  });

  const state: PermissionsState = {
    config: { allow: [], deny: [], ask: [] },
    sessionApprovals: new Set(),
    projectRoot: process.cwd(),
  };

  function resetSession(cwd: string) {
    state.projectRoot = cwd;
    state.sessionApprovals.clear();
    state.config = loadPermissionsConfig(cwd);
  }

  pi.on("session_start", async (_event, ctx) => {
    resetSession(ctx.cwd);
  });

  pi.on("session_switch", async (_event, ctx) => {
    resetSession(ctx.cwd);
  });

  const hasUserRules = () =>
    state.config.allow.length > 0 || state.config.deny.length > 0 || state.config.ask.length > 0;

  // Main permission handler
  pi.on("tool_call", async (event, ctx) => {
    if (pi.getFlag("--dangerously-skip-permissions")) return;

    const toolName = event.toolName;
    const toolInput = (event.input ?? {}) as Record<string, unknown>;

    // Build a key for session approval tracking
    const approvalKey = toolName === "bash"
      ? `bash:${String(toolInput.command || "")}`
      : `${toolName}:${String(toolInput.file_path || toolInput.path || "")}`;

    if (state.sessionApprovals.has(approvalKey)) return;

    let decision: RuleDecision;

    if (hasUserRules()) {
      // Use configured rules
      decision = evaluateRules(state.config, toolName, toolInput);
    } else {
      // Fall back to built-in rules
      if (toolName === "bash") {
        decision = builtinBashDecision(String(toolInput.command || ""));
      } else if (toolName === "write" || toolName === "edit") {
        const filePath = String(toolInput.file_path || toolInput.path || "");
        decision = filePath && !isInsideProject(filePath, state.projectRoot) ? "ask" : "allow";
      } else {
        decision = "allow";
      }
    }

    switch (decision) {
      case "allow":
        return;

      case "deny":
        return {
          block: true,
          reason: `Denied by permission rule for ${toolName}`,
        };

      case "ask": {
        const displayInput = toolName === "bash"
          ? String(toolInput.command || "")
          : String(toolInput.file_path || toolInput.path || toolName);

        const choice = await ctx.ui.select(
          `Allow ${toolName}?\n\n  ${displayInput}`,
          ["Allow once", "Allow for session", "Deny"]
        );

        if (choice === "Deny" || choice === undefined) {
          return { block: true, reason: `User denied ${toolName} execution.` };
        }

        if (choice === "Allow for session") {
          state.sessionApprovals.add(approvalKey);
        }
        return;
      }

      case "none":
        // No rule matched and no built-in rule — allow by default
        return;
    }
  });
}
