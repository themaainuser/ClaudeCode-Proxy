/**
 * Health / discovery endpoints.
 */

import { json } from "./http-utils.js";

export function fakeModel(id, now = Date.now()) {
  return {
    id,
    object: "model",
    created: Math.floor(now / 1000),
    owned_by: "local-opencode-proxy",
  };
}

export function handleModels(res, config) {
  return json(res, 200, {
    object: "list",
    data: [
      // Claude Code can use these as local/gateway-visible model identifiers.
      // The proxy still forces ZEN_MODEL upstream.
      fakeModel("claude-sonnet-4-5"),
      fakeModel("claude-sonnet-4-6"),
      fakeModel(config.zenModel),
    ],
  });
}

export function buildHealthPayload(config) {
  return {
    ok: true,
    proxy: "claude-opencode-proxy-v2",
    upstream: config.zenUrl,
    model: config.zenModel,
    node: process.version,
  };
}
