import 'source-map-support/register';
import createConnectionPool, { sql, ConnectionPool } from "@databases/mysql";
import jsonStringify from "fast-safe-stringify";
import * as fs from 'fs';
import * as path from 'path';
import { LoggerConfig, Logger, FastifyLogger, LogMetadata, LogLevel } from "./types";

let conn: ConnectionPool | null = null;
let dbInitialized = false;

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

let currentLogLevel: number = LOG_LEVELS.info;

// Get the project root (where the service is running from)
const projectRoot = process.cwd();

// Helper function to convert absolute paths to relative paths
function makePathRelative(filePath: string): string {
  if (filePath.startsWith(projectRoot)) {
    return path.relative(projectRoot, filePath);
  }
  return filePath;
}

// Helper function to clean up stack trace paths
function cleanStackTrace(stack: string): string {
  if (!stack) return '';
  
  return stack.split('\n').map(line => {
    // Match file paths in stack traces
    return line.replace(/\(([^)]+)\)/g, (match, filePath) => {
      const cleaned = makePathRelative(filePath);
      return `(${cleaned})`;
    }).replace(/at\s+([^\s]+:\d+:\d+)/g, (match, filePath) => {
      const cleaned = makePathRelative(filePath);
      return `at ${cleaned}`;
    });
  }).join('\n');
}

async function initializeConnection(config: LoggerConfig) {
  if (dbInitialized || !config.mysql) return;
  
  try {
    const database = config.mysql.database || 'logs';
    
    // First connect without database to create it if needed
    const tempConn = createConnectionPool({
      connectionString: `mysql://${config.mysql.user}:${config.mysql.password}@${config.mysql.host}:${config.mysql.port}/?connectionLimit=1&waitForConnections=true`,
      bigIntMode: 'number',
    });
    
    await tempConn.query(sql`CREATE DATABASE IF NOT EXISTS ${sql.ident(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`);
    await tempConn.dispose();
    
    // Now create the main connection pool with the logs database
    conn = createConnectionPool({
      connectionString: `mysql://${config.mysql.user}:${config.mysql.password}@${config.mysql.host}:${config.mysql.port}/${database}?connectionLimit=3&waitForConnections=true`,
      bigIntMode: 'number',
      poolSize: 3,
      maxUses: 200,
      idleTimeoutMilliseconds: 30_000,
      queueTimeoutMilliseconds: 60_000,
      onError: (err) => {
        // Suppress "packets out of order" and inactivity warnings
        if (!err.message?.includes('packets out of order') && 
            !err.message?.includes('inactivity') &&
            !err.message?.includes('wait_timeout')) {
          console.error(`MySQL logger connection pool error: ${err.message}`);
        }
      },
    });
    
    // Create logs table if it doesn't exist
    await conn.query(sql`
      CREATE TABLE IF NOT EXISTS \`logs\` (
        id INT AUTO_INCREMENT PRIMARY KEY,
        level VARCHAR(50),
        message TEXT,
        meta TEXT,
        stacktrace TEXT,
        timestamp DATETIME,
        INDEX idx_timestamp (timestamp),
        INDEX idx_level (level)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
    `);
    
    // Run migrations: Add stacktrace column if it doesn't exist (for existing tables)
    try {
      const columns = await conn.query(sql`SHOW COLUMNS FROM \`logs\` LIKE 'stacktrace'`);
      if (columns.length === 0) {
        console.log('[log-lib] Running migration: Adding stacktrace column...');
        await conn.query(sql`ALTER TABLE \`logs\` ADD COLUMN \`stacktrace\` TEXT AFTER \`meta\``);
        console.log('[log-lib] Migration complete: stacktrace column added');
      }
    } catch (migrationErr) {
      console.error('[log-lib] Migration failed (non-critical):', migrationErr);
      // Don't fail initialization if migration fails
    }
    
    dbInitialized = true;
  } catch (err) {
    console.error('Failed to initialize logs database:', err);
    // Don't throw - allow the service to start even if logging DB fails
  }
}

function log(level: string, message: string, meta?: any, fileLocation?: string) {
  // Check if this log level should be filtered
  const levelKey = level.replace(/\x1b\[\d+m/g, '') as LogLevel; // Remove ANSI codes for comparison
  const messageLevel = LOG_LEVELS[levelKey];
  if (messageLevel !== undefined && messageLevel < currentLogLevel) {
    return; // Skip logging this message
  }

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

  // Add gray file:line location if provided
  const location = fileLocation ? ` \x1b[90m${fileLocation}\x1b[0m` : '';

  console.log(`${hhMMTime} [${level}]: ${message} ${meta}${location}`);
}

function formatStack(stack?: string, maxLines: number = 3): string {
  if (!stack) return '';
  // Clean up paths first
  const cleanedStack = cleanStackTrace(stack);
  
  // Remove first line if it duplicates the error message already printed.
  const lines = cleanedStack.split('\n');
  if (lines.length > 1 && lines[0].startsWith('Error')) {
    lines.shift();
  }
  // Limit to first N lines and grey color for stack lines
  const limitedLines = lines.slice(0, maxLines);
  return limitedLines.map(l => `\x1b[90m${l}\x1b[0m`).join('\n');
}

function extractFirstProjectFrame(stack?: string): {file?: string, line?: number, column?: number} {
  if (!stack) return {};
  const cleanedStack = cleanStackTrace(stack);
  const lines = cleanedStack.split('\n');
  for (const l of lines) {
    // Match: at FunctionName (src/some/file.ts:123:45)
    const m = l.match(/\(([^()]+\.ts):(\d+):(\d+)\)/);
    if (m) {
      return {file: m[1], line: parseInt(m[2], 10), column: parseInt(m[3], 10)};
    }
    // Alternate format: at src/file.ts:123:45
    const m2 = l.match(/\s(at\s)?([^()]+\.ts):(\d+):(\d+)/);
    if (m2) {
      return {file: m2[2], line: parseInt(m2[3], 10), column: parseInt(m2[4], 10)};
    }
  }
  return {};
}

function extractFullTsStacktrace(stack?: string): string {
  if (!stack) return '';
  const cleanedStack = cleanStackTrace(stack);
  const lines = cleanedStack.split('\n');
  // Filter only TypeScript files
  const tsLines = lines.filter(l => l.includes('.ts:') || l.includes('.ts)'));
  return tsLines.join('\n');
}

function captureCallStack(): string {
  const err = new Error();
  if (!err.stack) return '';
  const cleanedStack = cleanStackTrace(err.stack);
  const lines = cleanedStack.split('\n');
  // Skip first line (Error:) and this function call + log function calls
  // Keep only .ts files
  const tsLines = lines.slice(1).filter(l => l.includes('.ts:') || l.includes('.ts)'));
  return tsLines.join('\n');
}

function buildCodeFrame(frame: {file?: string, line?: number, column?: number}): string {
  if (!frame.file || frame.line == null) return '';
  try {
    const filePath = frame.file.startsWith('/') ? frame.file : path.join(process.cwd(), frame.file);
    if (!fs.existsSync(filePath)) return '';
    const content = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const start = Math.max(0, frame.line - 3);
    const end = Math.min(content.length, frame.line + 2);
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const prefix = (i + 1 === frame.line) ? '\x1b[31m>\x1b[0m' : ' '; // highlight culprit line
      const num = String(i + 1).padStart(4,' ');
      let codeLine = content[i];
      if (i + 1 === frame.line && frame.column) {
        // Add caret marker under column
        const caretPad = ' '.repeat(frame.column - 1);
        codeLine += `\n     ${caretPad}\x1b[31m^\x1b[0m`;
      }
      lines.push(`${prefix} ${num} | ${codeLine}`);
    }
    return lines.join('\n');
  } catch {return '';}
}

function hasProjectTsFrame(stack?: string): boolean {
  if (!stack) return false;
  return stack.split('\n').some(l => l.includes('/src/') && l.includes('.ts'));
}

function printStackEnhanced(possibleError: any) {
  if (!possibleError) return;
  const stack = possibleError.stack;
  if (typeof stack !== 'string') return;
  let outputStack = stack;
  if (process.env.ENV_ID === 'dev' && !hasProjectTsFrame(stack)) {
    // Capture a callsite stack to show where logger.error was invoked
    const callsite = new Error('__callsite__');
    if (callsite.stack) {
      const filtered = callsite.stack
        .split('\n')
        .filter(l => l.includes('/src/') && l.includes('.ts'))
        .slice(0, 5) // keep it short
        .join('\n');
      if (filtered) {
        outputStack += '\n\nCaptured callsite (added by logger):\n' + filtered;
      }
    }
  }
  console.log(formatStack(outputStack));
  if (process.env.ENV_ID === 'dev') {
    const frame = extractFirstProjectFrame(outputStack);
    const codeFrame = buildCodeFrame(frame);
    if (codeFrame) {
      console.log('\n\x1b[36mCode frame:\x1b[0m\n' + codeFrame + '\n');
    }
  }
}

function buildCauseChain(err: any): string[] {
  const chain: string[] = [];
  const visited = new Set<any>();
  let current = err;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    if (current !== err) {
      const title = current.name ? `${current.name}: ${current.message}` : safeToStringMessage(current);
      chain.push(title);
    }
    current = current.cause;
  }
  return chain;
}

function safeToStringMessage(message: any): string {
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') {
    if (message.message && typeof message.message === 'string') return message.message;
    try {
      return jsonStringify(message).slice(0, 2000);
    } catch {
      return String(message);
    }
  }
  return String(message);
}

function safeMeta(meta: any): any {
  if (!meta) return {};
  return meta;
}

function storeInDB(level: string, message: any, meta?: any, stacktrace?: string) {
  if (!conn || !dbInitialized) {
    // Database not ready yet, skip DB logging
    return;
  }
  try {
    const msg = safeToStringMessage(message);
    const metaObj = safeMeta(meta);
    const metaStr = jsonStringify(metaObj).slice(0, 2000);
    const stackStr = stacktrace || '';
    // Fire and forget; avoid awaiting in hot path. Catch errors to avoid unhandled rejection.
    conn.query(sql`INSERT INTO \`logs\` (level, message, meta, stacktrace, timestamp) VALUES (${level}, ${msg}, ${metaStr}, ${stackStr}, NOW())`).catch(e => {
      // fallback console output only - but don't spam
      if (process.env.ENV_ID === 'dev') {
        console.error('Failed to persist log to DB', e);
      }
    });
  } catch (e) {
    console.error('Unexpected failure preparing log for DB', e);
  }
}

export function createLogger(config: LoggerConfig = {}): { logger: Logger; fastifyLogger: FastifyLogger } {
  // Set up log level filtering
  // Priority: 1) config.logLevel, 2) process.env.LOG_LEVEL, 3) default based on ENV_ID
  const configuredLevel = config.logLevel || 
    (process.env.LOG_LEVEL as LogLevel) || 
    (process.env.ENV_ID === 'dev' ? 'debug' : 'info');
  
  currentLogLevel = LOG_LEVELS[configuredLevel] ?? LOG_LEVELS.info;
  
  // Start initialization asynchronously but don't wait for it (only if MySQL config provided)
  if (config.mysql) {
    initializeConnection(config).catch(err => {
      console.error('Error during log database initialization:', err);
    });
  }

  const logger: Logger = {
    info: (message: string, meta?: LogMetadata) => {
      const metaObj = safeMeta(meta);
      const callStack = captureCallStack();
      const fullTsStack = extractFullTsStacktrace(callStack);
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log('info', safeToStringMessage(message), metaObj, fileLocation);
      storeInDB('info', message, metaObj, fullTsStack);
    },
    error: (message: string | Error | any, meta?: LogMetadata) => {
      const metaObj = safeMeta(meta);
      if (message instanceof Error) {
        const causeChain = buildCauseChain(message);
        const fullTsStack = extractFullTsStacktrace(message.stack);
        const frame = extractFirstProjectFrame(message.stack);
        const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
        
        // For console: show message + metadata (without stack), then stack separately
        log('error', message.message, metaObj, fileLocation);
        if (message.stack) {
          printStackEnhanced(message);
        }
        if (causeChain.length) {
          console.log('\x1b[35mCause chain:\x1b[0m ' + causeChain.join(' -> '));
        }
        
        // For DB: include stack and error details in metadata
        const enrichedMeta = {stack: message.stack, name: message.name, causeChain, ...metaObj};
        storeInDB('error', message.message, enrichedMeta, fullTsStack);
        return;
      }
      const msgStr = safeToStringMessage(message);
      const callStack = captureCallStack();
      const fullTsStack = extractFullTsStacktrace(callStack);
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log('error', msgStr, metaObj, fileLocation);
      printStackEnhanced(message);
      storeInDB('error', msgStr, metaObj, fullTsStack);
    },
    errorEnriched: (message: string, error: Error | any, meta?: LogMetadata) => {
      const metaObj = safeMeta(meta);
      if (error instanceof Error) {
        const causeChain = buildCauseChain(error);
        const fullTsStack = extractFullTsStacktrace(error.stack);
        const frame = extractFirstProjectFrame(error.stack);
        const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
        
        // For console: show message + metadata (without stack), then stack separately
        log('error', `${message}: ${error.message}`, metaObj, fileLocation);
        if (error.stack) {
          printStackEnhanced(error);
        }
        if (causeChain.length) {
          console.log('\x1b[35mCause chain:\x1b[0m ' + causeChain.join(' -> '));
        }
        
        // For DB: include stack and error details in metadata
        const enrichedMeta = {stack: error.stack, name: error.name, causeChain, ...metaObj};
        storeInDB('error', `${message}: ${error.message}`, enrichedMeta, fullTsStack);
        return;
      }
      const errStr = safeToStringMessage(error);
      const callStack = captureCallStack();
      const fullTsStack = extractFullTsStacktrace(callStack);
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log('error', `${message}: ${errStr}`, metaObj, fileLocation);
      printStackEnhanced(error);
      storeInDB('error', `${message}: ${errStr}`, metaObj, fullTsStack);
    },
    warn: (message: string, meta?: LogMetadata) => {
      const metaObj = safeMeta(meta);
      const callStack = captureCallStack();
      const fullTsStack = extractFullTsStacktrace(callStack);
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log('warn', safeToStringMessage(message), metaObj, fileLocation);
      storeInDB('warn', message, metaObj, fullTsStack);
    },

    // do not store debug logs in DB
    debug: (message: string, meta?: LogMetadata) => {
      const callStack = captureCallStack();
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log('debug', safeToStringMessage(message), safeMeta(meta), fileLocation);
    },
  };

  const fastifyLogger: FastifyLogger = {
    // Stringify potential objects passed to info/warn
    info: (msg: any, ...args: any[]) => {
      const messageString = typeof msg === 'object' ? jsonStringify(msg) : String(msg);
      const callStack = captureCallStack();
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log("info", messageString, undefined, fileLocation);
      // storeInDB("info", messageString); // Keep commented out as original
    },
    error: (msg: any, ...args: any[]) => {
      const errorMessage = (msg && msg.message) ? msg.message : String(msg);
      const meta = args.length > 0 ? args[0] : undefined;
      const callStack = msg?.stack || captureCallStack();
      const fullTsStack = extractFullTsStacktrace(callStack);
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log("error", errorMessage, meta, fileLocation);
      // Ensure string is passed to storeInDB
      storeInDB("error", typeof msg === 'object' ? jsonStringify(msg) : errorMessage, meta, fullTsStack);
    },
    warn: (msg: any, ...args: any[]) => {
      const messageString = typeof msg === 'object' ? jsonStringify(msg) : String(msg);
      const callStack = captureCallStack();
      const fullTsStack = extractFullTsStacktrace(callStack);
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log("warn", messageString, undefined, fileLocation);
      storeInDB("warn", messageString, undefined, fullTsStack); // Pass stringified message
    },

    // do not store debug logs in DB
    debug: (msg: any, ...args: any[]) => {
      const callStack = captureCallStack();
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log("debug", String(msg), undefined, fileLocation);
    },

    fatal: (msg: any, ...args: any[]) => {
      const messageString = typeof msg === 'object' ? jsonStringify(msg) : String(msg);
      const callStack = captureCallStack();
      const fullTsStack = extractFullTsStacktrace(callStack);
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log("error", messageString, undefined, fileLocation);
      storeInDB("error", messageString, undefined, fullTsStack);
      // Exit after a brief delay to allow logs to flush
      setTimeout(() => process.exit(1), 100);
    },

    trace: (msg: any, ...args: any[]) => {},
    child: (bindings: any) => {
      return fastifyLogger;
    },
  };

  // Set up global exception handlers
  process.on('uncaughtException', function (err) {
    // Use console.error directly to ensure we see the error even if logger fails
    console.error('=== UNCAUGHT EXCEPTION ===');
    console.error(err);
    if (err && err.stack) {
      console.error(err.stack);
    }
    // Also try to log through logger if available
    try {
      logger.error('UncaughtException', err);
    } catch (logErr) {
      console.error('Failed to log uncaught exception:', logErr);
    }
    // Exit after a brief delay to allow logs to flush
    setTimeout(() => process.exit(1), 100);
  });

  process.on('unhandledRejection', function (reason: any) {
    // Use console.error directly
    console.error('=== UNHANDLED REJECTION ===');
    console.error(reason);
    if (reason && reason.stack) {
      console.error(reason.stack);
    }
    // Also try to log through logger
    try {
      logger.error('UnhandledRejection', reason);
    } catch (logErr) {
      console.error('Failed to log unhandled rejection:', logErr);
    }
  });

  return { logger, fastifyLogger };
}
