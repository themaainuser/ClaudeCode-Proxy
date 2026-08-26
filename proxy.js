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
 *   node .\proxy.js
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
 *   directory, but direct /v1/chat/completions requests work.
 *   This adapter therefore treats it as an explicitly configured upstream
 *   model rather than relying on /v1/models discovery.
 *
 * Module map:
 *   src/config.js             environment -> frozen config (sole process.env reader)
 *   src/logger.js             prefixed stderr loggers
 *   src/ids.js                random id helper
 *   src/http-utils.js         json/error/body helpers
 *   src/convert-request.js    Anthropic -> OpenAI request conversion
 *   src/convert-response.js   OpenAI -> Anthropic response conversion
 *   src/sse-openai-parser.js  OpenAI SSE frame parser
 *   src/sse-anthropic-writer.js Anthropic SSE event writer
 *   src/sse-collector.js      SSE -> single OpenAI response accumulator
 *   src/upstream.js           Zen HTTP client factory
 *   src/message-handler.js    POST /v1/messages orchestrator
 *   src/discovery.js          /v1/models + /health payloads
 *   src/server.js             route table + server assembly
 */

import { loadConfig } from "./src/config.js";
import { createLoggers } from "./src/logger.js";
import { createProxyServer, printStartupBanner } from "./src/server.js";

const config = loadConfig();
const log = createLoggers(config);
const server = createProxyServer({ config, log });

server.listen(config.port, config.host, () => {
  printStartupBanner(config);
});
