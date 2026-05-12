import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export type HttpMetricsOptions = {
    serviceName: string;
    registry?: Registry;
    buckets?: number[];
    // Paths to skip from instrumentation. Matched by exact path or as a prefix
    // followed by '/'. Defaults to empty. Typical use: ['/metrics', '/health']
    // to keep scrape/probe traffic out of the latency histogram (Prometheus
    // scrapes would otherwise feed back into the p95 used for HPA scaling).
    skipPaths?: string[];
};

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class HttpMetrics {
    public readonly registry: Registry;
    public readonly requestsTotal: Counter<string>;
    public readonly requestDurationSeconds: Histogram<string>;
    public readonly requestsInFlight: Gauge<string>;
    private readonly skipPaths: string[];

    constructor(options: HttpMetricsOptions) {
        this.registry = options.registry ?? new Registry();
        // Default label key is `app`, not `service`: Prometheus Operator's
        // ServiceMonitor relabel chain already injects `service` as a target
        // label from the K8s Service name. Reusing `service` here would
        // collide and Prometheus would rename our label to `exported_service`,
        // breaking queries that group by `service`.
        this.registry.setDefaultLabels({ app: options.serviceName });

        this.skipPaths = options.skipPaths ?? [];

        this.requestsTotal = new Counter({
            name: 'http_requests_total',
            help: 'Total HTTP requests served, labelled by method, status class, and matched route',
            registers: [this.registry],
            labelNames: ['method', 'status_class', 'route'],
        });

        this.requestDurationSeconds = new Histogram({
            name: 'http_request_duration_seconds',
            help: 'HTTP request duration in seconds',
            registers: [this.registry],
            labelNames: ['method', 'status_class', 'route'],
            buckets: options.buckets ?? DEFAULT_BUCKETS,
        });

        this.requestsInFlight = new Gauge({
            name: 'http_requests_in_flight',
            help: 'Number of HTTP requests currently being processed',
            registers: [this.registry],
            labelNames: ['method'],
        });
    }

    public middleware(): RequestHandler {
        return (req: Request, res: Response, next: NextFunction): void => {
            if (this.shouldSkip(req.path)) {
                next();
                return;
            }

            const method = req.method;
            this.requestsInFlight.inc({ method });
            const startNanos = process.hrtime.bigint();
            let recorded = false;

            const finalize = (): void => {
                if (recorded) return;
                recorded = true;
                const durationSeconds = Number(process.hrtime.bigint() - startNanos) / 1e9;
                const route = resolveRouteLabel(req);
                const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
                this.requestDurationSeconds.observe(
                    { method, status_class: statusClass, route },
                    durationSeconds,
                );
                this.requestsTotal.inc({ method, status_class: statusClass, route });
                this.requestsInFlight.dec({ method });
            };

            res.once('finish', finalize);
            res.once('close', finalize);
            next();
        };
    }

    public async getMetrics(): Promise<string> {
        return this.registry.metrics();
    }

    public contentType(): string {
        return this.registry.contentType;
    }

    private shouldSkip(reqPath: string): boolean {
        for (const skip of this.skipPaths) {
            if (reqPath === skip || reqPath.startsWith(`${skip}/`)) return true;
        }
        return false;
    }
}

function resolveRouteLabel(req: Request): string {
    const route = `${req.baseUrl ?? ''}${req.route?.path ?? ''}`;
    return route.length > 0 ? route : 'unmatched';
}
