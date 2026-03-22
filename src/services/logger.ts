/**
 * Simple log-level utility for Formulo services.
 *
 * Levels (cumulative):
 *   0  silent   — nothing
 *   1  info     — user prompt + final answer only
 *   2  debug    — pipeline steps, agent names, solver routing
 *   3  verbose  — full detail: code snippets, SymPy output, retry loops
 *
 * Default: info (1). Set via LOG_LEVEL in prompts.json or env.
 */

export type LogLevel = 0 | 1 | 2 | 3;

let currentLevel: LogLevel = 1;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Level 1 — always visible (user prompt, final answer, fatal errors) */
export function logInfo(...args: unknown[]): void {
  if (currentLevel >= 1) console.log(...args);
}

/** Level 2 — pipeline steps, agent routing, classifications */
export function logDebug(...args: unknown[]): void {
  if (currentLevel >= 2) console.log(...args);
}

/** Level 3 — code snippets, SymPy output, retry details */
export function logVerbose(...args: unknown[]): void {
  if (currentLevel >= 3) console.log(...args);
}

/** Warnings — visible at level >= 2 */
export function logWarn(...args: unknown[]): void {
  if (currentLevel >= 2) console.warn(...args);
}

/** Errors — always visible at level >= 1 */
export function logError(...args: unknown[]): void {
  if (currentLevel >= 1) console.error(...args);
}
