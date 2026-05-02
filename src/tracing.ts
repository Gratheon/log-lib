import { context, propagation, trace, SpanKind, SpanStatusCode, Span } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import * as path from 'path';

import { LoggerConfig } from './types';

type HeaderCarrier = Record<string, string | string[] | undefined>;

let tracingConfigured = false;

function normalizeOtlpTracesEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, '');
  if (trimmed.endsWith('/v1/traces')) {
    return trimmed;
  }
  return `${trimmed}/v1/traces`;
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

function resolveService(config: LoggerConfig): string {
  const explicit = config.traces ?? config.otlp ?? {};
  return explicit.service ||
    process.env.OTEL_SERVICE_NAME ||
    process.env.SERVICE_NAME ||
    process.env.COMPOSE_SERVICE ||
    process.env.npm_package_name ||
    path.basename(process.cwd());
}

function resolveTraceConfig(config: LoggerConfig) {
  const explicit = config.traces ?? config.otlp ?? {};
  const rawEndpoint =
    explicit.endpoint ||
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    '';
  const enabled = explicit.enabled ?? rawEndpoint.trim() !== '';
  if (!enabled || rawEndpoint.trim() === '') {
    return null;
  }

  const service = resolveService(config);
  const resourceAttributes = {
    'service.name': service,
    'service.namespace': 'gratheon',
    'deployment.environment.name': process.env.ENV_ID || 'unknown',
    ...parseResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES),
    ...(explicit.resourceAttributes || {}),
  };

  return {
    endpoint: normalizeOtlpTracesEndpoint(rawEndpoint),
    headers: {
      ...(process.env.HYPERDX_API_KEY ? { authorization: process.env.HYPERDX_API_KEY } : {}),
      ...parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
      ...parseHeaders(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
      ...(explicit.headers || {}),
    },
    service,
    resourceAttributes,
  };
}

export function configureTracing(config: LoggerConfig = {}) {
  if (tracingConfigured) {
    return;
  }

  const traceConfig = resolveTraceConfig(config);
  if (!traceConfig) {
    return;
  }

  const exporter = new OTLPTraceExporter({
    url: traceConfig.endpoint,
    headers: traceConfig.headers,
  });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes(traceConfig.resourceAttributes),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  tracingConfigured = true;
}

export function injectTraceHeaders<T extends { set?: (key: string, value: string) => void } | Record<string, any>>(headers: T): T {
  propagation.inject(context.active(), headers, {
    set(carrier: any, key: string, value: string) {
      if (carrier && typeof carrier.set === 'function') {
        carrier.set(key, value);
        return;
      }
      carrier[key] = value;
    },
  });
  return headers;
}

export function traceHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return injectTraceHeaders(headers);
}

const headerGetter = {
  keys(carrier: HeaderCarrier): string[] {
    return Object.keys(carrier || {});
  },
  get(carrier: HeaderCarrier, key: string): undefined | string | string[] {
    return carrier?.[key] ?? carrier?.[key.toLowerCase()];
  },
};

function finishServerSpan(span: Span, statusCode?: number, error?: Error) {
  if (statusCode) {
    span.setAttribute('http.status_code', statusCode);
    if (statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
  }
  if (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }
  span.end();
}

export function traceExpressMiddleware(config: LoggerConfig = {}) {
  configureTracing(config);
  return (req: any, res: any, next: any) => {
    const parentContext = propagation.extract(context.active(), req.headers || {}, headerGetter);
    const route = req.route?.path || req.path || req.url || 'unknown';
    const span = trace.getTracer('gratheon-log-lib', '4.0.0').startSpan(`${req.method} ${route}`, {
      kind: SpanKind.SERVER,
      attributes: {
        'http.method': req.method,
        'http.route': route,
        'http.target': req.originalUrl || req.url,
        'http.user_agent': req.get?.('user-agent') || req.headers?.['user-agent'],
      },
    }, parentContext);
    const activeContext = trace.setSpan(parentContext, span);

    res.on('finish', () => finishServerSpan(span, res.statusCode));
    res.on('error', (error: Error) => finishServerSpan(span, res.statusCode, error));
    context.with(activeContext, () => next());
  };
}

export function registerFastifyTracing(app: any, config: LoggerConfig = {}) {
  configureTracing(config);
  const spans = new WeakMap<object, Span>();

  app.addHook('onRequest', (request: any, _reply: any, done: any) => {
    const parentContext = propagation.extract(context.active(), request.headers || {}, headerGetter);
    const route = request.routerPath || request.routeOptions?.url || request.raw?.url || request.url || 'unknown';
    const span = trace.getTracer('gratheon-log-lib', '4.0.0').startSpan(`${request.method} ${route}`, {
      kind: SpanKind.SERVER,
      attributes: {
        'http.method': request.method,
        'http.route': route,
        'http.target': request.raw?.url || request.url,
        'http.user_agent': request.headers?.['user-agent'],
      },
    }, parentContext);

    spans.set(request.raw || request, span);
    context.with(trace.setSpan(parentContext, span), done);
  });

  app.addHook('onError', (request: any, _reply: any, error: Error, done: any) => {
    const span = spans.get(request.raw || request);
    if (span) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    }
    done();
  });

  app.addHook('onResponse', (request: any, reply: any, done: any) => {
    const key = request.raw || request;
    const span = spans.get(key);
    if (span) {
      spans.delete(key);
      finishServerSpan(span, reply.statusCode);
    }
    done();
  });
}
