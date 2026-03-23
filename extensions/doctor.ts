import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Doctor Extension for cpi
 *
 * `/doctor` command that validates the cpi installation and configuration.
 * Checks prerequisites, settings, hooks, memory, MCP, and rules.
 */

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
}

function checkCommand(cmd: string): string | null {
  try {
    return execFileSync("which", [cmd], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function checkVersion(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export default function doctor(pi: ExtensionAPI) {
  pi.registerCommand("doctor", {
    description: "Diagnose cpi installation and configuration issues",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const checks: Check[] = [];
      const home = process.env.HOME || process.env.USERPROFILE || "";

      // 1. Node.js version
      const nodeVersion = checkVersion("node", ["--version"]);
      if (!nodeVersion) {
        checks.push({ name: "Node.js", status: "fail", message: "not found" });
      } else {
        const major = parseInt(nodeVersion.replace("v", ""));
        checks.push({
          name: "Node.js",
          status: major >= 20 ? "ok" : "fail",
          message: `${nodeVersion}${major < 20 ? " (need >= 20)" : ""}`,
        });
      }

      // 2. pi installed
      const piPath = checkCommand("pi");
      if (!piPath) {
        checks.push({ name: "pi", status: "fail", message: "not found — run: npm install -g @mariozechner/pi-coding-agent" });
      } else {
        const piVersion = checkVersion("pi", ["--version"]);
        checks.push({ name: "pi", status: "ok", message: `${piVersion || "installed"} (${piPath})` });
      }

      // 3. git installed
      const gitPath = checkCommand("git");
      checks.push({
        name: "git",
        status: gitPath ? "ok" : "warn",
        message: gitPath ? "installed" : "not found",
      });

      // 4. Global settings
      const globalSettings = path.join(home, ".pi", "agent", "settings.json");
      const settings = readJsonSafe(globalSettings);
      if (!settings) {
        checks.push({ name: "Global settings", status: "warn", message: `${globalSettings} — not found or invalid` });
      } else {
        const packages = (settings.packages as string[]) || [];
        const hasCpi = packages.includes("@context-one/cpi");
        checks.push({
          name: "Global settings",
          status: hasCpi ? "ok" : "warn",
          message: hasCpi ? "cpi package registered" : "cpi package NOT in packages list",
        });
      }

      // 5. cpi package directory
      const sluggedCwd = cwd.replace(/[/\\]/g, "-");
      const piAgentDir = path.join(home, ".pi", "agent");
      const cpiPkgDir = path.join(piAgentDir, "packages", "cpi");
      checks.push({
        name: "cpi package",
        status: fs.existsSync(cpiPkgDir) ? "ok" : "warn",
        message: fs.existsSync(cpiPkgDir) ? cpiPkgDir : "not installed — run install.sh",
      });

      // 6. Memory directory
      const memoryDir = path.join(piAgentDir, "projects", sluggedCwd, "memory");
      const memoryIndex = path.join(memoryDir, "MEMORY.md");
      if (fs.existsSync(memoryDir)) {
        const fileCount = fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").length;
        checks.push({ name: "Memory", status: "ok", message: `${fileCount} files, index: ${fs.existsSync(memoryIndex) ? "exists" : "missing"}` });
      } else {
        checks.push({ name: "Memory", status: "ok", message: "not yet initialized (will create on first use)" });
      }

      // 7. Hooks config
      const claudeSettings = path.join(cwd, ".claude", "settings.json");
      const claudeConfig = readJsonSafe(claudeSettings);
      if (claudeConfig?.hooks) {
        const hookCount = Object.keys(claudeConfig.hooks as object).length;
        checks.push({ name: "Hooks", status: "ok", message: `${hookCount} hook event(s) in .claude/settings.json` });
      } else {
        checks.push({ name: "Hooks", status: "ok", message: "no hooks configured" });
      }

      // 8. Permission rules
      const hasPermissions = claudeConfig?.permissions != null;
      const piSettings = readJsonSafe(path.join(cwd, ".pi", "settings.json"));
      const hasPiPerms = piSettings?.permissions != null;
      if (hasPermissions || hasPiPerms) {
        checks.push({ name: "Permissions", status: "ok", message: "custom rules configured" });
      } else {
        checks.push({ name: "Permissions", status: "ok", message: "using built-in safety rules" });
      }

      // 9. MCP servers
      const mcpFiles = [
        path.join(cwd, ".mcp.json"),
        path.join(cwd, ".pi", "mcp.json"),
      ];
      let mcpServerCount = 0;
      for (const file of mcpFiles) {
        const config = readJsonSafe(file);
        if (config?.mcpServers) {
          mcpServerCount += Object.keys(config.mcpServers as object).length;
        }
      }
      checks.push({
        name: "MCP servers",
        status: "ok",
        message: mcpServerCount > 0 ? `${mcpServerCount} server(s) configured` : "none configured",
      });

      // 10. Rules
      const rulesDir = path.join(cwd, ".claude", "rules");
      let ruleCount = 0;
      try {
        ruleCount = fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md")).length;
      } catch {
        // No rules dir
      }
      checks.push({
        name: "Rules",
        status: "ok",
        message: ruleCount > 0 ? `${ruleCount} rule(s) in .claude/rules/` : "no rules",
      });

      // 11. CLAUDE.md
      const claudeMd = fs.existsSync(path.join(cwd, "CLAUDE.md")) || fs.existsSync(path.join(cwd, ".claude", "CLAUDE.md"));
      checks.push({
        name: "CLAUDE.md",
        status: claudeMd ? "ok" : "ok",
        message: claudeMd ? "found" : "not found (optional)",
      });

      // 12. .pi/ project directory
      const piDir = path.join(cwd, ".pi");
      checks.push({
        name: "Project .pi/",
        status: fs.existsSync(piDir) ? "ok" : "ok",
        message: fs.existsSync(piDir) ? "initialized" : "not initialized (run /init)",
      });

      // Format output
      const lines: string[] = ["cpi doctor", ""];
      let failCount = 0;
      let warnCount = 0;

      for (const check of checks) {
        const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗";
        lines.push(`  ${icon} ${check.name}: ${check.message}`);
        if (check.status === "fail") failCount++;
        if (check.status === "warn") warnCount++;
      }

      lines.push("");
      if (failCount > 0) {
        lines.push(`${failCount} error(s) found. Fix these before using cpi.`);
      } else if (warnCount > 0) {
        lines.push(`${warnCount} warning(s). cpi will work but some features may be limited.`);
      } else {
        lines.push("All checks passed.");
      }

      ctx.ui.notify(lines.join("\n"), failCount > 0 ? "error" : "info");
    },
  });
}
