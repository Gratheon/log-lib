# log-lib

A TypeScript logging library with console output and MySQL database persistence support.

## Features

- **Dual Output**: Logs to both console and MySQL database
- **Color-Coded Console**: ANSI colored output for different log levels
- **Enhanced Stack Traces**: Shows code frames with 5 lines of context around errors (dev mode)
- **Error Cause Chain Tracking**: Traverses and displays the full error.cause chain
- **Callsite Capture**: Captures where logger.error was called when error lacks stack frames
- **Automatic Database Creation**: Creates logs database and table if they don't exist
- **Non-blocking Initialization**: App starts even if logging DB fails
- **Connection Pool Optimization**: Suppresses known MySQL warnings for cleaner logs
- **Global Exception Handlers**: Captures uncaught exceptions and unhandled rejections
- **TypeScript Support**: Full type definitions included
- **Fastify Integration**: Special logger interface for Fastify framework
- **Flexible Metadata**: Support for structured metadata in logs
- **Multiple Log Levels**: info, error, warn, debug (debug logs are not persisted to DB)

## Installation

```bash
npm install @gratheon/log-lib
```

## Database Setup

The logger automatically creates the database and table on first initialization. No manual setup required!

For reference, the migration script is available at `migrations/001-create-logs-table.sql`.

## Usage

### Basic Usage

```typescript
import { createLogger, LoggerConfig } from '@gratheon/log-lib';

const config: LoggerConfig = {
  mysql: {
    host: 'localhost',
    port: 3306,
    user: 'your_user',
    password: 'your_password',
    database: 'logs' // optional, defaults to 'logs'
  }
};

const { logger, fastifyLogger } = createLogger(config);

// Log messages
logger.info('Application started');
logger.warn('Low memory warning', { available: '100MB' });
logger.error('Failed to connect to API', { endpoint: '/api/users' });
logger.debug('Processing item', { id: 123 }); // Not stored in DB

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
  mysql: {
    host: 'localhost',
    port: 3306,
    user: 'your_user',
    password: 'your_password'
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
- `config`: Configuration object with MySQL connection details

**Returns:**
```typescript
{
  logger: Logger,
  fastifyLogger: FastifyLogger
}
```

### Logger Methods

#### `logger.info(message: string, meta?: LogMetadata)`
Logs informational messages (console + DB)

#### `logger.error(message: string | Error, meta?: LogMetadata)`
Logs errors with automatic Error object detection (console + DB)

#### `logger.errorEnriched(message: string, error: Error, meta?: LogMetadata)`
Logs enriched error messages with context (console + DB)

#### `logger.warn(message: string, meta?: LogMetadata)`
Logs warning messages (console + DB)

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

### Connection Pool Configuration

The logger uses an optimized connection pool:
- Pool size: 3 connections
- Max uses per connection: 200
- Idle timeout: 30 seconds
- Queue timeout: 60 seconds
- Automatic error suppression for known MySQL warnings

### Message Truncation

To prevent database bloat:
- Messages are truncated to 2000 characters
- Metadata is truncated to 2000 characters
- JSON stringification uses `fast-safe-stringify` for circular reference handling

### Async Initialization

The logger initializes asynchronously in the background:
```typescript
const { logger } = createLogger(config);
logger.info('App starting'); // Works immediately, DB writes happen when ready
```

### Environment-Specific Behavior

Set `ENV_ID` to control behavior:
- `ENV_ID=dev`: Enhanced diagnostics, code frames, callsite capture
- `ENV_ID=prod`: Production mode with minimal overhead

## Console Output Colors

- **Time**: Blue
- **Error**: Red (level) + Magenta (metadata)
- **Info**: Green (level) + Magenta (metadata)
- **Debug**: Gray (dimmed)
- **Warn**: Yellow (level) + Magenta (metadata)

## Database Schema

```sql
CREATE TABLE `logs` (
    `id`        int auto_increment primary key,
    `level`     varchar(16)   not null,
    `message`   varchar(2048) not null,
    `meta`      varchar(2048) not null,
    `timestamp` datetime      not null
);
```

## Error Handling

The logger provides comprehensive error handling:

### Automatic Database Creation
- Creates the `logs` database if it doesn't exist
- Creates the `logs` table with proper schema and indexes
- Non-blocking initialization - app starts even if DB fails

### Graceful Degradation
- Logs are always written to console
- Database errors are logged but don't crash the application
- Connection pool errors are suppressed (packets out of order, inactivity warnings)
- Fire-and-forget database logging (no await in hot path)

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
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database?: string; // defaults to 'logs'
  };
}

interface LogMetadata {
  [key: string]: any;
}
```

## License

ISC
