import createConnectionPool, { sql, ConnectionPool } from "@databases/mysql";
import jsonStringify from "fast-safe-stringify";
import { LoggerConfig, Logger, FastifyLogger, LogMetadata } from "./types";

let conn: ConnectionPool;

function initializeConnection(config: LoggerConfig) {
  const database = config.mysql.database || 'logs';
  conn = createConnectionPool(
    `mysql://${config.mysql.user}:${config.mysql.password}@${config.mysql.host}:${config.mysql.port}/${database}`,
  );
}

function log(level: string, message: string, meta?: any) {
  let time = new Date().toISOString();
  let hhMMTime = time.slice(11, 19);
  // colorize time to have ansi blue color
  hhMMTime = `\x1b[34m${hhMMTime}\x1b[0m`;

  // colorize level to have ansi red color for errors
  meta = meta ? jsonStringify(meta) : "";

  if (level === "error") {
    level = `\x1b[31m${level}\x1b[0m`;
    meta = `\x1b[35m${meta}\x1b[0m`;
  } else if (level === "info") {
    level = `\x1b[32m${level}\x1b[0m`;
    meta = `\x1b[35m${meta}\x1b[0m`;
  } else if (level === "debug") {
    level = `\x1b[90m${level}\x1b[0m`;
    message = `\x1b[90m${message}\x1b[0m`;
    meta = `\x1b[90m${meta}\x1b[0m`;
  } else if (level === "warn") {
    level = `\x1b[33m${level}\x1b[0m`;
    meta = `\x1b[35m${meta}\x1b[0m`;
  }

  console.log(`${hhMMTime} [${level}]: ${message} ${meta}`);
}

function storeInDB(level: string, message: string, meta?: any) {
  if (!conn) {
    console.error(`\x1b[31m[Logger DB Error] Logger not initialized. Call createLogger() first.\x1b[0m`);
    return;
  }
  
  if (!meta) meta = "";
  // Use the logger's dedicated connection pool
  conn.query(sql`
        INSERT INTO \`logs\` (\`level\`, \`message\`, \`meta\`, \`timestamp\`)
        VALUES (${level}, ${message}, ${JSON.stringify(meta)}, NOW())
    `).catch(err => {
      // Log connection errors to console only, don't crash
      console.error(`\x1b[31m[Logger DB Error] Failed to store log in DB:\x1b[0m ${err.message}`);
      // Optionally check if it's a connection error vs. other query error
      if (err.code && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT')) {
          console.warn(`\x1b[33m[Logger DB Warning] Logger DB connection failed (${err.code}). Is the DB ready?\x1b[0m`);
      }
    });
}

export function createLogger(config: LoggerConfig): { logger: Logger; fastifyLogger: FastifyLogger } {
  initializeConnection(config);

  const logger: Logger = {
    info: (message: string, meta?: LogMetadata) => {
      log("info", message, meta);
      storeInDB("info", message, meta);
    },
    error: (message: string | Error | any, meta?: LogMetadata) => {
      if (message.message && message.stack) {
        // Pass the error message string, not the whole object, to storeInDB
        storeInDB("error", message.message, meta);
        return log("error", message.message, {
          stack: message.stack,
          ...meta,
        });
      }
      // If message is not an Error object, check if it's another type of object
      const messageString = typeof message === 'object' && message !== null && !Array.isArray(message)
        ? jsonStringify(message) // Stringify if it's a plain object
        : String(message);      // Otherwise, convert to string as before
      log("error", messageString, meta);
      // Store the original message or its stringified form in DB
      storeInDB("error", typeof message === 'object' ? jsonStringify(message) : message, meta);
    },
    errorEnriched: (message: string, error: Error | any, meta?: LogMetadata) => {
      const enrichedMessage = `${message}: ${error.message}`;
      if (error.message && error.stack) {
        // Store the combined error message in the DB
        storeInDB("error", enrichedMessage, meta);
        return log("error", enrichedMessage, {
          stack: error.stack,
          ...meta,
        });
      }
      log("error", String(message), meta);
      storeInDB("error", message, meta);
    },
    warn: (message: string, meta?: LogMetadata) => {
      log("warn", message, meta);
      storeInDB("warn", message, meta);
    },

    // do not store debug logs in DB
    debug: (message: string, meta?: LogMetadata) => {
      log("debug", message, meta);
    },
  };

  const fastifyLogger: FastifyLogger = {
    // Stringify potential objects passed to info/warn
    info: (msg: any, ...args: any[]) => {
      const messageString = typeof msg === 'object' ? jsonStringify(msg) : String(msg);
      log("info", messageString);
      // storeInDB("info", messageString); // Keep commented out as original
    },
    error: (msg: any, ...args: any[]) => {
      const errorMessage = (msg && msg.message) ? msg.message : String(msg);
      const meta = args.length > 0 ? args[0] : undefined;
      log("error", errorMessage, meta);
      // Ensure string is passed to storeInDB
      storeInDB("error", typeof msg === 'object' ? jsonStringify(msg) : errorMessage, meta);
    },
    warn: (msg: any, ...args: any[]) => {
      const messageString = typeof msg === 'object' ? jsonStringify(msg) : String(msg);
      log("warn", messageString);
      storeInDB("warn", messageString); // Pass stringified message
    },

    // do not store debug logs in DB
    debug: (msg: any, ...args: any[]) => {
      log("debug", String(msg));
    },

    fatal: (msg: any, ...args: any[]) => {
      const messageString = typeof msg === 'object' ? jsonStringify(msg) : String(msg);
      log("error", messageString);
      storeInDB("error", messageString);
      process.exit(1);
    },

    trace: (msg: any, ...args: any[]) => {},
    child: (bindings: any) => {
      return fastifyLogger;
    },
  };

  // Set up uncaught exception handler
  process.on("uncaughtException", function (err) {
    logger.errorEnriched("UncaughtException processing: %s", err);
  });

  return { logger, fastifyLogger };
}
