import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";

test("Pi loads the companion and runs parallel children and CPI delegation", { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cpi-subagents-test-"));
  const agentDir = join(root, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: any;
  let server: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    if (session) {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown" });
      session.dispose();
    }
    server?.closeAllConnections();
    server?.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  let active = 0, peak = 0;
  const requests: any[] = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 200));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "fixture-result" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    active--;
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "local-test-only",
    models: [{ id: "fixture", contextWindow: 128000, maxTokens: 1024, reasoning: false }],
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "fixture", defaultModel: "fixture",
    packages: [resolve("."), resolve("node_modules/pi-subagents")],
  }));
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, createEventBus } =
    await import("@earendil-works/pi-coding-agent");
  const events = createEventBus();
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, eventBus: events,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const created = await createAgentSession({
    cwd: root, agentDir, resourceLoader: loader, modelRuntime: runtime,
    model: runtime.getModel("fixture", "fixture"),
    sessionManager: SessionManager.create(root, join(agentDir, "sessions")),
  });
  session = created.session;
  const { extensionsResult } = created;
  await session.bindExtensions({ mode: "rpc" });
  const tools = extensionsResult.extensions.flatMap((ext) => [...ext.tools.values()]);
  assert.equal(tools.filter((tool) => tool.definition.name === "subagent").length, 1);
  assert.equal(tools.filter((tool) => tool.definition.name === "agent").length, 0);
  const tool = tools.find((tool) => tool.definition.name === "subagent")!.definition;
  const ctx = session.extensionRunner.createContext();
  const result = await tool.execute("parallel-test", {
    workflowScript: 'return await runs.all([{key:"one",agent:"delegate",task:"first fixture task"},{key:"two",agent:"delegate",task:"second fixture task"}]);',
    async: false, context: "fresh", mission: false,
  }, new AbortController().signal, undefined, ctx);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.match(JSON.stringify(result), /fixture-result/);
  assert.equal(peak, 2, "child model requests must overlap");

  // Seed a parent turn to prove that extraction receives forked conversation.
  await session.prompt("PARENT_CONTEXT_MARKER", { expandPromptTemplates: false });
  const completion = new Promise<any>((resolve) => events.emit("subagent:spawn-async", {
    prompt: "Extract fixture context", context: "fork", onComplete: resolve,
  }));
  const extracted = await completion;
  assert.equal(extracted.success, true, JSON.stringify(extracted));
  assert.equal(extracted.output, "fixture-result");
  assert.ok(requests.at(-1).messages.some((message: any) => JSON.stringify(message).includes("PARENT_CONTEXT_MARKER")));
  // A detached child must complete and emit a result, not merely acknowledge launch.
  const backgroundComplete = new Promise<any>((resolve) => {
    const unsubscribe = events.on("subagent:async-complete", (data: any) => {
      unsubscribe();
      resolve(data);
    });
  });
  const launched = await tool.execute("background-test", {
    agent: "delegate", task: "background fixture task", async: true, context: "fresh", mission: false,
  }, new AbortController().signal, undefined, ctx);
  assert.equal(launched.isError, undefined, JSON.stringify(launched));
  const background = await backgroundComplete;
  assert.equal(background.success, true, JSON.stringify(background));
  assert.match(JSON.stringify(background), /fixture-result/);

});
