#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args[0] !== "acp") {
  process.stderr.write(`Unexpected args: ${args.join(" ")}\n`);
  process.exit(2);
}

const skipPermissions = args.includes("--dangerously-skip-permissions");
const appDataFlag = args.indexOf("--app-data-dir");
const appDataDir = appDataFlag >= 0 && args[appDataFlag + 1]
  ? args[appDataFlag + 1]
  : process.env.ANTIGRAVITY_DATA_DIR?.split(",")[0]?.trim() || "antigravity-cli";
const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR?.trim() || join(homedir(), ".gemini");
const appDataRoot = join(geminiDir, appDataDir);
const fixtureMode = process.env.ANTIGRAVITY_FIXTURE || "";

function send(value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
}

function ensureSummary(sessionId, cwd) {
  mkdirSync(appDataRoot, { recursive: true });
  const db = new DatabaseSync(join(appDataRoot, "conversation_summaries.db"));
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id text PRIMARY KEY,
      workspace_uris text NOT NULL,
      parent_conversation_id text NOT NULL DEFAULT '',
      nesting_depth integer NOT NULL DEFAULT 0,
      app_data_dir text NOT NULL DEFAULT ''
    )`);
    db.prepare(
      "INSERT OR REPLACE INTO conversation_summaries (conversation_id, workspace_uris, parent_conversation_id, nesting_depth, app_data_dir) VALUES (?, ?, '', 0, ?)",
    ).run(sessionId, JSON.stringify([pathToFileURL(cwd).href]), appDataDir);
  } finally {
    db.close();
  }
}

function appendTranscript(sessionId, records) {
  const dir = join(appDataRoot, "brain", sessionId, ".system_generated", "logs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "transcript.jsonl");
  appendFileSync(file, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

const sessions = new Map();
let pendingPermission = null;
let activeCancel = null;
let nextPermId = 0;

function requestPermission(sessionId, toolCall) {
  return new Promise((resolve) => {
    const id = `perm_${++nextPermId}`;
    pendingPermission = { id, resolve };
    send({
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall,
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });
  });
}

async function handlePrompt(id, params) {
  const sessionId = String(params.sessionId || "");
  const state = sessions.get(sessionId);
  if (!state) {
    send({ id, error: { code: -32000, message: "Unknown session" } });
    return;
  }
  const promptBlocks = Array.isArray(params.prompt) ? params.prompt : [];
  const textPrompt = promptBlocks.filter((b) => b.type === "text").map((b) => String(b.text || "")).join("\n");
  const images = promptBlocks.filter((b) => b.type === "image").length;

  let cancelled = false;
  let cancelResolve = null;
  activeCancel = () => {
    cancelled = true;
    cancelResolve?.();
  };

  if (textPrompt.includes("sleep:")) {
    const ms = Number(/sleep:(\d+)/.exec(textPrompt)?.[1] || 2000);
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working..." } } } });
    await new Promise((resolve) => {
      cancelResolve = resolve;
      setTimeout(resolve, ms);
    });
    activeCancel = null;
    send({ id, result: { stopReason: cancelled ? "cancelled" : "end_turn", usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 12 } } });
    return;
  }

  let toolOutcome = "none";
  if (textPrompt.includes("need-cmd")) {
    const toolCall = {
      sessionUpdate: "tool_call",
      toolCallId: "call_cmd_1",
      name: "run_command",
      kind: "execute",
      title: "echo hello",
      args: { CommandLine: "echo hello", toolSummary: "Echo hello" },
      rawInput: { CommandLine: "echo hello", toolSummary: "Echo hello" },
      status: "in_progress",
    };
    send({ method: "session/update", params: { sessionId, update: toolCall } });
    let approved = skipPermissions;
    if (!approved) {
      const response = await requestPermission(sessionId, { ...toolCall, status: "pending" });
      approved = response?.outcome?.outcome === "selected" && response?.outcome?.optionId === "allow";
    }
    toolOutcome = approved ? "allowed" : "denied";
    send({
      method: "session/update",
      params: {
        sessionId,
        update: {
          ...toolCall,
          sessionUpdate: "tool_call_update",
          status: approved ? "completed" : "failed",
          rawOutput: approved ? "hello" : "denied by user",
        },
      },
    });
  } else if (textPrompt.includes("need-edit")) {
    const toolCall = {
      sessionUpdate: "tool_call",
      toolCallId: "call_edit_1",
      name: "edit_file",
      kind: "edit",
      title: "Edit a.ts",
      args: { Path: "/workspace/a.ts" },
      rawInput: { Path: "/workspace/a.ts" },
      locations: [{ path: "/workspace/a.ts" }],
      status: "in_progress",
    };
    send({ method: "session/update", params: { sessionId, update: toolCall } });
    const response = await requestPermission(sessionId, { ...toolCall, status: "pending" });
    const approved = response?.outcome?.outcome === "selected" && response?.outcome?.optionId === "allow";
    toolOutcome = approved ? "edit-allowed" : "edit-denied";
    send({
      method: "session/update",
      params: {
        sessionId,
        update: { ...toolCall, sessionUpdate: "tool_call_update", status: approved ? "completed" : "failed", rawOutput: toolOutcome },
      },
    });
  } else if (textPrompt.includes("with-read")) {
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "plan" } } } });
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading" } } } });
    send({
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "c1", name: "read_file", kind: "read", title: "Read a.txt", rawInput: { Path: "a.txt" }, status: "in_progress" },
      },
    });
    send({
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId: "c1", name: "read_file", kind: "read", title: "Read a.txt", rawInput: { Path: "a.txt" }, status: "completed", rawOutput: "ok" },
      },
    });
  }

  const reply = [
    state.history ? "history retained" : "no history",
    `mode:${state.mode}`,
    `model:${state.model}`,
    `effort:${state.effort}`,
    ...(images ? [`images:${images}`] : []),
    ...(toolOutcome !== "none" ? [`perm:${toolOutcome}`] : []),
    ...(skipPermissions ? ["skip:1"] : []),
  ].join(" ");

  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } } });

  const now = new Date().toISOString();
  appendTranscript(sessionId, [
    { step_index: state.step++, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: now, content: `<USER_REQUEST>\n${textPrompt}\n</USER_REQUEST>` },
    { step_index: state.step++, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: now, model: state.model, input_tokens: 12, cache_read_tokens: 2, output_tokens: 5, content: reply },
  ]);

  activeCancel = null;
  send({
    id,
    result: {
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 5, cachedReadTokens: 2, cachedWriteTokens: 0, totalTokens: 19 },
    },
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let idx = buffer.indexOf("\n"); idx >= 0; idx = buffer.indexOf("\n")) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);

    if (pendingPermission && String(msg.id) === pendingPermission.id && ("result" in msg || "error" in msg)) {
      const resolver = pendingPermission.resolve;
      pendingPermission = null;
      resolver(msg.result);
      continue;
    }

    if (msg.method === "initialize") {
      send({
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} },
            _meta: { antigravity: { systemPrompt: { append: true } } },
          },
          agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" },
        },
      });
      continue;
    }

    if (msg.method === "session/new") {
      const sessionId = randomUUID();
      const cwd = String(msg.params?.cwd || process.cwd());
      const append = String(msg.params?._meta?.antigravity?.systemPrompt?.append || "");
      const hasHistory = append.includes("<cohub_session_history>") && append.includes("historical fact");
      sessions.set(sessionId, { cwd, mode: "default", model: "gemini-4-neon", effort: "high", history: hasHistory, step: 0 });
      ensureSummary(sessionId, cwd);
      const availableModels = fixtureMode === "no-models"
        ? []
        : [
            { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
            { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
            { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
            { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
            { modelId: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
            { modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
            { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
          ];
      const configOptions = fixtureMode === "no-models"
        ? []
        : [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "gemini-4-neon",
              options: [
                { value: "gemini-4-neon", name: "Gemini 4 Neon" },
                { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
                { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
              ],
            },
            {
              id: "thought_level",
              name: "Thinking Level",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
                { value: "xhigh", name: "Extra" },
              ],
            },
          ];
      send({
        id: msg.id,
        result: {
          sessionId,
          models: { availableModels, currentModelId: "gemini-4-neon-high" },
          modes: {
            currentModeId: "default",
            availableModes: [
              { id: "default", name: "Default" },
              { id: "accept-edits", name: "Accept edits" },
              { id: "auto", name: "Auto" },
              { id: "plan", name: "Plan" },
            ],
          },
          configOptions,
        },
      });
      continue;
    }

    if (msg.method === "session/resume") {
      const sessionId = String(msg.params?.sessionId || "");
      const cwd = String(msg.params?.cwd || process.cwd());
      if (fixtureMode === "resume-fail") {
        send({ id: msg.id, error: { code: -32004, message: "session not found" } });
        continue;
      }
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { cwd, mode: "default", model: "gemini-4-neon", effort: "high", history: true, step: 2 });
      }
      send({ id: msg.id, result: { sessionId, models: { currentModelId: "gemini-4-neon-high" } } });
      continue;
    }

    if (msg.method === "session/set_mode") {
      const state = sessions.get(String(msg.params?.sessionId || ""));
      if (state) state.mode = String(msg.params?.modeId || "default");
      send({ id: msg.id, result: {} });
      continue;
    }

    if (msg.method === "session/set_config_option") {
      const state = sessions.get(String(msg.params?.sessionId || ""));
      if (state) {
        if (msg.params?.configId === "model") state.model = String(msg.params?.value || state.model);
        if (msg.params?.configId === "thought_level") state.effort = String(msg.params?.value || state.effort);
      }
      send({ id: msg.id, result: {} });
      continue;
    }

    if (msg.method === "session/prompt") {
      void handlePrompt(msg.id, msg.params || {});
      continue;
    }

    if (msg.method === "session/cancel") {
      activeCancel?.();
      continue;
    }

    if (msg.method === "session/close") {
      send({ id: msg.id, result: {} });
    }
  }
});
