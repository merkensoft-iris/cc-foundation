/**
 * Structured log lines of the core. The redacting file logger of 04 §9 rule 2 arrives with
 * the desktop shell; headless mode logs JSON lines to stderr.
 */
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** One JSON object per line on stderr. Never pass secret values or tokens in `fields`. */
export function stderrLogger(clock: { now(): Date }): Logger {
  const write = (level: string, event: string, fields?: Record<string, unknown>) => {
    process.stderr.write(
      `${JSON.stringify({ at: clock.now().toISOString(), level, event, ...fields })}\n`,
    );
  };
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}
