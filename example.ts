import { createLogger, LoggerConfig } from './src/index';

// Example configuration
const config: LoggerConfig = {
  mysql: {
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: 'test',
    database: 'logs' // optional, defaults to 'logs'
  }
};

// Create logger instances
const { logger, fastifyLogger } = createLogger(config);

// Example usage
logger.info('Application started successfully');
logger.debug('Debug information', { userId: 123, action: 'login' });
logger.warn('Low memory warning', { available: '100MB', threshold: '200MB' });

// Error logging examples
try {
  throw new Error('Something went wrong');
} catch (err) {
  logger.error(err); // Logs with stack trace
}

// Enriched error logging
try {
  // Some database operation
  throw new Error('Connection timeout');
} catch (err) {
  logger.errorEnriched('Database query failed', err, { 
    query: 'SELECT * FROM users',
    timeout: 5000 
  });
}

// Object error logging
logger.error({ code: 'AUTH_FAILED', user: 'john@example.com' });
