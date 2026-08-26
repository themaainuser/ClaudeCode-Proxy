/**
 * POST /v1/messages orchestrator.
 *
 * Reads and validates the Anthropic request, converts it to an
 * OpenAI-compatible body, calls the upstream, then either:
 *   - streams Zen's SSE straight through as Anthropic SSE events, or
 *   - consumes Zen's SSE internally (Claude asked for plain JSON) and
 *     reconstructs a single Anthropic message response.
 */

import { anthropicError, json, readBody } from "./http-utils.js";
import { anthropicToOpenAI } from "./convert-request.js";
import { openAIToAnthropic } from "./convert-response.js";
import { AnthropicStreamWriter } from "./sse-anthropic-writer.js";
import { OpenAISSEParser } from "./sse-openai-parser.js";
import { OpenAIStreamCollector } from "./sse-collector.js";

export function createMessageHandler({ config, log, callZen }) {
  const { zenModel } = config;

  return async function handleMessages(req, res) {
    const raw = await readBody(req);

    if (config.debugRequest) {
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

    const outgoing = anthropicToOpenAI(body, {
      model: zenModel,
      minAnswerTokens: config.minAnswerTokens,
    });

    if (config.debug) {
      log.debug("Claude requested model:", body.model);
      log.debug("Forcing Zen model:", zenModel);
      log.debug("stream:", outgoing.stream);
      log.debug("message count:", outgoing.messages.length);
      log.debug("tool count:", outgoing.tools?.length || 0);
    }

    if (config.debugRequest) {
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

      log.debug("Zen HTTP error:", upstream.status, text);

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

      const collector = new OpenAIStreamCollector();

      const parser = new OpenAISSEParser(
        ({ done, data }) => {
          if (done || !data) return;

          if (config.debugResponse) {
            // NOTE: deliberately unprefixed - preserved from the original.
            console.error("[ZEN INTERNAL SSE]", JSON.stringify(data));
          }

          collector.onChunk(data);
        },
        { onMalformed: (payload) => log.debugResponse("Ignoring malformed SSE data:", payload) },
      );

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

      if (!collector.started) {
        return anthropicError(res, 502, "api_error", "OpenCode Zen returned an empty stream.");
      }

      const finalData = collector.finalize();

      if (config.debugResponse) {
        console.error("\n========== RECONSTRUCTED ZEN RESPONSE ==========");
        console.error(JSON.stringify(finalData, null, 2));
        console.error("========== END RECONSTRUCTED RESPONSE ==========\n");
      }

      const result = openAIToAnthropic(finalData, body.model, zenModel);

      return json(res, 200, result);
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const writer = new AnthropicStreamWriter(res, body.model || zenModel);
    let zenChunkCount = 0;

    if (config.debugResponse) {
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

    const parser = new OpenAISSEParser(
      ({ done, data }) => {
        if (done) {
          sawDone = true;
          return;
        }

        if (!data) return;

        if (config.debugResponse) {
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
      },
      { onMalformed: (payload) => log.debugResponse("Ignoring malformed SSE data:", payload) },
    );

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
      if (config.debugResponse) {
        console.error("========== END ZEN SSE ==========\n");
      }
    } catch (err) {
      log.debug("Streaming error:", err);

      if (!writer.ended) {
        writer.error("api_error", `OpenCode Zen stream failed: ${err.message}`);
      }
    }
  };
}
