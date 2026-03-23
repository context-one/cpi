import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Project Init Extension for cpi
 *
 * `/init` command that bootstraps a project for use with cpi.
 * Respects and integrates with existing Claude Code configuration.
 */

function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function listMdFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

interface ClaudeAssets {
  settings: Record<string, unknown> | null;
  localSettings: Record<string, unknown> | null;
  commands: string[];
  rules: string[];
  hasHooks: boolean;
}

function discoverClaudeAssets(claudeDir: string): ClaudeAssets {
  const settings = readJsonSafe(path.join(claudeDir, "settings.json"));
  const localSettings = readJsonSafe(path.join(claudeDir, "settings.local.json"));

  return {
    settings,
    localSettings,
    commands: listMdFiles(path.join(claudeDir, "commands")),
    rules: listMdFiles(path.join(claudeDir, "rules")),
    hasHooks: settings?.hooks != null && Object.keys(settings.hooks as object).length > 0,
  };
}

function writeIfNew(filePath: string, content: string): boolean {
  try {
    fs.writeFileSync(filePath, content, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export default function init(pi: ExtensionAPI) {
  pi.registerCommand("init", {
    description: "Initialize this project for cpi — sets up .pi/ and integrates with existing .claude/ config",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const created: string[] = [];
      const skipped: string[] = [];
      const integrated: string[] = [];

      // 1. Create .pi/ directory structure
      const piDir = path.join(cwd, ".pi");
      const piExisted = fs.existsSync(piDir);
      fs.mkdirSync(path.join(piDir, "extensions"), { recursive: true });
      fs.mkdirSync(path.join(piDir, "skills"), { recursive: true });
      fs.mkdirSync(path.join(piDir, "prompts"), { recursive: true });

      if (piExisted) {
        skipped.push(".pi/ (already exists)");
      } else {
        created.push(".pi/");
      }

      // 2. Discover existing .claude/ assets (once)
      const claudeDir = path.join(cwd, ".claude");
      const claude = discoverClaudeAssets(claudeDir);

      // 3. Create .pi/settings.json
      const defaultSettings: Record<string, unknown> = {};
      if (claude.commands.length > 0) {
        defaultSettings.skills = [".claude/commands"];
      }

      if (writeIfNew(
        path.join(piDir, "settings.json"),
        JSON.stringify(defaultSettings, null, 2) + "\n"
      )) {
        created.push(".pi/settings.json");
      } else {
        skipped.push(".pi/settings.json (already exists)");
      }

      // 4. Report existing context files
      if (fs.existsSync(path.join(cwd, "CLAUDE.md"))) {
        integrated.push("CLAUDE.md (pi reads this automatically)");
      }
      if (fs.existsSync(path.join(cwd, "AGENTS.md"))) {
        integrated.push("AGENTS.md (pi reads this automatically)");
      }

      // 5. Report .claude/ integration
      if (claude.settings) {
        integrated.push(".claude/settings.json (hooks-compat reads hooks from here)");
      }
      if (claude.localSettings) {
        integrated.push(".claude/settings.local.json (hooks-compat reads hooks from here)");
      }
      if (claude.commands.length > 0) {
        integrated.push(`.claude/commands/ (${claude.commands.length} commands → pi skills)`);
      }
      if (claude.rules.length > 0) {
        integrated.push(`.claude/rules/ (${claude.rules.length} rules — loaded via CLAUDE.md)`);
      }
      if (claude.hasHooks) {
        integrated.push(".claude/settings.json hooks (hooks-compat extension handles these)");
      }

      // 6. Create .pi/.gitignore
      if (writeIfNew(
        path.join(piDir, ".gitignore"),
        "settings.local.json\nplans/\n"
      )) {
        created.push(".pi/.gitignore");
      }

      // 7. Check project .gitignore
      try {
        const gitignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
        if (!gitignore.includes(".pi/") && !gitignore.includes(".pi\n")) {
          skipped.push(".gitignore (.pi/ not listed — add it if you want local-only config)");
        }
      } catch {
        // No .gitignore
      }

      // 8. Report
      const lines: string[] = ["cpi project initialized!", ""];

      if (created.length > 0) {
        lines.push("Created:");
        for (const item of created) lines.push(`  + ${item}`);
        lines.push("");
      }

      if (integrated.length > 0) {
        lines.push("Integrated (existing config preserved):");
        for (const item of integrated) lines.push(`  ~ ${item}`);
        lines.push("");
      }

      if (skipped.length > 0) {
        lines.push("Skipped:");
        for (const item of skipped) lines.push(`  - ${item}`);
        lines.push("");
      }

      lines.push("Run `cpi` to start coding.");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("clear", {
    description: "Clear conversation and start a new session",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const entries = ctx.sessionManager.getEntries();
      if (entries.length === 0) return;
      const header = entries.find((e: any) => e.type === "header");
      const sessionPath = (header as any)?.sessionFile;
      if (sessionPath) {
        ctx.ui.notify(
          `Resume this session with: cpi --session ${sessionPath}`,
          "info"
        );
      }
    } catch {
      // Session info not available
    }
  });
}
