import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as crypto from "node:crypto";

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

// --- OAuth / PKCE ---

interface OAuthServerMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

interface TokenRecord {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // unix ms
}

const TOKEN_STORE_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".pi", "agent", "mcp-tokens.json"
);

function loadTokens(): Record<string, TokenRecord> {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveToken(serverUrl: string, record: TokenRecord): void {
  const tokens = loadTokens();
  tokens[serverUrl] = record;
  fs.mkdirSync(path.dirname(TOKEN_STORE_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(tokens, null, 2) + "\n");
}

function getToken(serverUrl: string): string | undefined {
  const record = loadTokens()[serverUrl];
  if (!record) return undefined;
  if (record.expires_at && Date.now() > record.expires_at - 60_000) return undefined; // expired
  return record.access_token;
}

function pkceVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

async function discoverOAuth(resourceUrl: string): Promise<OAuthServerMeta | null> {
  const base = new URL(resourceUrl).origin;
  for (const path_ of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    try {
      const res = await fetchJson(`${base}${path_}`);
      if (res?.authorization_endpoint) return res as OAuthServerMeta;
    } catch { /* try next */ }
  }
  return null;
}

function fetchJson(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const body = opts?.body ? Buffer.from(opts.body) : undefined;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts?.method || "GET",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(body ? { "Content-Length": body.length } : {}),
          ...opts?.headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Non-JSON response from ${url}: ${data.slice(0, 200)}`)); }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function registerClient(registrationEndpoint: string, redirectUri: string): Promise<{ client_id: string }> {
  const result = await fetchJson(registrationEndpoint, {
    method: "POST",
    body: JSON.stringify({
      client_name: "cpi",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!result.client_id) throw new Error(`Client registration failed: ${JSON.stringify(result)}`);
  return { client_id: result.client_id as string };
}

function startCallbackServer(port: number): {
  ready: Promise<void>;
  callback: Promise<{ code: string; state: string }>;
  close: () => void;
} {
  let resolveCallback: (v: { code: string; state: string }) => void;
  let rejectCallback: (e: Error) => void;
  let resolveReady: () => void;

  const ready = new Promise<void>((res) => { resolveReady = res; });
  const callback = new Promise<{ code: string; state: string }>((res, rej) => {
    resolveCallback = res;
    rejectCallback = rej;
  });

  let settled = false;
  const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

  const timer = setTimeout(() => {
    server.close();
    done(() => rejectCallback(new Error("OAuth login timed out after 5 minutes")));
  }, 5 * 60 * 1000);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://127.0.0.1:${port}`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body style="font-family:sans-serif;background:#000;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center">
        ${error
          ? `<h2 style="color:#f28779">Error: ${error}</h2>`
          : `<h2 style="color:#57c98a">Authenticated! You can close this tab.</h2>`}
      </div>
    </body></html>`);

    clearTimeout(timer);
    server.close();
    if (error) { done(() => rejectCallback(new Error(`OAuth error: ${error}`))); return; }
    if (code && state) done(() => resolveCallback({ code, state }));
  });

  server.on("error", (err) => { clearTimeout(timer); done(() => rejectCallback(err as Error)); });
  server.listen(port, "127.0.0.1", () => resolveReady());

  return { ready, callback, close: () => { clearTimeout(timer); server.close(); } };
}

async function oauthPkceFlow(serverUrl: string): Promise<string> {
  const meta = await discoverOAuth(serverUrl);
  if (!meta) throw new Error("Could not discover OAuth metadata from .well-known");

  // Pick a random callback port
  const port = 49152 + Math.floor(Math.random() * 16383);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // Dynamic client registration (if supported)
  let clientId = "cpi";
  if (meta.registration_endpoint) {
    const reg = await registerClient(meta.registration_endpoint, redirectUri);
    clientId = reg.client_id;
  }

  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);
  const state = crypto.randomBytes(16).toString("hex");

  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "read write");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  // Start callback server and wait until listening before opening browser
  const cb = startCallbackServer(port);
  await cb.ready;

  // Open browser using spawn to avoid shell metacharacter issues with & in URLs
  const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const openArgs = process.platform === "win32"
    ? ["/c", "start", "", authUrl.toString()]
    : [authUrl.toString()];
  spawn(openCmd, openArgs, { detached: true, stdio: "ignore" }).unref();

  const { code } = await cb.callback;

  // Exchange code for token
  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });

  const tokenRes = await fetchJson(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  });

  if (!tokenRes.access_token) throw new Error(`Token exchange failed: ${JSON.stringify(tokenRes)}`);

  const record: TokenRecord = {
    access_token: tokenRes.access_token as string,
    refresh_token: tokenRes.refresh_token as string | undefined,
    expires_at: tokenRes.expires_in
      ? Date.now() + (tokenRes.expires_in as number) * 1000
      : undefined,
  };
  saveToken(serverUrl, record);
  return record.access_token;
}

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

    const token = getToken(server.config.url!);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
    const msg = typeof response.error === "object"
      ? (response.error.message ?? JSON.stringify(response.error))
      : String(response.error);
    throw new Error(`MCP server ${server.name} init failed: ${msg}`);
  }

  sendNotification(server, "notifications/initialized");
  server.ready = true;
}

function mcpErrorMessage(error: JsonRpcResponse["error"]): string {
  if (!error) return "unknown error";
  if (typeof error === "object") return error.message ?? JSON.stringify(error);
  return String(error);
}

async function discoverTools(server: McpServer): Promise<McpTool[]> {
  const response = await sendRequest(server, "tools/list");
  if (response.error) {
    throw new Error(`MCP tools/list failed for ${server.name}: ${mcpErrorMessage(response.error)}`);
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

  async function addMcpServer(ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]) {
    const home = process.env.HOME || process.env.USERPROFILE || "";

    // Step 1: server name
    const name = await ctx.ui.input("Server name:", "e.g. my-server");
    if (!name?.trim()) { ctx.ui.notify("Cancelled.", "info"); return; }

    // Step 2: type
    const type = await ctx.ui.select("Server type:", ["stdio", "http"]);
    if (!type) { ctx.ui.notify("Cancelled.", "info"); return; }

    let config: McpServerConfig;

    if (type === "stdio") {
      const command = await ctx.ui.input("Command:", "e.g. npx -y @modelcontextprotocol/server-filesystem");
      if (!command?.trim()) { ctx.ui.notify("Cancelled.", "info"); return; }

      const argsRaw = await ctx.ui.input("Args (space-separated, optional):", "");
      const args = argsRaw?.trim() ? argsRaw.trim().split(/\s+/) : [];

      config = { type: "stdio", command: command.trim(), ...(args.length ? { args } : {}) };
    } else {
      const url = await ctx.ui.input("Server URL:", "e.g. http://localhost:3000/mcp");
      if (!url?.trim()) { ctx.ui.notify("Cancelled.", "info"); return; }
      config = { type: "http", url: url.trim() };
    }

    // Step 3: where to save
    const target = await ctx.ui.select("Save to:", [
      `Project  (.mcp.json in ${ctx.cwd})`,
      `Global   (~/.claude/.mcp.json)`,
    ]);
    if (!target) { ctx.ui.notify("Cancelled.", "info"); return; }

    const configPath = target.startsWith("Project")
      ? path.join(ctx.cwd, ".mcp.json")
      : path.join(home, ".claude", ".mcp.json");

    // Read existing config
    let existing: McpConfig = { mcpServers: {} };
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf8")) as McpConfig;
      existing.mcpServers = existing.mcpServers || {};
    } catch {
      // File doesn't exist yet — start fresh
    }

    if (existing.mcpServers[name.trim()]) {
      const overwrite = await ctx.ui.confirm(
        "Server already exists",
        `"${name.trim()}" is already configured. Overwrite?`
      );
      if (!overwrite) { ctx.ui.notify("Cancelled.", "info"); return; }
    }

    existing.mcpServers[name.trim()] = config;

    // Ensure parent dir exists
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");

    ctx.ui.notify(
      `Added "${name.trim()}" to ${configPath}\nRestart cpi (or open a new session) to connect.`,
      "info"
    );
  }

  pi.registerCommand("mcp", {
    description: "Manage MCP servers. Usage: /mcp [add|login [name]]",
    handler: async (args, ctx) => {
      const sub = args?.trim();

      if (sub === "add") {
        await addMcpServer(ctx);
        return;
      }

      if (sub?.startsWith("login")) {
        const serverName = sub.replace(/^login\s*/, "").trim();
        const configs = loadMcpConfig(ctx.cwd);

        // Resolve which server to log in to
        let targetName = serverName;
        if (!targetName) {
          const httpServers = Object.entries(configs).filter(([, c]) => c.type === "http" || c.type === "sse");
          if (httpServers.length === 0) {
            ctx.ui.notify("No HTTP MCP servers configured.", "warning");
            return;
          }
          if (httpServers.length === 1) {
            targetName = httpServers[0][0];
          } else {
            const pick = await ctx.ui.select("Which server?", httpServers.map(([n]) => n));
            if (!pick) return;
            targetName = pick;
          }
        }

        const config = configs[targetName];
        if (!config) {
          ctx.ui.notify(`Unknown server: ${targetName}`, "warning");
          return;
        }
        if (config.type !== "http" && config.type !== "sse") {
          ctx.ui.notify(`${targetName} is a stdio server — no OAuth needed.`, "info");
          return;
        }

        ctx.ui.notify(`Opening browser for ${targetName} login...`, "info");
        try {
          await oauthPkceFlow(config.url!);
          ctx.ui.notify(`Logged in to ${targetName}. Reconnecting...`, "info");
          // Restart the server connection
          const existing = servers.get(targetName);
          if (existing) shutdownServer(existing);
          servers.delete(targetName);
          await startAllServers(ctx.cwd, (msg, level) => ctx.ui.notify(msg, level));
        } catch (err) {
          ctx.ui.notify(`Login failed: ${err}`, "error");
        }
        return;
      }

      // Default: show status
      if (servers.size === 0) {
        const configs = loadMcpConfig(ctx.cwd);
        if (Object.keys(configs).length === 0) {
          ctx.ui.notify(
            "No MCP servers configured.\nRun /mcp add to add one, or edit .mcp.json manually.\nRun /mcp login to authenticate with an HTTP server.",
            "info"
          );
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
      lines.push('Run "/mcp add" to add a server, "/mcp login [name]" to authenticate.');

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
