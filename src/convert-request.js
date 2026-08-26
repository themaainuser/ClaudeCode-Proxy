/**
 * Anthropic -> OpenAI-compatible request conversion.
 *
 * Pure functions: no environment access, no I/O. Model forcing and the
 * token-headroom math live here but take explicit parameters so callers
 * (and tests) supply the configured values.
 */

import { makeId } from "./ids.js";
import { DEFAULT_MIN_ANSWER_TOKENS } from "./config.js";

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

/**
 * Convert a full Anthropic Messages request body into an OpenAI-compatible
 * chat/completions body.
 *
 * `options.model` is REQUIRED: the upstream model is forced from config and
 * Claude Code's requested model name must never reach Zen. Reasoning models
 * stream reasoning as `reasoning_content`, but its tokens usually share the
 * same max_tokens budget as the answer, so headroom is reserved below.
 */
export function anthropicToOpenAI(
  body,
  { model, minAnswerTokens = DEFAULT_MIN_ANSWER_TOKENS } = {},
) {
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
  // If Claude Code's requested budget (or the extended-thinking budget it
  // asked for) leaves no headroom, a verbose reasoning model can burn the
  // entire budget "thinking" and hit finish_reason=length before emitting a
  // single answer token -> Claude Code shows the reasoning and then nothing
  // else. Reserve headroom for a real answer beyond whatever thinking budget
  // was requested.
  const requestedMaxTokens = Number.isFinite(body.max_tokens) ? body.max_tokens : 4096;
  const thinkingBudget = Number.isFinite(body?.thinking?.budget_tokens) ? body.thinking.budget_tokens : 0;

  const out = {
    model,
    messages,
    max_tokens: Math.max(requestedMaxTokens, thinkingBudget + minAnswerTokens),
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
