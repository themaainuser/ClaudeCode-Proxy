/**
 * OpenAI-compatible response -> Anthropic response conversion.
 *
 * Pure functions: no environment access, no I/O.
 */

import { makeId } from "./ids.js";

export function mapFinishReason(reason) {
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

export function parseToolArguments(value) {
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

export function openAIMessageToAnthropic(message) {
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

export function openAIToAnthropic(data, requestedModel, fallbackModel) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  const usage = data?.usage || {};

  return {
    id: data?.id || makeId("msg"),
    type: "message",
    role: "assistant",
    model: requestedModel || fallbackModel,
    content: openAIMessageToAnthropic(message),
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || 0),
    },
  };
}
