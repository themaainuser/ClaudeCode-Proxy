/**
 * Upstream (OpenCode Zen) HTTP client.
 *
 * Tests point config.zenUrl at a local fake server instead of mocking
 * fetch, so the global fetch is used directly.
 */

export function createZenCaller(config) {
  return async function callZen(body) {
    const headers = {
      "content-type": "application/json",
      accept: body.stream ? "text/event-stream, application/json" : "application/json",
    };

    if (config.zenApiKey) {
      headers.authorization = `Bearer ${config.zenApiKey}`;
    }

    return fetch(config.zenUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  };
}
