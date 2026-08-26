/**
 * Claude Code -> OpenCode Zen v2 protocol adapter
 *
 * Purpose:
 *   Keep Claude Code as the harness (tools, agents, permissions, filesystem,
 *   subagents, MCP-facing tool calls, etc.) while using an OpenCode Zen
 *   OpenAI-compatible model as the inference backend.
 *
 * Default upstream:
 *   https://opencode.ai/zen/v1/chat/completions
 *
 * Default model:
 *   x-preview-f-free
 *
 * Requirements:
 *   Node.js 18+ (Node 20+ recommended)
 *
 * Windows / PowerShell:
 *   $env:ZEN_API_KEY="YOUR_ZEN_KEY"
 *   node .\claude-opencode-proxy-v2.mjs
 *
 * Then, in another terminal:
 *   $env:ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
 *   $env:ANTHROPIC_AUTH_TOKEN="local"
 *   claude
 *
 * Optional:
 *   $env:ZEN_MODEL="x-preview-f-free"
 *   $env:PORT="8787"
 *   $env:DEBUG="1"
 *   $env:DEBUG_REQUEST="1"
 *   $env:DEBUG_RESPONSE="1"
 *
 * IMPORTANT:
 *   x-preview-f-free is not currently listed in OpenCode's public Zen model
 *   directory, but the user's direct /v1/chat/completions request works.
 *   This adapter therefore treats it as an explicitly configured upstream
 *   model rather than relying on /v1/models discovery.
 */

import http from "node:http";
import crypto from "node:crypto";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const ZEN_URL = process.env.ZEN_BASE_URL || "https://opencode.ai/zen/v1/chat/completions";
const ZEN_MODEL = process.env.ZEN_MODEL || "x-preview-f-free";
const ZEN_API_KEY = process.env.ZEN_API_KEY || "";

const DEBUG = /^(1|true|yes)$/i.test(process.env.DEBUG || "");
const DEBUG_REQUEST = /^(1|true|yes)$/i.test(process.env.DEBUG_REQUEST || "");
const DEBUG_RESPONSE = /^(1|true|yes)$/i.test(process.env.DEBUG_RESPONSE || "");

function debug(...args) {
  if (DEBUG) console.error("[proxy]", ...args);
}

function debugRequest(...args) {
  if (DEBUG_REQUEST) console.error("[claude->proxy]", ...args);
}

function debugResponse(...args) {
  if (DEBUG_RESPONSE) console.error("[zen->proxy]", ...args);
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function json(res, status, body) {
  if (res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function anthropicError(res, status, type, message, extra = {}) {
  return json(res, status, {
    type: "error",
    error: {
      type,
      message,
      ...extra,
    },
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/* -------------------------------------------------------------------------- */
/* Anthropic -> OpenAI-compatible request conversion                          */
/* -------------------------------------------------------------------------- */

function textFromContent(content) {
  if (content == null) return "";

  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return String(content);

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (block.type === "text") return block.text || "";
      return "";
    })
    .filter(Boolean)
    .join("");
}

function openAIContentPartsFromAnthropic(content) {
  if (content == null) return "";

  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return String(content);

  const parts = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "text") {
      parts.push({
        type: "text",
        text: block.text || "",
      });
      continue;
    }

    if (block.type === "image") {
      const source = block.source || {};

      if (source.type === "base64" && source.data) {
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${source.media_type || "application/octet-stream"};base64,${source.data}`,
          },
        });
      } else if (source.type === "url" && source.url) {
        parts.push({
          type: "image_url",
          image_url: {
            url: source.url,
          },
        });
      }

      continue;
    }

    // Unknown blocks are deliberately ignored here. Anthropic server-side
    // tools are not portable to an OpenAI-compatible client-tool endpoint.
  }

  return parts.length ? parts : "";
}

function normalizeToolInput(input) {
  if (input == null) return {};
  if (typeof input === "object") return input;

  try {
    return JSON.parse(String(input));
  } catch {
    return {};
  }
}

function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return [];

  const result = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;

    // Anthropic has server-side tools (e.g. web search). Those cannot be
    // faithfully turned into client-side function tools. Claude Code's own
    // tools are normal named client tools and are converted below.
    if (tool.type && tool.type !== "custom" && !tool.input_schema) {
      continue;
    }

    if (!tool.name) continue;

    const fn = {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || {
        type: "object",
        properties: {},
      },
    };

    // Preserve strict where the upstream accepts it.
    if (tool.strict != null) fn.strict = Boolean(tool.strict);

    result.push({
      type: "function",
      function: fn,
    });
  }

  return result;
}

function toolChoiceToOpenAI(toolChoice) {
  if (!toolChoice) return undefined;

  switch (toolChoice.type) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "any":
      return "required";
    case "tool":
      if (toolChoice.name) {
        return {
          type: "function",
          function: { name: toolChoice.name },
        };
      }
      return "auto";
    default:
      return undefined;
  }
}

function assistantAnthropicBlocksToOpenAI(blocks) {
  const textParts = [];
  const toolCalls = [];

  for (const block of blocks || []) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "text") {
      if (block.text) textParts.push(block.text);
      continue;
    }

    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || makeId("call"),
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(normalizeToolInput(block.input)),
        },
      });
    }
  }

  const message = {
    role: "assistant",
    content: textParts.length ? textParts.join("") : null,
  };

  if (toolCalls.length) message.tool_calls = toolCalls;

  return message;
}

function convertUserBlocks(blocks) {
  const normalBlocks = [];
  const toolMessages = [];

  for (const block of blocks || []) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "tool_result") {
      toolMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: textFromContent(block.content),
      });
      continue;
    }

    if (block.type === "text" || block.type === "image" || block.type === "document") {
      normalBlocks.push(block);
    }
  }

  return { normalBlocks, toolMessages };
}

function anthropicMessagesToOpenAI(messages) {
  const result = [];

  for (const message of messages || []) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "assistant") {
      if (Array.isArray(message.content)) {
        result.push(assistantAnthropicBlocksToOpenAI(message.content));
      } else {
        result.push({
          role: "assistant",
          content: String(message.content ?? ""),
        });
      }
      continue;
    }

    if (message.role === "user") {
      if (Array.isArray(message.content)) {
        const { normalBlocks, toolMessages } = convertUserBlocks(message.content);

        // Tool messages must be individual OpenAI messages.
        result.push(...toolMessages);

        if (normalBlocks.length) {
          result.push({
            role: "user",
            content: openAIContentPartsFromAnthropic(normalBlocks),
          });
        }
      } else {
        result.push({
          role: "user",
          content: String(message.content ?? ""),
        });
      }

      continue;
    }

    // Defensive handling for future/unknown roles.
    result.push({
      role: message.role || "user",
      content: openAIContentPartsFromAnthropic(message.content),
    });
  }

  return result;
}

function systemToOpenAI(system) {
  if (!system) return null;

  if (typeof system === "string") return system;

  if (!Array.isArray(system)) return String(system);

  const parts = [];

  for (const block of system) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "text") {
      if (block.text) parts.push(block.text);
    }
  }

  return parts.join("\n\n");
}

function anthropicToOpenAI(body) {
  const messages = [];

  const system = systemToOpenAI(body.system);
  if (system) {
    messages.push({
      role: "system",
      content: system,
    });
  }

  messages.push(...anthropicMessagesToOpenAI(body.messages));

  // Deliberately force the upstream model. Claude Code's model name is a
  // harness-side selection and must not be sent to Zen in this setup.
  //
  // Reasoning models stream their reasoning as `reasoning_content`, but on
  // most OpenAI-compatible gateways (Zen included, as far as this adapter
  // can tell) reasoning tokens still count against the same `max_tokens`
  // budget as the final answer. If Claude Code's requested budget (or the
  // extended-thinking budget it asked for) leaves no headroom, a verbose
  // reasoning model can burn the entire budget "thinking" and hit
  // finish_reason=length before emitting a single answer token -> Claude
  // Code shows the reasoning and then nothing else. Reserve headroom for a
  // real answer beyond whatever thinking budget was requested.
  const requestedMaxTokens = Number.isFinite(body.max_tokens) ? body.max_tokens : 4096;
  const thinkingBudget = Number.isFinite(body?.thinking?.budget_tokens) ? body.thinking.budget_tokens : 0;
  const MIN_ANSWER_TOKENS = Number(process.env.ZEN_MIN_ANSWER_TOKENS || 1024);

  const out = {
    model: ZEN_MODEL,
    messages,
    max_tokens: Math.max(requestedMaxTokens, thinkingBudget + MIN_ANSWER_TOKENS),
    stream: true,
  };

  const tools = anthropicToolsToOpenAI(body.tools);
  if (tools.length) out.tools = tools;

  const toolChoice = toolChoiceToOpenAI(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;

  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;

  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    out.stop = body.stop_sequences;
  }

  // Some OpenAI-compatible providers support these fields. They are only
  // forwarded when Claude Code supplied them.
  if (body.seed != null) out.seed = body.seed;
  if (body.user != null) out.user = body.user;

  return out;
}

/* -------------------------------------------------------------------------- */
/* OpenAI-compatible -> Anthropic response conversion                         */
/* -------------------------------------------------------------------------- */

function mapFinishReason(reason) {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
    case null:
    case undefined:
      return "end_turn";
    default:
      return "end_turn";
  }
}

function parseToolArguments(value) {
  if (value == null || value === "") return {};

  if (typeof value === "object") return value;

  try {
    return JSON.parse(String(value));
  } catch {
    // Non-streaming OpenAI responses should normally contain valid JSON.
    // Returning the raw value keeps the adapter from crashing.
    return { _raw_arguments: String(value) };
  }
}

function openAIMessageToAnthropic(message) {
  const content = [];

  // Do NOT manufacture an Anthropic "thinking" block from reasoning_content.
  // Anthropic thinking blocks have signature semantics; inventing them would
  // produce invalid Claude-compatible messages. Keep provider reasoning out
  // of the public content stream unless explicitly configured later.
  if (message?.content) {
    if (typeof message.content === "string") {
      content.push({
        type: "text",
        text: message.content,
      });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "text" && part.text) {
          content.push({
            type: "text",
            text: part.text,
          });
        }
      }
    }
  }

  for (const call of message?.tool_calls || []) {
    const fn = call?.function || {};

    content.push({
      type: "tool_use",
      id: call?.id || makeId("toolu"),
      name: fn.name || "unknown_tool",
      input: parseToolArguments(fn.arguments),
    });
  }

  if (!content.length) {
    content.push({
      type: "text",
      text: "",
    });
  }

  return content;
}

function openAIToAnthropic(data, requestedModel) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  const usage = data?.usage || {};

  return {
    id: data?.id || makeId("msg"),
    type: "message",
    role: "assistant",
    model: requestedModel || ZEN_MODEL,
    content: openAIMessageToAnthropic(message),
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || 0),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Anthropic SSE writer                                                       */
/* -------------------------------------------------------------------------- */

class AnthropicStreamWriter {
  constructor(res, model) {
    this.res = res;
    this.model = model;
    this.started = false;
    this.messageId = null;
    this.nextIndex = 0;
    this.textIndex = null;
    this.tools = new Map();
    this.ended = false;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.thinkingIndex = null;
  }

  send(event, data) {
    if (this.ended || this.res.writableEnded) return;

    this.res.write(`event: ${event}\n`);
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  start(messageId, usage = {}) {
    if (this.started) return;

    this.started = true;
    this.messageId = messageId || makeId("msg");
    this.inputTokens = Number(usage.prompt_tokens || 0);

    this.send("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: this.inputTokens,
          output_tokens: 0,
        },
      },
    });
  }

  ensureTextBlock() {
    if (this.textIndex !== null) return this.textIndex;

    this.textIndex = this.nextIndex++;

    this.send("content_block_start", {
      type: "content_block_start",
      index: this.textIndex,
      content_block: {
        type: "text",
        text: "",
      },
    });

    return this.textIndex;
  }

  endThinking() {
    if (this.thinkingIndex === null) return;

    this.send("content_block_stop", {
      type: "content_block_stop",
      index: this.thinkingIndex,
    });

    this.thinkingIndex = null;
  }

  text(text) {
    this.endThinking();
    if (!text) return;

    this.start();
    const index = this.ensureTextBlock();

    this.send("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: {
        type: "text_delta",
        text,
      },
    });
  }

  thinking(text) {
    if (!text) return;

    this.start();

    if (this.thinkingIndex === null) {
      this.thinkingIndex = this.nextIndex++;

      this.send("content_block_start", {
        type: "content_block_start",
        index: this.thinkingIndex,
        content_block: {
          type: "thinking",
          thinking: "",
        },
      });
    }

    this.send("content_block_delta", {
      type: "content_block_delta",
      index: this.thinkingIndex,
      delta: {
        type: "thinking_delta",
        thinking: text,
      },
    });
  }

  toolDelta(call) {
    this.endThinking();

    if (!call) return;

    this.start();

    const sourceIndex = call.index ?? 0;
    let tool = this.tools.get(sourceIndex);

    if (!tool) {
      const blockIndex = this.nextIndex++;
      const id = call.id || makeId("toolu");
      const name = call.function?.name || "unknown_tool";

      tool = {
        blockIndex,
        id,
        name,
      };

      this.tools.set(sourceIndex, tool);

      this.send("content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id,
          name,
          input: {},
        },
      });
    }

    const args = call.function?.arguments;
    if (args) {
      this.send("content_block_delta", {
        type: "content_block_delta",
        index: tool.blockIndex,
        delta: {
          type: "input_json_delta",
          partial_json: String(args),
        },
      });
    }
  }

  closeBlocks() {
    if (this.thinkingIndex !== null) {
      this.send("content_block_stop", {
        type: "content_block_stop",
        index: this.thinkingIndex,
      });

      this.thinkingIndex = null;
    }

    // BUG (fixed): this never closed the text block. Every block that gets
    // a content_block_start MUST get a matching content_block_stop before
    // message_stop, or Claude Code never finalizes it into a normal
    // rendered reply - it stays "open" and effectively invisible outside
    // the raw thinking/debug view, even when real answer text was streamed.
    if (this.textIndex !== null) {
      this.send("content_block_stop", {
        type: "content_block_stop",
        index: this.textIndex,
      });

      this.textIndex = null;
    }

    for (const tool of this.tools.values()) {
      this.send("content_block_stop", {
        type: "content_block_stop",
        index: tool.blockIndex,
      });
    }
  }

  finish(reason, usage = {}) {
    if (this.ended) return;

    this.start();

    this.outputTokens = Number(usage.completion_tokens ?? this.outputTokens ?? 0);

    // If the model produced reasoning but the stream ended before any answer
    // text or tool call ever arrived, don't let the turn close silently as
    // an empty "success" - that's exactly the "thinking shows, then nothing"
    // symptom. Inject a visible note explaining what happened.
    const producedVisibleOutput = this.textIndex !== null || this.tools.size > 0;

    if (!producedVisibleOutput && this.thinkingIndex !== null) {
      const note =
        reason === "length"
          ? "[proxy] The model exhausted max_tokens while reasoning and never produced an answer. Increase max_tokens (or ZEN_MIN_ANSWER_TOKENS) and retry."
          : "[proxy] The upstream stream ended without producing any answer text (reason: " +
            String(reason) +
            "). This usually means the connection dropped or the upstream omitted finish_reason mid-answer.";

      this.text(note);
    }

    this.closeBlocks();

    this.send("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: mapFinishReason(reason),
        stop_sequence: null,
      },
      usage: {
        output_tokens: this.outputTokens,
      },
    });

    this.send("message_stop", {
      type: "message_stop",
    });

    this.ended = true;
    this.res.end();
  }

  error(type, message) {
    if (this.ended) return;

    this.send("error", {
      type: "error",
      error: {
        type,
        message,
      },
    });

    this.ended = true;
    this.res.end();
  }
}

/* -------------------------------------------------------------------------- */
/* OpenAI SSE parser                                                          */
/* -------------------------------------------------------------------------- */

class OpenAISSEParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = "";
  }

  feed(text) {
    this.buffer += text;

    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      this.consumeLine(line);
    }
  }

  end() {
    if (this.buffer.trim()) this.consumeLine(this.buffer);
    this.buffer = "";
  }

  consumeLine(line) {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:")) return;

    const payload = trimmed.slice(5).trim();

    if (!payload || payload === "[DONE]") {
      this.onEvent({ done: true });
      return;
    }

    try {
      this.onEvent({
        done: false,
        data: JSON.parse(payload),
      });
    } catch {
      debugResponse("Ignoring malformed SSE data:", payload);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Upstream request                                                           */
/* -------------------------------------------------------------------------- */

async function callZen(body) {
  const headers = {
    "content-type": "application/json",
    accept: body.stream ? "text/event-stream, application/json" : "application/json",
  };

  if (ZEN_API_KEY) {
    headers.authorization = `Bearer ${ZEN_API_KEY}`;
  }

  return fetch(ZEN_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function handleMessages(req, res) {
  const raw = await readBody(req);

  if (DEBUG_REQUEST) {
    console.error("\n========== CLAUDE REQUEST ==========");
    console.error(raw);
    console.error("========== END CLAUDE REQUEST ==========\n");
  }

  let body;

  try {
    body = JSON.parse(raw || "{}");
  } catch (err) {
    return anthropicError(res, 400, "invalid_request_error", `Invalid JSON: ${err.message}`);
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return anthropicError(res, 400, "invalid_request_error", "Claude request is missing a messages array.");
  }

  const outgoing = anthropicToOpenAI(body);

  if (DEBUG) {
    debug("Claude requested model:", body.model);
    debug("Forcing Zen model:", ZEN_MODEL);
    debug("stream:", outgoing.stream);
    debug("message count:", outgoing.messages.length);
    debug("tool count:", outgoing.tools?.length || 0);
  }

  if (DEBUG_REQUEST) {
    console.error("\n========== ZEN REQUEST ==========");
    console.error(JSON.stringify(outgoing, null, 2));
    console.error("========== END ZEN REQUEST ==========\n");
  }

  let upstream;

  try {
    upstream = await callZen(outgoing);
  } catch (err) {
    return anthropicError(
      res,
      502,
      "api_connection_error",
      `Could not connect to OpenCode Zen: ${err.message}`,
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text();

    debug("Zen HTTP error:", upstream.status, text);

    return anthropicError(
      res,
      upstream.status,
      "api_error",
      `OpenCode Zen returned HTTP ${upstream.status}: ${text}`,
    );
  }

  if (!body.stream) {
    // Claude requested a normal JSON response.
    // Zen is still streamed internally, so consume the entire SSE stream,
    // reconstruct the final assistant message, then return Anthropic JSON.

    let finalData = null;
    let finalMessage = {
      role: "assistant",
      content: "",
      tool_calls: [],
    };

    let finishReason = null;
    let usage = {};

    const parser = new OpenAISSEParser(({ done, data }) => {
      if (done || !data) return;

      if (DEBUG_RESPONSE) {
        console.error("[ZEN INTERNAL SSE]", JSON.stringify(data));
      }

      if (data.id && !finalData) {
        finalData = data;
      }

      if (data.usage) {
        usage = data.usage;
      }

      for (const choice of data.choices || []) {
        const delta = choice.delta || {};

        if (delta.content) {
          finalMessage.content += delta.content;
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const incomingCall of delta.tool_calls) {
            const index = incomingCall.index ?? 0;

            let call = finalMessage.tool_calls[index];

            if (!call) {
              call = {
                id: incomingCall.id || makeId("call"),
                type: "function",
                function: {
                  name: incomingCall.function?.name || "",
                  arguments: "",
                },
              };

              finalMessage.tool_calls[index] = call;
            }

            if (incomingCall.id) {
              call.id = incomingCall.id;
            }

            if (incomingCall.function?.name) {
              call.function.name = incomingCall.function.name;
            }

            if (incomingCall.function?.arguments) {
              call.function.arguments += incomingCall.function.arguments;
            }
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    });

    try {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();

        if (done) break;

        parser.feed(decoder.decode(value, { stream: true }));
      }

      parser.feed(decoder.decode());
      parser.end();
    } catch (err) {
      return anthropicError(res, 502, "api_error", `OpenCode Zen stream failed: ${err.message}`);
    }

    if (!finalData) {
      return anthropicError(res, 502, "api_error", "OpenCode Zen returned an empty stream.");
    }

    finalData.choices = [
      {
        index: 0,
        message: finalMessage,
        finish_reason: finishReason || "stop",
      },
    ];

    finalData.usage = usage;

    if (DEBUG_RESPONSE) {
      console.error("\n========== RECONSTRUCTED ZEN RESPONSE ==========");
      console.error(JSON.stringify(finalData, null, 2));
      console.error("========== END RECONSTRUCTED RESPONSE ==========\n");
    }

    const result = openAIToAnthropic(finalData, body.model || ZEN_MODEL);

    return json(res, 200, result);
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const writer = new AnthropicStreamWriter(res, body.model || ZEN_MODEL);
  let zenChunkCount = 0;

  if (DEBUG_RESPONSE) {
    console.error("\n========== ZEN SSE ==========");
  }

  if (!upstream.body) {
    writer.error("api_error", "OpenCode Zen returned no response body for a streaming request.");
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  let sawDone = false;
  let sawFinish = false;

  const parser = new OpenAISSEParser(({ done, data }) => {
    if (done) {
      sawDone = true;
      return;
    }

    if (!data) return;

    if (DEBUG_RESPONSE) {
      zenChunkCount++;

      console.error(`[ZEN SSE ${zenChunkCount}]`, JSON.stringify(data));
    }

    const choices = Array.isArray(data.choices) ? data.choices : [];

    if (!choices.length) {
      // Some OpenAI-compatible providers send usage-only chunks.
      if (data.usage) {
        writer.inputTokens = Number(data.usage.prompt_tokens || 0);
        writer.outputTokens = Number(data.usage.completion_tokens || 0);
      }
      return;
    }

    writer.start(data.id, data.usage || {});

    for (const choice of choices) {
      const delta = choice.delta || {};

      if (delta.reasoning_content) {
        writer.thinking(delta.reasoning_content);
      }
      if (delta.content) {
        writer.text(delta.content);
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) {
          writer.toolDelta(toolCall);
        }
      }

      if (choice.finish_reason) {
        sawFinish = true;
        writer.finish(choice.finish_reason, data.usage || {});
      }
    }
  });

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      parser.feed(decoder.decode(value, { stream: true }));

      if (writer.ended) break;
    }

    parser.feed(decoder.decode());
    parser.end();

    if (!writer.ended) {
      // Reaching here means the upstream never sent a finish_reason on any
      // chunk (sawFinish is always false at this point - if it had, the
      // inline writer.finish() call above would already have ended the
      // writer). Previously this branch always closed as a plain "stop"
      // regardless, which silently reported a truncated/dropped stream as a
      // normal successful empty turn. Report the real reason so Claude Code
      // (and finish()'s own truncation note, above) can reflect it.
      writer.finish(sawDone ? "stop" : "upstream_stream_ended_without_finish_reason");
    }
    if (DEBUG_RESPONSE) {
      console.error("========== END ZEN SSE ==========\n");
    }
  } catch (err) {
    debug("Streaming error:", err);

    if (!writer.ended) {
      writer.error("api_error", `OpenCode Zen stream failed: ${err.message}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Health / discovery endpoints                                               */
/* -------------------------------------------------------------------------- */

function fakeModel(id) {
  return {
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "local-opencode-proxy",
  };
}

function handleModels(res) {
  return json(res, 200, {
    object: "list",
    data: [
      // Claude Code can use this as a local/gateway-visible model identifier.
      // The proxy still forces ZEN_MODEL upstream.
      fakeModel("claude-sonnet-4-5"),
      fakeModel("claude-sonnet-4-6"),
      fakeModel(ZEN_MODEL),
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* HTTP server                                                                */
/* -------------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);

  console.log(
    `[INCOMING] ${req.method} ${url.pathname}${url.search} | ${req.headers["user-agent"] || "no-user-agent"}`,
  );

  // Claude Code uses /v1/messages and may append beta query parameters.
  if (req.method === "POST" && url.pathname === "/v1/messages") {
    try {
      await handleMessages(req, res);
    } catch (err) {
      console.error("[UNHANDLED /v1/messages ERROR]", err);

      if (!res.headersSent) {
        anthropicError(res, 500, "api_error", `Proxy error: ${err.message}`);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return handleModels(res);
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      proxy: "claude-opencode-proxy-v2",
      upstream: ZEN_URL,
      model: ZEN_MODEL,
      node: process.version,
    });
  }

  // Claude Code currently probes this path during startup in some versions.
  if (req.method === "HEAD" && url.pathname === "/api/hello") {
    res.writeHead(200);
    res.end();
    return;
  }

  json(res, 404, {
    error: "Not found",
    path: url.pathname,
    hint: "POST /v1/messages",
  });
});

server.on("clientError", (err, socket) => {
  debug("clientError:", err.message);
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("Claude Code <-> OpenCode Zen proxy v2");
  console.log("----------------------------------------");
  console.log(`Listening:   http://${HOST}:${PORT}`);
  console.log(`Zen URL:     ${ZEN_URL}`);
  console.log(`Zen model:   ${ZEN_MODEL}`);
  console.log(`Zen key:     ${ZEN_API_KEY ? "configured" : "NOT SET"}`);
  console.log("");
  console.log("Claude Code:");
  console.log(`  ANTHROPIC_BASE_URL=http://${HOST}:${PORT}`);
  console.log("  ANTHROPIC_AUTH_TOKEN=local");
  console.log("");
  console.log("Debug switches (off by default):");
  console.log("  DEBUG=1");
  console.log("  DEBUG_REQUEST=1");
  console.log("  DEBUG_RESPONSE=1");
  console.log("");
});
