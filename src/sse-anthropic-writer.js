/**
 * Anthropic SSE writer.
 *
 * Emits Anthropic Messages streaming events onto an HTTP response. Owns
 * content-block index bookkeeping, thinking/text/tool transitions, and the
 * empty-output explanatory notes.
 */

import { makeId } from "./ids.js";
import { mapFinishReason } from "./convert-response.js";

export class AnthropicStreamWriter {
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
