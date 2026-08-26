/**
 * Prefixed stderr loggers built from config flags.
 */

export function createLoggers(config) {
  return {
    debug(...args) {
      if (config.debug) console.error("[proxy]", ...args);
    },
    debugRequest(...args) {
      if (config.debugRequest) console.error("[claude->proxy]", ...args);
    },
    debugResponse(...args) {
      if (config.debugResponse) console.error("[zen->proxy]", ...args);
    },
  };
}

/** All-off logger for tests and quiet contexts. */
export const silentLog = {
  debug() {},
  debugRequest() {},
  debugResponse() {},
};
