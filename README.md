# log-lib

A TypeScript logging library with console output and MySQL database persistence support.

## Features

- **Dual Output**: Logs to both console and MySQL database
- **Color-Coded Console**: ANSI colored output for different log levels
- **TypeScript Support**: Full type definitions included
- **Fastify Integration**: Special logger interface for Fastify framework
- **Flexible Metadata**: Support for structured metadata in logs
- **Error Handling**: Graceful handling of database connection failures
- **Multiple Log Levels**: info, error, warn, debug (debug logs are not persisted to DB)

## Installation

```bash
npm install @gratheon/log-lib
```

## Database Setup

Before using the logger, you need to set up the MySQL database. Run the migration script:

```bash
mysql -u root -p < migrations/001-create-logs-table.sql
```

This will create:
- A `logs` database
- A `logs` table with fields: id, level, message, meta, timestamp

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

// Error with stack trace
try {
  throw new Error('Something went wrong');
} catch (err) {
  logger.error(err); // Logs error with stack trace
}

// Enriched error logging
logger.errorEnriched('Database query failed', err, { query: 'SELECT * FROM users' });
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
- `fatal(msg: any)` - Logs error and calls `process.exit(1)`
- `trace(msg: any)` - No-op
- `child(meta: any)` - Returns the same logger instance

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

The logger gracefully handles database connection failures:
- Logs are always written to console
- Database errors are logged to console only
- Application continues running even if database is unavailable
- Connection errors (ECONNREFUSED, ENOTFOUND, ETIMEDOUT) are handled with warnings

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
