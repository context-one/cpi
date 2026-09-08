import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import autoMemory from "../extensions/auto-memory.ts";

test("memory extraction forks the conversation and does not recurse in detached children", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpi-memory-test-"));
  const previousHome = process.env.HOME;
  const previousChild = process.env.PI_SUBAGENT_CHILD;
  process.env.HOME = root;
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    const handlers = new Map<string, any>();
    const requests: any[] = [];
    const ctx = { cwd: root, ui: { notify() {} } };
    autoMemory({
      on: (name: string, fn: any) => handlers.set(name, fn),
      registerCommand() {},
      events: { emit: (name: string, request: any) => { requests.push({ name, request }); } },
    } as any);
    await handlers.get("session_start")({}, ctx);
    for (let i = 0; i < 3; i++) await handlers.get("agent_end")({}, ctx);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].name, "subagent:spawn-async");
    assert.equal(requests[0].request.context, "fork");
    assert.equal(requests[0].request.cwd, root);
    process.env.PI_SUBAGENT_CHILD = "1";
    for (let i = 0; i < 3; i++) await handlers.get("agent_end")({}, ctx);
    assert.equal(requests.length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
    await rm(root, { recursive: true, force: true });
  }
});
