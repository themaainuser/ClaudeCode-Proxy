/**
 * HTTP stubs and Anthropic-SSE parsing utilities for unit tests.
 */

import { Readable } from "node:stream";

/**
 * A recorder stand-in for http.ServerResponse capturing writes/headers/end.
 * Supports everything src/ modules call on `res`.
 */
export function recorderRes() {
  const calls = [];
  let ended = false;

  return {
    calls,
    get writableEnded() {
      return ended;
    },
    headersSent: false,
    writeHead(status, headers) {
      if (this.headersSent) throw new Error("writeHead called twice");
      this.headersSent = true;
      calls.push({ kind: "writeHead", status, headers });
      return this;
    },
    write(text) {
      calls.push({ kind: "write", text });
      return true;
    },
    end() {
      ended = true;
      calls.push({ kind: "end" });
      return this;
    },
  };
}

/** An async-iterable request stub yielding the given string chunks. */
export function stubReq(...chunks) {
  return Readable.from(chunks);
}

/** Concatenate all recorder writes into one text blob. */
export function writtenText(res) {
  return res.calls
    .filter((c) => c.kind === "write")
    .map((c) => c.text)
    .join("");
}

/**
 * Parse Anthropic SSE wire text into [{event, data}] pairs.
 * Throws on any pair missing a valid JSON data line - keeps pairing bugs visible.
 */
export function parseAnthropicSSE(text) {
  const events = [];

  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;

    const lines = block.split("\n");
    const eventLine = lines.find((l) => l.startsWith("event: "));
    const dataLine = lines.find((l) => l.startsWith("data: "));

    if (!eventLine || !dataLine) {
      throw new Error(`Unpaired SSE block: ${JSON.stringify(block)}`);
    }

    events.push({
      event: eventLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length)),
    });
  }

  return events;
}
