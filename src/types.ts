export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LokiConfig {
  url?: string; // defaults to process.env.LOKI_URL or http://loki:3100/loki/api/v1/push
  username?: string;
  password?: string;
  tenantId?: string;
  service?: string; // defaults to process.env.SERVICE_NAME or current folder name
  labels?: Record<string, string>;
  enabled?: boolean; // defaults to true
}

export interface LoggerConfig {
  loki?: LokiConfig;
  /**
   * @deprecated MySQL persistence has been replaced by Loki.
   * Kept only for backward compatibility and ignored.
   */
  mysql?: {
    host: string;
    port: number;
    user: string;
    password: string;
    database?: string; // defaults to 'logs'
  };
  logLevel?: LogLevel; // defaults to 'info' in production, 'debug' in dev
}

export interface LogMetadata {
  [key: string]: any;
}

export interface Logger {
  info: (message: string, meta?: LogMetadata) => void;
  error: (message: string | Error | any, meta?: LogMetadata) => void;
  errorEnriched: (message: string, error: Error | any, meta?: LogMetadata) => void;
  warn: (message: string, meta?: LogMetadata) => void;
  debug: (message: string, meta?: LogMetadata) => void;
}

export interface FastifyLogger {
  info: (msg: any, ...args: any[]) => void;
  error: (msg: any, ...args: any[]) => void;
  warn: (msg: any, ...args: any[]) => void;
  debug: (msg: any, ...args: any[]) => void;
  fatal: (msg: any, ...args: any[]) => void;
  trace: (msg: any, ...args: any[]) => void;
  child: (bindings: any) => FastifyLogger;
}
