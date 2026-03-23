import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Rules/Instructions Loading Extension for cpi
 *
 * Discovers and loads .claude/rules/ and .pi/rules/ markdown files,
 * injecting them into the system prompt. Supports path-scoped rules
 * via YAML frontmatter with a "globs" field.
 */

interface Rule {
  filePath: string;
  description: string;
  globs: string[];
  content: string;
}

function parseRule(filePath: string): Rule | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const rule: Rule = {
    filePath,
    description: "",
    globs: [],
    content: raw,
  };

  // Parse optional YAML frontmatter
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (match) {
    const frontmatter = match[1];
    rule.content = match[2].trim();

    for (const line of frontmatter.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();

      if (key === "description") {
        rule.description = value;
      } else if (key === "globs") {
        // Parse YAML array: ["pattern1", "pattern2"] or bare values
        try {
          const parsed = JSON.parse(value);
          rule.globs = Array.isArray(parsed) ? parsed : [String(parsed)];
        } catch {
          rule.globs = value
            .replace(/[\[\]"']/g, "")
            .split(",")
            .map((g) => g.trim())
            .filter(Boolean);
        }
      }
    }
  }

  return rule;
}

function discoverRules(cwd: string): Rule[] {
  const rules: Rule[] = [];

  const dirs = [
    path.join(cwd, ".claude", "rules"),
    path.join(cwd, ".pi", "rules"),
  ];

  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir, { recursive: true }) as string[];
      for (const file of files) {
        if (!String(file).endsWith(".md")) continue;
        const rule = parseRule(path.join(dir, String(file)));
        if (rule) rules.push(rule);
      }
    } catch {
      // Directory doesn't exist
    }
  }

  return rules;
}

function matchesGlob(pattern: string, filePath: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*");
  try {
    return new RegExp(`^${escaped}$`).test(filePath);
  } catch {
    return false;
  }
}

function shouldLoadRule(rule: Rule, touchedFiles: Set<string>): boolean {
  // Rules without globs are always loaded
  if (rule.globs.length === 0) return true;

  // Rules with globs load only when matching files are touched
  for (const file of touchedFiles) {
    for (const glob of rule.globs) {
      if (matchesGlob(glob, file)) return true;
    }
  }
  return false;
}

export default function rules(pi: ExtensionAPI) {
  let allRules: Rule[] = [];
  let touchedFiles = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    allRules = discoverRules(ctx.cwd);
    touchedFiles.clear();
  });

  pi.on("session_switch", async (_event, ctx) => {
    allRules = discoverRules(ctx.cwd);
    touchedFiles.clear();
  });

  // Track which files the agent touches (for glob-scoped rules)
  pi.on("tool_result", async (event) => {
    const input = event.input as Record<string, unknown> | undefined;
    if (!input) return;
    const filePath = String(input.file_path || input.path || "");
    if (filePath) touchedFiles.add(filePath);
  });

  // Inject applicable rules into system prompt
  pi.on("before_agent_start", async (event) => {
    if (allRules.length === 0) return;

    const applicable = allRules.filter((r) => shouldLoadRule(r, touchedFiles));
    if (applicable.length === 0) return;

    const rulesBlock = applicable
      .map((r) => {
        const header = r.description
          ? `<!-- Rule: ${path.basename(r.filePath)} — ${r.description} -->`
          : `<!-- Rule: ${path.basename(r.filePath)} -->`;
        return `${header}\n${r.content}`;
      })
      .join("\n\n");

    return {
      systemPrompt: event.systemPrompt + `\n\n# Project Rules\n\n${rulesBlock}`,
    };
  });

  pi.registerCommand("rules", {
    description: "Show loaded rules and their scoping",
    handler: async (_args, ctx) => {
      allRules = discoverRules(ctx.cwd);

      if (allRules.length === 0) {
        ctx.ui.notify("No rules found.\nAdd .md files to .claude/rules/ or .pi/rules/", "info");
        return;
      }

      const lines: string[] = [`${allRules.length} rule(s) found:`, ""];
      for (const rule of allRules) {
        const scope = rule.globs.length > 0 ? `scoped: ${rule.globs.join(", ")}` : "global";
        const desc = rule.description ? ` — ${rule.description}` : "";
        lines.push(`  ${path.basename(rule.filePath)}${desc} (${scope})`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
