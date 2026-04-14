import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Options for createLogger.
 */
export interface CreateLoggerOptions {
  /**
   * Short service identifier - rendered as the `service` field on every log
   * line so multi-service log sinks can be filtered by origin without
   * needing to parse the container name.
   */
  service: string;
  /**
   * Pino log level. Defaults to `info` outside production and `warn` inside
   * it, unless `LOG_LEVEL` is set in the environment.
   */
  level?: LoggerOptions['level'];
  /**
   * Optional extra base fields merged into every log line. Useful for
   * attaching build metadata (git sha, deploy id) at startup time.
   */
  base?: Record<string, unknown>;
}

/**
 * Build a pre-configured pino logger for a Bam service. The returned logger
 * emits structured JSON in production and a pretty-printed stream in
 * development (the pretty transport is required at runtime via
 * `transport.target`, so `pino-pretty` must be installed alongside `pino`
 * in the consuming service for dev output).
 */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const isProd = process.env.NODE_ENV === 'production';
  const level = opts.level ?? process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug');

  const base: Record<string, unknown> = {
    service: opts.service,
    ...(opts.base ?? {}),
  };

  if (isProd) {
    return pino({
      level,
      base,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'password',
          'password_hash',
          'token',
          '*.password',
          '*.password_hash',
          '*.token',
        ],
        censor: '[redacted]',
      },
    });
  }

  return pino({
    level,
    base,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  });
}

export type { Logger, LoggerOptions };
