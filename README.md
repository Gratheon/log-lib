# log-lib

TypeScript logging library for Gratheon services with colored console output and optional OTLP log export to ClickStack/OpenTelemetry collectors.

## Version

`4.0.0` is the ClickStack/OTLP major release.

Breaking behavior change: Loki is no longer enabled implicitly. Configure `OTEL_EXPORTER_OTLP_ENDPOINT` for ClickStack logs, or set `LOKI_URL`/`config.loki` if a service still needs Loki during migration.

## Features

- Colored console logger for `info`, `warn`, `error`, and `debug`
- Optional OTLP HTTP JSON export for logs
- Optional Loki compatibility transport
- File/line capture for TypeScript callsites
- Enriched error logging with stack traces, cause chains, and dev-mode code frames
- Fastify logger adapter
- Log level filtering through `LOG_LEVEL`

## ClickStack Setup

For local Gratheon ClickStack:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=user-cycle
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=dev,service.namespace=gratheon
```

For containers that can reach the ClickStack compose service directly:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

The library posts logs to `/v1/logs`; pass either the collector base endpoint or a full logs endpoint.

## Usage

```typescript
import { createLogger } from '@gratheon/log-lib';

const { logger, fastifyLogger } = createLogger({
  otlp: {
    service: 'user-cycle',
    resourceAttributes: {
      'deployment.environment.name': 'dev',
    },
  },
  logLevel: 'info',
});

logger.info('service started');
logger.warn('slow request', { route: '/graphql', duration_ms: 830 });
logger.errorEnriched('job failed', new Error('boom'), { job: 'sync' });
```

Trace correlation is supported when metadata includes `trace_id`/`traceId` and `span_id`/`spanId`.

## Compatibility

Loki remains available explicitly:

```typescript
createLogger({
  loki: {
    url: 'http://loki:3100/loki/api/v1/push',
    service: 'legacy-service',
  },
});
```

`mysql` config is ignored and kept only so older services continue compiling while they migrate.
