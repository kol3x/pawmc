/**
 * Shared error-formatting utilities for the worker entrypoint, routes, and DO modules.
 */

function isError(err: unknown) {
  return err instanceof Error
}

/**
 * Formats a thrown value for logging: the message for Error instances, the stringified value otherwise.
 */
export function errorMessage(err: unknown) {
  return isError(err) ? err.message : String(err)
}