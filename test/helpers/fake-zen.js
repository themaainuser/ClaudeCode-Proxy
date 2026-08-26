/**
 * Scripted fake OpenCode Zen upstream for integration tests.
 *
 * A real http server on 127.0.0.1:0 that records requests and lets each
 * test script its response: SSE frames, a JSON error, or a destroyed
 * socket (truncation scenarios).
 */

import http from "node:http";

/**
 * Start a fake Zen server.
 *
 * @param {(req: {headers: object, body: object, raw: string, res: http.ServerResponse}) => void} handler
 *   Called once per request with the parsed JSON body. Write the response
 *   (or destroy req.socket) inside the handler.
 * @returns {Promise<{url: string, server: http.Server, requests: Array<object>}>}
 */
export async function startFakeZen(handler) {
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");

    let body = null;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      body = null;
    }

    const record = { headers: req.headers, raw, body };
    requests.push(record);

    handler(record, res);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return { url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, server, requests };
}

/** Build one OpenAI SSE data frame for an object payload. */
export function frame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** The terminal [DONE] frame. */
export function doneFrame() {
  return "data: [DONE]\n\n";
}

/**
 * Build a standard chat-completions chunk.
 *
 * @param {object} opts
 * @param {string} [opts.id]           response id (included when set)
 * @param {object} [opts.delta]        choices[0].delta payload
 * @param {string|null} [opts.finish]  choices[0].finish_reason
 * @param {object} [opts.usage]        top-level usage object (included when set)
 */
export function chunk({ id, delta, finish, usage } = {}) {
  const out = {
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: delta ?? {},
        ...(finish != null ? { finish_reason: finish } : {}),
      },
    ],
  };

  if (id !== undefined) out.id = id;
  if (usage !== undefined) out.usage = usage;

  return frame(out);
}
