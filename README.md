# log-lib

A TypeScript logging library with console output and Loki persistence support.

## Features

- **Dual Output**: Logs to both console and Loki
- **Color-Coded Console**: ANSI colored output for different log levels
- **Automatic Stacktrace Capture**: Every log includes file:line information
  - **CLI Output**: Shows the most relevant TypeScript file:line in gray color
  - **Loki Storage**: Stores full stacktrace filtered to TypeScript files only
- **Enhanced Stack Traces**: Shows code frames with 5 lines of context around errors (dev mode)
- **Error Cause Chain Tracking**: Traverses and displays the full error.cause chain
- **Callsite Capture**: Captures where logger.error was called when error lacks stack frames
- **Non-blocking Delivery**: App starts even if Loki is unavailable
- **Service Labels**: Emits structured logs with `service`/`env` labels for Loki queries
- **Global Exception Handlers**: Captures uncaught exceptions and unhandled rejections
- **TypeScript Support**: Full type definitions included
- **Fastify Integration**: Special logger interface for Fastify framework
- **Flexible Metadata**: Support for structured metadata in logs
- **Multiple Log Levels**: info, error, warn, debug (debug logs are not persisted)
- **Log Level Filtering**: Configure minimum log level via config or LOG_LEVEL env var

## Installation

```bash
npm install @gratheon/log-lib
```

## Loki Setup

By default the logger pushes to `http://loki:3100/loki/api/v1/push`.

You can override with:
- `config.loki.url`
- `LOKI_URL` environment variable

## Usage

### Basic Usage

```typescript
import { createLogger, LoggerConfig } from '@gratheon/log-lib';

const config: LoggerConfig = {
  loki: {
    url: 'http://loki:3100/loki/api/v1/push', // optional
    service: 'user-cycle', // optional, defaults from env/current folder
    labels: { team: 'platform' } // optional extra labels
  },
  logLevel: 'info' // optional, defaults to 'debug' in dev, 'info' in prod
};

const { logger, fastifyLogger } = createLogger(config);

// Log messages - each log automatically includes file:line location
logger.info('Application started');
// Output: 12:34:56 [info]: Application started  src/index.ts:42

logger.warn('Low memory warning', { available: '100MB' });
// Output: 12:34:56 [warn]: Low memory warning {"available":"100MB"} src/memory.ts:15

logger.error('Failed to connect to API', { endpoint: '/api/users' });
logger.debug('Processing item', { id: 123 }); // Not persisted

// Error with stack trace and code frame (in dev mode)
try {
  throw new Error('Something went wrong');
} catch (err) {
  logger.error(err); // Logs error with stack trace, cause chain, and code frame
}

// Enriched error logging
logger.errorEnriched('Database query failed', err, { query: 'SELECT * FROM users' });
```

### Development Mode Features

Set `ENV_ID=dev` to enable enhanced error diagnostics:

```bash
ENV_ID=dev node app.js
```

In dev mode, you get:
- **Code frames**: Shows 5 lines of source code around the error location
- **Column markers**: Caret (^) pointing to the exact error position
- **Callsite capture**: When error lacks project stack frames, shows where logger was called
- **Enhanced debugging**: More verbose error output

Example dev mode output:
```
12:34:56 [error]: Something went wrong {"stack":"Error: Something went wrong\n  at /app/src/user.ts:42:15\n..."}

Code frame:
  40 | function processUser(user) {
  41 |   if (!user.id) {
> 42 |     throw new Error('Something went wrong');
     |               ^
  43 |   }
  44 |   return user;
```

### Fastify Integration

```typescript
import Fastify from 'fastify';
import { createLogger, LoggerConfig } from '@gratheon/log-lib';

const config: LoggerConfig = {
  loki: {
    url: 'http://loki:3100/loki/api/v1/push',
    service: 'my-fastify-service'
  }
};

const { fastifyLogger } = createLogger(config);

const fastify = Fastify({
  logger: fastifyLogger
});

fastify.listen(3000);
```

## API Reference

### `createLogger(config: LoggerConfig)`

Creates and returns logger instances.

**Parameters:**
- `config`: Configuration object with Loki details

**Returns:**
```typescript
{
  logger: Logger,
  fastifyLogger: FastifyLogger
}
```

### Logger Methods

#### `logger.info(message: string, meta?: LogMetadata)`
Logs informational messages (console + Loki)

#### `logger.error(message: string | Error, meta?: LogMetadata)`
Logs errors with automatic Error object detection (console + Loki)

#### `logger.errorEnriched(message: string, error: Error, meta?: LogMetadata)`
Logs enriched error messages with context (console + Loki)

#### `logger.warn(message: string, meta?: LogMetadata)`
Logs warning messages (console + Loki)

#### `logger.debug(message: string, meta?: LogMetadata)`
Logs debug messages (console only, not persisted)

### FastifyLogger Methods

Compatible with Fastify's logger interface:
- `info(msg: any)`
- `error(message: string | Error, meta?: LogMetadata)`
- `warn(msg: any)`
- `debug(msg: any)`
- `fatal(msg: any)` - Logs error and calls `process.exit(1)` after 100ms delay
- `trace(msg: any)` - No-op
- `child(meta: any)` - Returns the same logger instance

## Advanced Features

### Loki Delivery

The logger sends logs directly to Loki's HTTP push API (`/loki/api/v1/push`) in fire-and-forget mode.

### Message Truncation

To control payload size:
- Large log payloads are truncated before push
- JSON stringification uses `fast-safe-stringify` for circular reference handling

### Environment-Specific Behavior

Set `ENV_ID` to control behavior:
- `ENV_ID=dev`: Enhanced diagnostics, code frames, callsite capture
- `ENV_ID=prod`: Production mode with minimal overhead

## Console Output Colors

- **Time**: Blue
- **Error**: Red (level) + Magenta (metadata) + Gray (file:line)
- **Info**: Green (level) + Magenta (metadata) + Gray (file:line)
- **Debug**: Gray (dimmed, including file:line)
- **Warn**: Yellow (level) + Magenta (metadata) + Gray (file:line)
- **File Location**: Gray (file:line) - automatically captured from call stack

## Loki Payload

Each persisted entry is sent as JSON line data with:
- `timestamp`
- `level`
- `service`
- `message`
- `meta`
- `stacktrace`

## Error Handling

The logger provides comprehensive error handling:

### Graceful Degradation
- Logs are always written to console
- Loki delivery errors are logged but don't crash the application
- Fire-and-forget Loki logging (no await in hot path)

### Enhanced Error Diagnostics
- **Error Cause Chain**: Automatically traverses and displays `error.cause` chains
- **Stack Trace Enhancement**: Formats and colorizes stack traces
- **Code Frames** (dev mode): Shows source code context around errors
- **Callsite Capture** (dev mode): Shows where logger was called when error lacks stack

### Global Exception Handling
The logger automatically registers handlers for:
- `uncaughtException`: Logs the error and exits gracefully (100ms delay for log flush)
- `unhandledRejection`: Logs the rejection and continues running

Example with error cause chain:
```typescript
try {
  const dbError = new Error('Connection refused');
  throw new Error('Failed to fetch user', { cause: dbError });
} catch (err) {
  logger.error(err);
  // Output:
  // [error]: Failed to fetch user
  // [stack trace]
  // Cause chain: Error: Connection refused
}
```

## TypeScript Types

```typescript
interface LoggerConfig {
  loki?: {
    url?: string; // defaults to process.env.LOKI_URL or http://loki:3100/loki/api/v1/push
    service?: string; // defaults to process.env.SERVICE_NAME or cwd folder name
    labels?: Record<string, string>;
    username?: string;
    password?: string;
    tenantId?: string;
    enabled?: boolean;
  };
  logLevel?: LogLevel; // 'debug' | 'info' | 'warn' | 'error', defaults to 'debug' in dev, 'info' in prod
}

interface LogMetadata {
  [key: string]: any;
}
```

## License

ISC
