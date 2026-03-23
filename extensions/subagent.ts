import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * Subagent Extension for cpi
 *
 * Provides Claude Code-like subagent support:
 * - Agent tool for the LLM to spawn autonomous subagents
 * - Event-bus API for other extensions to spawn background agents
 * - Agent definitions from markdown files in ~/.pi/agents/ or .pi/agents/
 */

// --- Types ---

interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
}

interface SubagentRequest {
  prompt: string;
  description?: string;
  agentType?: string;
  model?: string;
  cwd?: string;
  background?: boolean;
  onOutput?: (text: string) => void;
  onComplete?: (result: SubagentResult) => void;
}

interface SubagentResult {
  success: boolean;
  output: string;
  error?: string;
  agentId: string;
}

interface RunningAgent {
  id: string;
  description: string;
  process: ChildProcess;
  startTime: number;
  chunks: string[];
  resolve: (result: SubagentResult) => void;
}

const MAX_CONCURRENT = 4;
const MAX_TOTAL = 8;
const DEFAULT_TIMEOUT = 300_000;

// --- Agent definition discovery ---

function discoverAgentDefs(cwd: string): Map<string, AgentDefinition> {
  const agents = new Map<string, AgentDefinition>();
  const home = process.env.HOME || process.env.USERPROFILE || "";

  const dirs = [
    path.join(home, ".pi", "agent", "agents"),
    path.join(cwd, ".pi", "agents"),
  ];

  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), "utf8");
        const def = parseAgentDef(content, path.basename(file, ".md"));
        if (def) agents.set(def.name, def);
      }
    } catch {
      // Directory doesn't exist or is unreadable
    }
  }

  return agents;
}

function parseAgentDef(
  content: string,
  fallbackName: string
): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const def: AgentDefinition = { name: fallbackName, description: "" };

  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!value) continue;

    switch (key) {
      case "name":
        def.name = value;
        break;
      case "description":
        def.description = value;
        break;
      case "model":
        def.model = value;
        break;
      case "tools":
        def.tools = value
          .replace(/[\[\]"']/g, "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        break;
    }
  }

  return def;
}

// --- Extension ---

export default function subagent(pi: ExtensionAPI) {
  let projectCwd = process.cwd();
  let agentCounter = 0;
  let activeCount = 0;
  const runningAgents = new Map<string, RunningAgent>();
  const queue: Array<() => void> = [];

  function processQueue(): void {
    while (queue.length > 0 && activeCount < MAX_CONCURRENT) {
      const next = queue.shift();
      if (next) next();
    }
  }

  function spawnSubagent(
    request: SubagentRequest,
    cwd: string
  ): Promise<SubagentResult> {
    const agentId = `agent-${++agentCounter}-${Date.now().toString(36)}`;
    const totalPending = runningAgents.size + queue.length;

    if (totalPending >= MAX_TOTAL) {
      return Promise.resolve({
        success: false,
        output: "",
        error: `Maximum subagents (${MAX_TOTAL}) reached. Wait for some to complete.`,
        agentId,
      });
    }

    return new Promise<SubagentResult>((resolve) => {
      const start = () => {
        activeCount++;
        const agentType = request.agentType || request.description || "subagent";

        const args = ["--mode", "print", "--no-session"];
        if (request.model) args.push("--model", request.model);
        args.push("-p", request.prompt);

        const child = spawn("pi", args, {
          cwd: request.cwd || cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            CPI_SUBAGENT_DEPTH: String(
              Number(process.env.CPI_SUBAGENT_DEPTH || "0") + 1
            ),
          },
          timeout: DEFAULT_TIMEOUT,
        });

        const agent: RunningAgent = {
          id: agentId,
          description: request.description || "subagent",
          process: child,
          startTime: Date.now(),
          chunks: [],
          resolve,
        };

        runningAgents.set(agentId, agent);

        pi.events.emit("subagent:start", {
          agent_id: agentId,
          agent_type: agentType,
        });

        child.stdout?.on("data", (data: Buffer) => {
          const text = data.toString();
          agent.chunks.push(text);
          request.onOutput?.(text);
        });

        child.stderr?.on("data", (data: Buffer) => {
          agent.chunks.push(data.toString());
        });

        let finished = false;
        const finish = (success: boolean, error?: string) => {
          if (finished) return;
          finished = true;
          activeCount--;
          runningAgents.delete(agentId);

          const output = agent.chunks.join("").trim();
          const result: SubagentResult = {
            success,
            output,
            error,
            agentId,
          };

          pi.events.emit("subagent:stop", {
            agent_id: agentId,
            agent_type: agentType,
            last_assistant_message: output.slice(-500),
            success,
          });

          request.onComplete?.(result);
          resolve(result);
          processQueue();
        };

        child.on("close", (code) => {
          finish(code === 0, code !== 0 ? `Subagent exited with code ${code}` : undefined);
        });

        child.on("error", (err) => {
          finish(false, `Subagent failed: ${err.message}`);
        });
      };

      if (activeCount >= MAX_CONCURRENT) {
        queue.push(start);
      } else {
        start();
      }
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    projectCwd = ctx.cwd;
  });

  pi.events.on(
    "subagent:spawn",
    async (request: SubagentRequest & { _resolve?: (r: SubagentResult) => void }) => {
      const result = await spawnSubagent(request, projectCwd);
      request._resolve?.(result);
    }
  );

  pi.events.on("subagent:spawn-async", (request: SubagentRequest) => {
    spawnSubagent(request, projectCwd);
  });

  pi.registerTool({
    name: "agent",
    label: "Agent",
    description:
      "Launch a subagent to handle a task autonomously. Subagents run in separate processes with their own context.",
    promptSnippet: "Launch autonomous subagents for complex tasks",
    promptGuidelines: [
      "Use for tasks that benefit from isolated context or parallel execution",
      "Provide clear, complete prompts — subagents start with no prior context",
      "Use background mode for independent tasks you don't need results from immediately",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "The task for the subagent to perform" }),
      description: Type.Optional(Type.String({ description: "Short description (3-5 words)" })),
      model: Type.Optional(Type.String({ description: "Model override for this subagent" })),
      background: Type.Optional(Type.Boolean({ description: "Run in background (default: false)" })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate) {
      const depth = Number(process.env.CPI_SUBAGENT_DEPTH || "0");
      if (depth >= 3) {
        return {
          content: [{ type: "text", text: "Maximum subagent nesting depth (3) reached." }],
          details: { blocked: true },
        };
      }

      const request: SubagentRequest = {
        prompt: params.prompt,
        description: params.description,
        model: params.model,
        background: params.background,
      };

      if (params.background) {
        spawnSubagent(request, projectCwd);
        return {
          content: [{ type: "text", text: `Background subagent launched: ${params.description || "task"}` }],
          details: { background: true },
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `Running subagent: ${params.description || "task"}...` }],
      });

      const result = await spawnSubagent(request, projectCwd);
      if (!result.success) throw new Error(result.error || "Subagent failed");

      return {
        content: [{ type: "text", text: result.output }],
        details: { agentId: result.agentId, success: result.success },
      };
    },
  });

  pi.registerCommand("agents", {
    description: "List available agent definitions and running agents",
    handler: async (_args, ctx) => {
      const defs = discoverAgentDefs(ctx.cwd);
      const lines: string[] = [];

      if (runningAgents.size > 0) {
        lines.push("Running agents:");
        for (const [, agent] of runningAgents) {
          const elapsed = Math.round((Date.now() - agent.startTime) / 1000);
          lines.push(`  ${agent.id}: ${agent.description} (${elapsed}s)`);
        }
        lines.push("");
      }

      if (defs.size > 0) {
        lines.push("Available agent definitions:");
        for (const [, def] of defs) {
          lines.push(`  ${def.name}: ${def.description}`);
        }
      } else {
        lines.push("No agent definitions found.");
        lines.push("Add .md files to ~/.pi/agent/agents/ or .pi/agents/");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("session_shutdown", async () => {
    for (const [, agent] of runningAgents) {
      agent.process.kill("SIGTERM");
    }
    runningAgents.clear();
  });
}

export type { SubagentRequest, SubagentResult };
