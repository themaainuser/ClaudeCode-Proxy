/**
 * Non-streaming path accumulator.
 *
 * Zen is always requested with stream:true; when Claude Code asked for a
 * plain JSON response, the proxy still consumes the upstream SSE internally
 * and reconstructs one complete OpenAI chat response out of the deltas.
 * This collector holds that merge logic (previously inline in the request
 * handler): content concatenation, tool_call merging by sparse index, and
 * last-write-wins usage / finish_reason tracking.
 */

import { makeId } from "./ids.js";

export class OpenAIStreamCollector {
  /**
   * @param {object} [options]
   * @param {() => string} [options.newCallId] id factory for tool calls that
   *   arrive without one (injectable for deterministic tests).
   */
  constructor({ newCallId = () => makeId("call") } = {}) {
    this.newCallId = newCallId;
    this.finalData = null;
    this.finalMessage = {
      role: "assistant",
      content: "",
      tool_calls: [],
    };
    this.finishReason = null;
    this.usage = {};
  }

  /** True once a chunk carrying an id has been seen ("empty stream" detection). */
  get started() {
    return this.finalData !== null;
  }

  /**
   * Consume one parsed OpenAI chunk object (the same shape the parser's
   * onEvent callback receives as `data`).
   */
  onChunk(data) {
    if (!data) return;

    if (data.id && !this.finalData) {
      this.finalData = data;
    }

    if (data.usage) {
      this.usage = data.usage;
    }

    for (const choice of data.choices || []) {
      const delta = choice.delta || {};

      if (delta.content) {
        this.finalMessage.content += delta.content;
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const incomingCall of delta.tool_calls) {
          const index = incomingCall.index ?? 0;

          let call = this.finalMessage.tool_calls[index];

          if (!call) {
            call = {
              id: incomingCall.id || this.newCallId(),
              type: "function",
              function: {
                name: incomingCall.function?.name || "",
                arguments: "",
              },
            };

            this.finalMessage.tool_calls[index] = call;
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
        this.finishReason = choice.finish_reason;
      }
    }
  }

  /**
   * Reconstruct a complete OpenAI-style response object from the consumed
   * chunks. Same in-place mutation semantics as the original inline code.
   */
  finalize() {
    const finalData = this.finalData;

    finalData.choices = [
      {
        index: 0,
        message: this.finalMessage,
        finish_reason: this.finishReason || "stop",
      },
    ];

    finalData.usage = this.usage;

    return finalData;
  }
}
