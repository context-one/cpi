import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";

/**
 * MCP (Model Context Protocol) Extension for cpi
 *
 * Reads .mcp.json config, spawns stdio/HTTP MCP servers,
 * registers their tools with pi, manages server lifecycle.
 *
 * Config locations (merged in order):
 * - ~/.claude/.mcp.json (user-level)
 * - .mcp.json (project-level)
 * - .pi/mcp.json (pi-specific)
 */

// --- Types ---

interface McpServerConfig {
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface McpServer {
  name: string;
  config: McpServerConfig;
  process?: ChildProcess;
  tools: McpTool[];
  requestId: number;
  pendingRequests: Map<number, {
    resolve: (r: JsonRpcResponse) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  buffer: string;
  ready: boolean;
}

const MCP_PROTOCOL_VERSION = "2025-11-25";
const REQUEST_TIMEOUT = 30_000;
const INIT_TIMEOUT = 10_000;

// --- Environment variable expansion ---

function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    const parts = expr.split(":-");
    const varName = parts[0];
    const defaultValue = parts.length > 1 ? parts.slice(1).join(":-") : undefined;
    return process.env[varName] ?? defaultValue ?? "";
  });
}

function expandConfigEnv(config: McpServerConfig): McpServerConfig {
  const expanded = { ...config };
  if (expanded.command) expanded.command = expandEnvVars(expanded.command);
  if (expanded.args) expanded.args = expanded.args.map(expandEnvVars);
  if (expanded.url) expanded.url = expandEnvVars(expanded.url);
  if (expanded.env) {
    expanded.env = Object.fromEntries(
      Object.entries(expanded.env).map(([k, v]) => [k, expandEnvVars(v)])
    );
  }
  if (expanded.headers) {
    expanded.headers = Object.fromEntries(
      Object.entries(expanded.headers).map(([k, v]) => [k, expandEnvVars(v)])
    );
  }
  return expanded;
}

// --- Config loading ---

function loadMcpConfig(cwd: string): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  const home = process.env.HOME || process.env.USERPROFILE || "";

  const files = [
    path.join(home, ".claude", ".mcp.json"),
    path.join(cwd, ".mcp.json"),
    path.join(cwd, ".pi", "mcp.json"),
  ];

  for (const file of files) {
    try {
      const content = JSON.parse(fs.readFileSync(file, "utf8")) as McpConfig;
      if (content.mcpServers) {
        for (const [name, config] of Object.entries(content.mcpServers)) {
          servers[name] = expandConfigEnv(config);
        }
      }
    } catch {
      // File doesn't exist or is malformed
    }
  }

  return servers;
}

// --- JSON-RPC over stdio ---

function sendRequest(server: McpServer, method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
  const id = ++server.requestId;
  const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.pendingRequests.delete(id);
      reject(new Error(`MCP request ${method} timed out after ${REQUEST_TIMEOUT}ms`));
    }, REQUEST_TIMEOUT);

    server.pendingRequests.set(id, { resolve, reject, timer });

    if (server.config.type === "stdio" && server.process?.stdin) {
      server.process.stdin.write(JSON.stringify(request) + "\n");
    } else if (server.config.type === "http" || server.config.type === "sse") {
      httpRequest(server, request).then(resolve).catch(reject);
      clearTimeout(timer);
      server.pendingRequests.delete(id);
    }
  });
}

function sendNotification(server: McpServer, method: string, params?: Record<string, unknown>): void {
  const notification = { jsonrpc: "2.0" as const, method, params };
  if (server.config.type === "stdio" && server.process?.stdin) {
    server.process.stdin.write(JSON.stringify(notification) + "\n");
  }
}

function handleStdoutData(server: McpServer, data: string): void {
  server.buffer += data;
  const lines = server.buffer.split("\n");
  server.buffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (msg.id !== undefined && server.pendingRequests.has(msg.id)) {
        const pending = server.pendingRequests.get(msg.id)!;
        clearTimeout(pending.timer);
        server.pendingRequests.delete(msg.id);
        pending.resolve(msg);
      }
    } catch {
      // Non-JSON output from server — ignore
    }
  }
}

// --- HTTP transport ---

function httpRequest(server: McpServer, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(server.config.url!);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      ...server.config.headers,
    };

    const body = JSON.stringify(request);

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        timeout: REQUEST_TIMEOUT,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON from MCP server ${server.name}: ${data.slice(0, 200)}`));
          }
        });
      }
    );

    req.on("error", (err) => reject(new Error(`MCP HTTP error (${server.name}): ${err.message}`)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`MCP HTTP timeout (${server.name})`));
    });

    req.write(body);
    req.end();
  });
}

// --- Server lifecycle ---

async function startStdioServer(name: string, config: McpServerConfig): Promise<McpServer> {
  const server: McpServer = {
    name,
    config,
    tools: [],
    requestId: 0,
    pendingRequests: new Map(),
    buffer: "",
    ready: false,
  };

  const child = spawn(config.command!, config.args || [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...config.env },
  });

  server.process = child;

  child.stdout?.on("data", (data: Buffer) => {
    handleStdoutData(server, data.toString());
  });

  child.stderr?.on("data", () => {
    // MCP servers may log to stderr — ignore
  });

  child.on("error", (err) => {
    // Reject all pending requests
    for (const [id, pending] of server.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP server ${name} crashed: ${err.message}`));
    }
    server.pendingRequests.clear();
    server.ready = false;
  });

  child.on("close", () => {
    server.ready = false;
    for (const [, pending] of server.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP server ${name} exited`));
    }
    server.pendingRequests.clear();
  });

  return server;
}

function startHttpServer(name: string, config: McpServerConfig): McpServer {
  return {
    name,
    config,
    tools: [],
    requestId: 0,
    pendingRequests: new Map(),
    buffer: "",
    ready: false,
  };
}

async function initializeServer(server: McpServer): Promise<void> {
  const initTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`MCP server ${server.name} init timed out`)), INIT_TIMEOUT)
  );

  const init = sendRequest(server, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "cpi", version: "0.1.0" },
  });

  const response = await Promise.race([init, initTimeout]);

  if (response.error) {
    throw new Error(`MCP server ${server.name} init failed: ${response.error.message}`);
  }

  sendNotification(server, "notifications/initialized");
  server.ready = true;
}

async function discoverTools(server: McpServer): Promise<McpTool[]> {
  const response = await sendRequest(server, "tools/list");
  if (response.error) {
    throw new Error(`MCP tools/list failed for ${server.name}: ${response.error.message}`);
  }

  const tools = (response.result?.tools as McpTool[]) || [];
  server.tools = tools;
  return tools;
}

async function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
  const response = await sendRequest(server, "tools/call", {
    name: toolName,
    arguments: args,
  });

  if (response.error) {
    return {
      content: [{ type: "text", text: `MCP error: ${response.error.message}` }],
      isError: true,
    };
  }

  const result = response.result || {};
  return {
    content: (result.content as Array<{ type: string; text: string }>) || [
      { type: "text", text: JSON.stringify(result) },
    ],
    isError: (result.isError as boolean) || false,
  };
}

function shutdownServer(server: McpServer): void {
  for (const [, pending] of server.pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error("MCP server shutting down"));
  }
  server.pendingRequests.clear();
  server.ready = false;

  if (server.process) {
    server.process.stdin?.end();
    const proc = server.process;
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGTERM");
    }, 2000);
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5000);
  }
}

// --- Extension ---

export default function mcp(pi: ExtensionAPI) {
  const servers = new Map<string, McpServer>();

  async function startAllServers(cwd: string, notify: (msg: string, level: "info" | "warning" | "error") => void) {
    const configs = loadMcpConfig(cwd);
    const serverNames = Object.keys(configs);

    if (serverNames.length === 0) return;

    notify(`Starting ${serverNames.length} MCP server(s)...`, "info");

    const startups = serverNames.map(async (name) => {
      const config = configs[name];
      try {
        let server: McpServer;
        if (config.type === "stdio") {
          if (!config.command) {
            notify(`MCP server ${name}: missing command`, "warning");
            return;
          }
          server = await startStdioServer(name, config);
        } else if (config.type === "http" || config.type === "sse") {
          if (!config.url) {
            notify(`MCP server ${name}: missing url`, "warning");
            return;
          }
          server = startHttpServer(name, config);
        } else {
          notify(`MCP server ${name}: unknown type ${config.type}`, "warning");
          return;
        }

        await initializeServer(server);
        const tools = await discoverTools(server);
        servers.set(name, server);

        // Register each MCP tool with pi
        for (const tool of tools) {
          const mcpToolName = `mcp__${name}__${tool.name}`;
          pi.registerTool({
            name: mcpToolName,
            label: `${tool.name} (MCP: ${name})`,
            description: tool.description,
            promptSnippet: `MCP tool from ${name}: ${tool.description}`,
            parameters: tool.inputSchema as any,
            async execute(_toolCallId, params) {
              if (!server.ready) {
                throw new Error(`MCP server ${name} is not connected`);
              }
              const result = await callTool(server, tool.name, params);
              if (result.isError) {
                throw new Error(result.content.map((c) => c.text).join("\n"));
              }
              return {
                content: result.content,
                details: { mcpServer: name, mcpTool: tool.name },
              };
            },
          });
        }

        notify(`MCP server ${name}: ${tools.length} tool(s) registered`, "info");
      } catch (err) {
        notify(`MCP server ${name} failed: ${err}`, "warning");
      }
    });

    await Promise.allSettled(startups);
  }

  function stopAllServers() {
    for (const [, server] of servers) {
      shutdownServer(server);
    }
    servers.clear();
  }

  pi.on("session_start", async (_event, ctx) => {
    stopAllServers();
    await startAllServers(ctx.cwd, (msg, level) => ctx.ui.notify(msg, level));
  });

  pi.on("session_switch", async (_event, ctx) => {
    stopAllServers();
    await startAllServers(ctx.cwd, (msg, level) => ctx.ui.notify(msg, level));
  });

  pi.on("session_shutdown", async () => {
    stopAllServers();
  });

  pi.registerCommand("mcp", {
    description: "Show MCP server status and registered tools",
    handler: async (_args, ctx) => {
      if (servers.size === 0) {
        const configs = loadMcpConfig(ctx.cwd);
        if (Object.keys(configs).length === 0) {
          ctx.ui.notify("No MCP servers configured.\nAdd servers to .mcp.json or .pi/mcp.json", "info");
        } else {
          ctx.ui.notify(
            `${Object.keys(configs).length} MCP server(s) configured but not running.\nRestart session to connect.`,
            "info"
          );
        }
        return;
      }

      const lines: string[] = ["MCP Servers:", ""];
      for (const [name, server] of servers) {
        const status = server.ready ? "connected" : "disconnected";
        lines.push(`  ${name} (${server.config.type}) — ${status}`);
        for (const tool of server.tools) {
          lines.push(`    mcp__${name}__${tool.name}: ${tool.description}`);
        }
        lines.push("");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
