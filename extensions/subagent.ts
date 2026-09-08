import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type {
  SubagentDelegationRequest,
  SubagentDelegationResponse,
  SubagentDelegationUpdate,
} from "pi-subagents/delegation";

// Public event contract: the separately installed companion owns the runtime.
// Keep imports type-only; a companion is not a Node dependency of this package.
const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
const SUBAGENT_DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
const SUBAGENT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";

/** Compatibility bridge for CPI extensions. pi-subagents owns the model-facing
 * subagent tool, agent discovery, execution, concurrency and result delivery. */
export interface SubagentRequest {
  prompt: string;
  description?: string;
  agentType?: string;
  model?: string;
  cwd?: string;
  context?: "fresh" | "fork";
  background?: boolean;
  onOutput?: (text: string) => void;
  onComplete?: (result: SubagentResult) => void;
}

export interface SubagentResult {
  success: boolean;
  output: string;
  error?: string;
  agentId: string;
}

const TIMEOUT_MS = 300_000;

export default function subagent(pi: ExtensionAPI) {
  // Detached children load ambient extensions. They must not become another
  // owner of CPI's orchestration bridge or start recursive memory extraction.
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  let context: ExtensionContext | undefined;
  const pending = new Map<string, () => void>();

  function reset() {
    context = undefined;
    for (const cancel of [...pending.values()]) cancel();
  }

  pi.on("session_start", (_event, ctx) => {
    reset();
    context = ctx;
  });
  pi.on("session_switch", (_event, ctx) => {
    reset();
    context = ctx;
  });
  pi.on("session_shutdown", reset);

  function spawn(request: SubagentRequest): Promise<SubagentResult> {
    const agentId = randomUUID();
    if (!context || !pi.getAllTools().some((tool) => tool.name === "subagent")) {
      return Promise.resolve({
        success: false, output: "", agentId,
        error: "pi-subagents is unavailable. Install CPI's companion packages and reload Pi.",
      });
    }

    const delegation: SubagentDelegationRequest = {
      requestId: agentId,
      ownerRunId: `cpi:${context.sessionManager.getSessionId()}`,
      nodeId: agentId,
      agent: request.agentType || "delegate",
      task: request.prompt,
      context: request.context || "fresh",
      cwd: request.cwd || context.cwd,
      model: request.model,
      timeoutMs: TIMEOUT_MS,
      result: { kind: "text" },
    };
    const agentType = request.agentType || request.description || "subagent";

    return new Promise((resolve) => {
      let settled = false;
      const matches = (response: { requestId: string; ownerRunId?: string; nodeId?: string }) =>
        response.requestId === delegation.requestId &&
        response.ownerRunId === delegation.ownerRunId && response.nodeId === delegation.nodeId;
      const finish = (result: SubagentResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribeResponse();
        unsubscribeUpdate();
        pending.delete(agentId);
        pi.events.emit("subagent:stop", {
          agent_id: agentId, agent_type: agentType,
          last_assistant_message: result.output.slice(-500),
          success: result.success, error: result.error,
        });
        resolve(result);
      };
      const cancel = (error: string) => {
        // Settle locally first: upstream cancellation may reply synchronously.
        finish({ success: false, output: "", error, agentId });
        pi.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, {
          requestId: agentId, ownerRunId: delegation.ownerRunId, nodeId: delegation.nodeId,
        });
      };
      const unsubscribeResponse = pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (data) => {
        const response = data as SubagentDelegationResponse;
        if (!matches(response)) return;
        const output = "result" in response && response.result?.kind === "text" ? response.result.text || "" : "";
        finish({
          success: response.status === "completed", output, agentId,
          error: response.status === "completed" ? undefined : response.error || response.status,
        });
      });
      const unsubscribeUpdate = pi.events.on(SUBAGENT_DELEGATION_UPDATE_EVENT, (data) => {
        const update = data as SubagentDelegationUpdate;
        if (matches(update) && update.recentOutput) request.onOutput?.(update.recentOutput);
      });
      // Also bounds requests when the upstream extension disappears on reload.
      const timer = setTimeout(() => cancel("Subagent timed out"), TIMEOUT_MS + 1_000);
      pending.set(agentId, () => cancel("CPI session changed or shut down"));
      pi.events.emit("subagent:start", { agent_id: agentId, agent_type: agentType });
      pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, delegation);
    });
  }

  async function dispatch(request: SubagentRequest & { _resolve?: (r: SubagentResult) => void }) {
    const result = await spawn(request);
    // A consumer callback must not prevent the awaited event contract settling.
    request._resolve?.(result);
    request.onComplete?.(result);
  }

  pi.events.on("subagent:spawn", dispatch);
  pi.events.on("subagent:spawn-async", dispatch);
}
