// OpenTelemetry tracing setup for merchant payment pipeline
export interface SpanContext {
  traceId: string;
  spanId: string;
  name: string;
  startTime: number;
  attributes: Record<string, string | number | boolean>;
}

export class PipelineTracer {
  private serviceName: string;

  constructor(serviceName = 'comebackhere-merchant-pipeline') {
    this.serviceName = serviceName;
  }

  startSpan(name: string, attributes: Record<string, string | number | boolean> = {}): SpanContext {
    return {
      traceId: Math.random().toString(36).substring(2, 18),
      spanId: Math.random().toString(36).substring(2, 10),
      name,
      startTime: Date.now(),
      attributes: {
        service: this.serviceName,
        ...attributes,
      },
    };
  }

  endSpan(span: SpanContext, status: 'OK' | 'ERROR' = 'OK', extraAttrs?: Record<string, string | number | boolean>) {
    const durationMs = Date.now() - span.startTime;
    const finalAttributes = {
      ...span.attributes,
      ...extraAttrs,
      durationMs,
      status,
    };
    return finalAttributes;
  }
}

export const pipelineTracer = new PipelineTracer();
