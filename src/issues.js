// -----------------------------------------------------------------------------
// Repeated failures, logged once (adapted from guim31/gladys-subsonic).
//
// A controller that stays down, a state Gladys keeps refusing: each would
// write the same warning at every attempt. Per key, the first failure is a
// warning, the next ones go to debug, and the recovery is one info line.
// -----------------------------------------------------------------------------

/**
 * @param {{ debug: Function, info: Function, warn: Function }} logger
 */
export function createIssueLog(logger) {
  const ongoing = new Set();
  return {
    /** A failure: a warning the first time, debug while it lasts. */
    fail(key, message) {
      if (ongoing.has(key)) {
        logger.debug(`${message} (still failing)`);
        return;
      }
      ongoing.add(key);
      logger.warn(message);
    },

    /** A success: one info line (when given) if it ends an ongoing failure. */
    ok(key, message) {
      if (ongoing.delete(key) && message) {
        logger.info(message);
      }
    },

    isFailing(key) {
      return ongoing.has(key);
    },

    clear() {
      ongoing.clear();
    },
  };
}
