import assert from "node:assert/strict";
import { test } from "node:test";
import bridge from "../extensions/subagent.ts";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT as REQUEST,
  SUBAGENT_DELEGATION_RESPONSE_EVENT as RESPONSE,
  SUBAGENT_DELEGATION_CANCEL_EVENT as CANCEL,
} from "pi-subagents/delegation";

function harness(available = true) {
  const listeners = new Map<string, Set<(data: any) => any>>();
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  const events = {
    on(name: string, fn: (data: any) => any) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
      return () => listeners.get(name)!.delete(fn);
    },
    emit(name: string, data: any) {
      for (const fn of [...(listeners.get(name) || [])]) fn(data);
    },
  };
  const pi = { events, on: (name: string, fn: any) => handlers.set(name, fn),
    getAllTools: () => available ? [{ name: "subagent" }] : [] };
  bridge(pi as any);
  function start(cwd = "/fixture/one") {
    handlers.get("session_start")!({}, { cwd, sessionManager: { getSessionId: () => cwd } });
  }
  const spawn = (request: any = {}, channel = "subagent:spawn") => new Promise<any>((resolve) => {
    events.emit(channel, { prompt: "fixture task", ...request, _resolve: resolve });
  });
  start();
  return { events, handlers, listeners, spawn, start };
}

test("concurrent requests correlate results and retain CPI lifecycle callbacks", async () => {
  const h = harness();
  const requests: any[] = [], stops: any[] = [];
  h.events.on(REQUEST, (data) => requests.push(data));
  h.events.on("subagent:stop", (data) => stops.push(data));
  let completed = 0;
  const first = h.spawn({ context: "fork", model: "fixture/model", onComplete: () => completed++ });
  const second = h.spawn({}, "subagent:spawn-async");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].context, "fork");
  assert.equal(requests[0].model, "fixture/model");
  assert.equal(requests[0].agent, "delegate");
  h.events.emit(RESPONSE, { ...requests[0], ownerRunId: "wrong-owner", status: "completed" });
  h.events.emit(RESPONSE, { ...requests[1], status: "failed", error: "child failed" });
  h.events.emit(RESPONSE, { ...requests[0], status: "completed", result: { kind: "text", text: "first result" } });
  assert.equal((await first).output, "first result");
  assert.equal((await second).error, "child failed");
  assert.equal(completed, 1);
  assert.equal(stops.length, 2);
  assert.equal(h.listeners.get(RESPONSE)!.size, 0);
});

test("session switch cancels old requests and uses the new working directory", async () => {
  const h = harness();
  const requests: any[] = [], cancellations: any[] = [];
  h.events.on(REQUEST, (data) => requests.push(data));
  h.events.on(CANCEL, (data) => cancellations.push(data));
  const old = h.spawn();
  h.handlers.get("session_switch")!({}, { cwd: "/fixture/two", sessionManager: { getSessionId: () => "two" } });
  assert.equal((await old).success, false);
  assert.equal(cancellations[0].requestId, requests[0].requestId);
  const next = h.spawn();
  assert.equal(requests[1].cwd, "/fixture/two");
  assert.equal(requests[1].ownerRunId, "cpi:two");
  h.handlers.get("session_shutdown")!({});
  assert.equal((await next).success, false);
  assert.equal(h.listeners.get(RESPONSE)!.size, 0);
});

test("missing companion fails promptly and delivers onComplete", async () => {
  const h = harness(false);
  let callback: any;
  const result = await h.spawn({ onComplete: (value: any) => { callback = value; } });
  assert.equal(result.success, false);
  assert.match(result.error, /pi-subagents is unavailable/);
  assert.equal(callback, result);
});

test("child runtime does not register an orchestration bridge", () => {
  const previous = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    bridge({ on: () => assert.fail("registered child handler"), events: { on: () => assert.fail("registered child listener") } } as any);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previous;
  }
});
