/**
 * HTTP response/request primitives shared by routes and handlers.
 */

export function json(res, status, body) {
  if (res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

export function anthropicError(res, status, type, message, extra = {}) {
  return json(res, status, {
    type: "error",
    error: {
      type,
      message,
      ...extra,
    },
  });
}

export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
