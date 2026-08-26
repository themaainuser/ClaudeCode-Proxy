/**
 * HTTP server assembly: route table, request logging, error boundary.
 *
 * createProxyServer returns a NON-listening http.Server so tests (and the
 * bootstrap) control listen()/close() themselves.
 */

import http from "node:http";
import { anthropicError, json } from "./http-utils.js";
import { createMessageHandler } from "./message-handler.js";
import { createZenCaller } from "./upstream.js";
import { handleModels, buildHealthPayload } from "./discovery.js";

export function printStartupBanner(config) {
  console.log("");
  console.log("Claude Code <-> OpenCode Zen proxy v2");
  console.log("----------------------------------------");
  console.log(`Listening:   http://${config.host}:${config.port}`);
  console.log(`Zen URL:     ${config.zenUrl}`);
  console.log(`Zen model:   ${config.zenModel}`);
  console.log(`Zen key:     ${config.zenApiKey ? "configured" : "NOT SET"}`);
  console.log("");
  console.log("Claude Code:");
  console.log(`  ANTHROPIC_BASE_URL=http://${config.host}:${config.port}`);
  console.log("  ANTHROPIC_AUTH_TOKEN=local");
  console.log("");
  console.log("Debug switches (off by default):");
  console.log("  DEBUG=1");
  console.log("  DEBUG_REQUEST=1");
  console.log("  DEBUG_RESPONSE=1");
  console.log("");
}

export function createProxyServer({ config, log }) {
  const handleMessages = createMessageHandler({
    config,
    log,
    callZen: createZenCaller(config),
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || `${config.host}:${config.port}`}`,
    );

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
      return handleModels(res, config);
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, buildHealthPayload(config));
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
    log.debug("clientError:", err.message);
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return server;
}
