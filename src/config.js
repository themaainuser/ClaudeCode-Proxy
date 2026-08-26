/**
 * Environment configuration - the ONLY module allowed to touch process.env.
 *
 * Everything else in src/ receives a frozen config object as a parameter, so
 * tests can inject literal config values without mutating the environment.
 */

export const DEFAULT_MIN_ANSWER_TOKENS = 1024;

export function isTruthy(value) {
  return /^(1|true|yes)$/i.test(value || "");
}

/**
 * Build the proxy configuration from an environment-like object.
 * Defaults mirror the original inline constants in proxy.js.
 */
export function loadConfig(env = process.env) {
  return Object.freeze({
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 8787),
    zenUrl: env.ZEN_BASE_URL || "https://opencode.ai/zen/v1/chat/completions",
    zenModel: env.ZEN_MODEL || "x-preview-f-free",
    zenApiKey: env.ZEN_API_KEY || "",
    debug: isTruthy(env.DEBUG),
    debugRequest: isTruthy(env.DEBUG_REQUEST),
    debugResponse: isTruthy(env.DEBUG_RESPONSE),
    minAnswerTokens: Number(env.ZEN_MIN_ANSWER_TOKENS || DEFAULT_MIN_ANSWER_TOKENS),
  });
}
