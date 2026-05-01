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

export interface OtlpConfig {
  endpoint?: string; // defaults to OTEL_EXPORTER_OTLP_LOGS_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT
  headers?: Record<string, string>;
  service?: string; // defaults to OTEL_SERVICE_NAME, SERVICE_NAME, or current folder name
  resourceAttributes?: Record<string, string>;
  enabled?: boolean; // defaults to true when an OTLP endpoint is configured
}

export interface LoggerConfig {
  otlp?: OtlpConfig;
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
