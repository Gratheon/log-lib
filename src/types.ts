export interface LoggerConfig {
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database?: string; // defaults to 'logs'
  };
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
