/**
 * OpenAI-compatible SSE parser.
 *
 * Splits a byte/text stream into `data:` frames and hands parsed JSON
 * payloads to a callback. Knows nothing about logging or HTTP; malformed
 * payloads are reported through the injected `onMalformed` hook.
 */

export class OpenAISSEParser {
  constructor(onEvent, { onMalformed } = {}) {
    this.onEvent = onEvent;
    this.onMalformed = onMalformed;
    this.buffer = "";
  }

  feed(text) {
    this.buffer += text;

    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      this.consumeLine(line);
    }
  }

  end() {
    if (this.buffer.trim()) this.consumeLine(this.buffer);
    this.buffer = "";
  }

  consumeLine(line) {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:")) return;

    const payload = trimmed.slice(5).trim();

    if (!payload || payload === "[DONE]") {
      this.onEvent({ done: true });
      return;
    }

    try {
      this.onEvent({
        done: false,
        data: JSON.parse(payload),
      });
    } catch {
      this.onMalformed?.(payload);
    }
  }
}
