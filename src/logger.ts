import 'source-map-support/register';
import * as http from 'http';
import * as https from 'https';
import jsonStringify from "fast-safe-stringify";
import * as fs from 'fs';
import * as path from 'path';
import { LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { LoggerConfig, Logger, FastifyLogger, LogMetadata, LogLevel } from "./types";

type LokiRuntimeConfig = {
  enabled: boolean;
  url: string;
  service: string;
  labels: Record<string, string>;
  username?: string;
  password?: string;
  tenantId?: string;
};

let lokiConfig: LokiRuntimeConfig | null = null;

type OtlpRuntimeConfig = {
  enabled: boolean;
  endpoint: string;
  headers: Record<string, string>;
  service: string;
  resourceAttributes: Record<string, string>;
  logger?: ReturnType<LoggerProvider['getLogger']>;
};

let otlpConfig: OtlpRuntimeConfig | null = null;

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

function resolveLokiConfig(config: LoggerConfig): LokiRuntimeConfig | null {
  const explicit = config.loki ?? {};
  if (!config.loki && !process.env.LOKI_URL) {
    return null;
  }
  const enabled = explicit.enabled ?? true;
  if (!enabled) {
    return null;
  }

  const url = explicit.url || process.env.LOKI_URL || 'http://loki:3100/loki/api/v1/push';
  const service =
    explicit.service ||
    process.env.SERVICE_NAME ||
    process.env.COMPOSE_SERVICE ||
    process.env.npm_package_name ||
    path.basename(process.cwd());

  const labels: Record<string, string> = {
    service,
    env: process.env.ENV_ID || 'unknown',
    logger: 'log-lib',
    ...(explicit.labels || {}),
  };

  return {
    enabled,
    url,
    service,
    labels,
    username: explicit.username,
    password: explicit.password,
    tenantId: explicit.tenantId,
  };
}

function normalizeOtlpLogsEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, '');
  if (trimmed.endsWith('/v1/logs')) {
    return trimmed;
  }
  return `${trimmed}/v1/logs`;
}

function parseHeaders(raw?: string): Record<string, string> {
  if (!raw) return {};
  return raw.split(',').reduce<Record<string, string>>((headers, item) => {
    const index = item.indexOf('=');
    if (index <= 0) return headers;
    headers[item.slice(0, index).trim()] = item.slice(index + 1).trim();
    return headers;
  }, {});
}

function parseResourceAttributes(raw?: string): Record<string, string> {
  if (!raw) return {};
  return raw.split(',').reduce<Record<string, string>>((attrs, item) => {
    const index = item.indexOf('=');
    if (index <= 0) return attrs;
    attrs[item.slice(0, index).trim()] = item.slice(index + 1).trim();
    return attrs;
  }, {});
}

function resolveOtlpConfig(config: LoggerConfig): OtlpRuntimeConfig | null {
  const explicit = config.otlp ?? {};
  const rawEndpoint =
    explicit.endpoint ||
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    '';
  const enabled = explicit.enabled ?? rawEndpoint.trim() !== '';
  if (!enabled || rawEndpoint.trim() === '') {
    return null;
  }

  const service =
    explicit.service ||
    process.env.OTEL_SERVICE_NAME ||
    process.env.SERVICE_NAME ||
    process.env.COMPOSE_SERVICE ||
    process.env.npm_package_name ||
    path.basename(process.cwd());

  const resourceAttributes = {
    'service.name': service,
    'service.namespace': 'gratheon',
    'deployment.environment.name': process.env.ENV_ID || 'unknown',
    ...parseResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES),
    ...(explicit.resourceAttributes || {}),
  };

  const resolved: OtlpRuntimeConfig = {
    enabled,
    endpoint: normalizeOtlpLogsEndpoint(rawEndpoint),
    headers: {
      ...(process.env.HYPERDX_API_KEY ? { authorization: process.env.HYPERDX_API_KEY } : {}),
      ...parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
      ...parseHeaders(process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS),
      ...(explicit.headers || {}),
    },
    service,
    resourceAttributes,
  };
  const provider = new LoggerProvider({
    resource: resourceFromAttributes(resourceAttributes),
    processors: [
      new SimpleLogRecordProcessor(
        new OTLPLogExporter({
          url: resolved.endpoint,
          headers: resolved.headers,
        })
      ),
    ],
  });
  resolved.logger = provider.getLogger('gratheon-log-lib', '4.0.0');
  return resolved;
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

function otlpValue(value: any): any {
  if (value === null || value === undefined) return { stringValue: '' };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  return { stringValue: safeToStringMessage(value) };
}

function otlpAttributes(fields: Record<string, any>): any[] {
  return Object.entries(fields)
    .filter(([key]) => key !== 'trace_id' && key !== 'traceId' && key !== 'span_id' && key !== 'spanId')
    .map(([key, value]) => ({ key, value: otlpValue(value) }));
}

function severityNumber(level: LogLevel): number {
  switch (level) {
    case 'debug': return 5;
    case 'warn': return 13;
    case 'error': return 17;
    default: return 9;
  }
}

function storeInOtlp(level: LogLevel, message: any, meta?: any, stacktrace?: string) {
  if (!otlpConfig || !otlpConfig.enabled) {
    return;
  }

  try {
    const metaObj = safeMeta(meta);
    const attributes = {
      ...metaObj,
      ...(stacktrace ? { stacktrace } : {}),
      'log.logger': 'log-lib',
    };
    const record: any = {
      timeUnixNano: `${Date.now()}000000`,
      severityText: level.toUpperCase(),
      severityNumber: severityNumber(level),
      body: { stringValue: safeToStringMessage(message) },
      attributes: otlpAttributes(attributes),
    };
    const traceId = metaObj.trace_id || metaObj.traceId;
    const spanId = metaObj.span_id || metaObj.spanId;
    if (traceId) record.traceId = String(traceId);
    if (spanId) record.spanId = String(spanId);

    otlpConfig.logger?.emit({
      severityText: record.severityText,
      severityNumber: record.severityNumber,
      body: safeToStringMessage(message),
      attributes,
    });
  } catch (e: any) {
    if (process.env.ENV_ID === 'dev') {
      console.error('[log-lib] Unexpected failure preparing OTLP log', e?.message || e);
    }
  }
}

function storeInLoki(level: LogLevel, message: any, meta?: any, stacktrace?: string) {
  if (!lokiConfig || !lokiConfig.enabled) {
    return;
  }

  try {
    const nowNs = `${Date.now()}000000`;
    const payloadObject = {
      timestamp: new Date().toISOString(),
      level,
      service: lokiConfig.service,
      message: safeToStringMessage(message),
      meta: safeMeta(meta),
      stacktrace: stacktrace || '',
    };

    const line = jsonStringify(payloadObject).slice(0, 120_000);
    const body = jsonStringify({
      streams: [
        {
          stream: lokiConfig.labels,
          values: [[nowNs, line]],
        },
      ],
    });

    const target = new URL(lokiConfig.url);
    const isHttps = target.protocol === 'https:';
    const client = isHttps ? https : http;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    };

    if (lokiConfig.tenantId) {
      headers['X-Scope-OrgID'] = lokiConfig.tenantId;
    }
    if (lokiConfig.username && lokiConfig.password) {
      const basic = Buffer.from(`${lokiConfig.username}:${lokiConfig.password}`).toString('base64');
      headers['authorization'] = `Basic ${basic}`;
    }

    const req = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400 && process.env.ENV_ID === 'dev') {
          console.error(`[log-lib] Failed to persist log to Loki: HTTP ${res.statusCode}`);
        }
        res.resume();
      }
    );

    req.on('error', (e: any) => {
      if (process.env.ENV_ID === 'dev') {
        console.error('[log-lib] Failed to persist log to Loki', e?.message || e);
      }
    });

    req.write(body);
    req.end();
  } catch (e: any) {
    if (process.env.ENV_ID === 'dev') {
      console.error('[log-lib] Unexpected failure preparing log for Loki', e?.message || e);
    }
  }
}

export function createLogger(config: LoggerConfig = {}): { logger: Logger; fastifyLogger: FastifyLogger } {
  // Set up log level filtering
  // Priority: 1) config.logLevel, 2) process.env.LOG_LEVEL, 3) default based on ENV_ID
  const configuredLevel = config.logLevel || 
    (process.env.LOG_LEVEL as LogLevel) || 
    (process.env.ENV_ID === 'dev' ? 'debug' : 'info');
  
  currentLogLevel = LOG_LEVELS[configuredLevel] ?? LOG_LEVELS.info;
  
  lokiConfig = resolveLokiConfig(config);
  otlpConfig = resolveOtlpConfig(config);
  if (config.mysql && process.env.ENV_ID === 'dev') {
    console.warn('[log-lib] `config.mysql` is deprecated and ignored. Logs are persisted to Loki.');
  }

  const logger: Logger = {
    info: (message: string, meta?: LogMetadata) => {
      const metaObj = safeMeta(meta);
      const callStack = captureCallStack();
      const fullTsStack = extractFullTsStacktrace(callStack);
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log('info', safeToStringMessage(message), metaObj, fileLocation);
      storeInOtlp('info', message, metaObj, fullTsStack);
      storeInLoki('info', message, metaObj, fullTsStack);
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
        
        // For Loki: include stack and error details in metadata
        const enrichedMeta = {stack: message.stack, name: message.name, causeChain, ...metaObj};
        storeInOtlp('error', message.message, enrichedMeta, fullTsStack);
        storeInLoki('error', message.message, enrichedMeta, fullTsStack);
        return;
      }
      const msgStr = safeToStringMessage(message);
      const callStack = captureCallStack();
      const fullTsStack = extractFullTsStacktrace(callStack);
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log('error', msgStr, metaObj, fileLocation);
      printStackEnhanced(message);
      storeInOtlp('error', msgStr, metaObj, fullTsStack);
      storeInLoki('error', msgStr, metaObj, fullTsStack);
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
        
        // For Loki: include stack and error details in metadata
        const enrichedMeta = {stack: error.stack, name: error.name, causeChain, ...metaObj};
        storeInOtlp('error', `${message}: ${error.message}`, enrichedMeta, fullTsStack);
        storeInLoki('error', `${message}: ${error.message}`, enrichedMeta, fullTsStack);
        return;
      }
      const errStr = safeToStringMessage(error);
      const callStack = captureCallStack();
      const fullTsStack = extractFullTsStacktrace(callStack);
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log('error', `${message}: ${errStr}`, metaObj, fileLocation);
      printStackEnhanced(error);
      storeInOtlp('error', `${message}: ${errStr}`, metaObj, fullTsStack);
      storeInLoki('error', `${message}: ${errStr}`, metaObj, fullTsStack);
    },
    warn: (message: string, meta?: LogMetadata) => {
      const metaObj = safeMeta(meta);
      const callStack = captureCallStack();
      const fullTsStack = extractFullTsStacktrace(callStack);
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log('warn', safeToStringMessage(message), metaObj, fileLocation);
      storeInOtlp('warn', message, metaObj, fullTsStack);
      storeInLoki('warn', message, metaObj, fullTsStack);
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
      storeInOtlp("info", messageString);
      storeInLoki("info", messageString);
    },
    error: (msg: any, ...args: any[]) => {
      const errorMessage = (msg && msg.message) ? msg.message : String(msg);
      const meta = args.length > 0 ? args[0] : undefined;
      const callStack = msg?.stack || captureCallStack();
      const fullTsStack = extractFullTsStacktrace(callStack);
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log("error", errorMessage, meta, fileLocation);
      storeInOtlp("error", typeof msg === 'object' ? jsonStringify(msg) : errorMessage, meta, fullTsStack);
      storeInLoki("error", typeof msg === 'object' ? jsonStringify(msg) : errorMessage, meta, fullTsStack);
    },
    warn: (msg: any, ...args: any[]) => {
      const messageString = typeof msg === 'object' ? jsonStringify(msg) : String(msg);
      const callStack = captureCallStack();
      const fullTsStack = extractFullTsStacktrace(callStack);
      const frame = extractFirstProjectFrame(callStack);
      const fileLocation = frame.file && frame.line ? `${frame.file}:${frame.line}` : undefined;
      
      log("warn", messageString, undefined, fileLocation);
      storeInOtlp("warn", messageString, undefined, fullTsStack);
      storeInLoki("warn", messageString, undefined, fullTsStack);
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
      storeInOtlp("error", messageString, undefined, fullTsStack);
      storeInLoki("error", messageString, undefined, fullTsStack);
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
