import { expect } from 'chai';
import express from 'express';
import supertest from 'supertest';

import { HttpMetrics } from './http-metrics';

function makeApp(metrics: HttpMetrics): express.Express {
    const app = express();
    app.use(metrics.middleware());
    app.get('/v1/things/:id', (_req, res) => {
        res.status(200).send('ok');
    });
    app.post('/v1/things', (_req, res) => {
        res.status(201).json({ created: true });
    });
    app.get('/boom', (_req, res) => {
        res.status(500).send('nope');
    });
    return app;
}

describe('HttpMetrics middleware', () => {
    it('records duration histogram, request counter, and resets in-flight to zero', async () => {
        const metrics = new HttpMetrics({ serviceName: 'test-service' });
        const app = makeApp(metrics);

        await supertest(app).get('/v1/things/abc').expect(200);
        await supertest(app).post('/v1/things').expect(201);

        const output = await metrics.getMetrics();

        expect(output).to.match(
            /http_request_duration_seconds_bucket\{[^}]*route="\/v1\/things\/:id"[^}]*\}/,
        );
        expect(output).to.match(/http_requests_total\{[^}]*method="GET"[^}]*\} 1/);
        expect(output).to.match(/http_requests_total\{[^}]*method="POST"[^}]*\} 1/);
        // Default label key is `app`, not `service`, to avoid colliding with
        // Prometheus Operator's ServiceMonitor-injected `service` target label.
        expect(output).to.include('app="test-service"');
        expect(output).to.not.match(/service="test-service"/);
        expect(output).to.match(/http_requests_in_flight\{[^}]*\} 0/);
    });

    it('labels by status class, not raw status code', async () => {
        const metrics = new HttpMetrics({ serviceName: 'test-service' });
        const app = makeApp(metrics);

        await supertest(app).get('/boom').expect(500);

        const output = await metrics.getMetrics();
        expect(output).to.match(/http_requests_total\{[^}]*status_class="5xx"[^}]*\} 1/);
        expect(output).to.not.match(/status_class="500"/);
    });

    it('labels unmatched paths as "unmatched"', async () => {
        const metrics = new HttpMetrics({ serviceName: 'test-service' });
        const app = makeApp(metrics);

        await supertest(app).get('/no-such-route').expect(404);

        const output = await metrics.getMetrics();
        expect(output).to.match(/http_requests_total\{[^}]*route="unmatched"[^}]*\} 1/);
    });

    it('only decrements in-flight once when both finish and close fire', async () => {
        const metrics = new HttpMetrics({ serviceName: 'test-service' });
        const app = makeApp(metrics);

        await supertest(app).get('/v1/things/abc').expect(200);

        const output = await metrics.getMetrics();
        const match = output.match(/http_requests_in_flight\{[^}]*\} (-?\d+)/);
        expect(match, 'in-flight gauge present').to.not.be.null;
        expect(match![1]).to.equal('0');
    });

    it('skips configured paths (exact match) from instrumentation', async () => {
        const metrics = new HttpMetrics({
            serviceName: 'test-service',
            skipPaths: ['/metrics', '/health'],
        });
        const app = express();
        app.use(metrics.middleware());
        app.get('/metrics', (_req, res) => res.status(200).send('# metrics'));
        app.get('/health', (_req, res) => res.status(200).send('ok'));
        app.get('/v1/things/:id', (_req, res) => res.status(200).send('ok'));

        await supertest(app).get('/metrics').expect(200);
        await supertest(app).get('/health').expect(200);
        await supertest(app).get('/v1/things/abc').expect(200);

        const output = await metrics.getMetrics();
        // Only the non-skipped path appears in the counter.
        expect(output).to.match(/http_requests_total\{[^}]*route="\/v1\/things\/:id"[^}]*\} 1/);
        expect(output).to.not.match(/route="\/metrics"/);
        expect(output).to.not.match(/route="\/health"/);
    });

    it('skips configured paths matched as a prefix with "/"', async () => {
        const metrics = new HttpMetrics({
            serviceName: 'test-service',
            skipPaths: ['/health'],
        });
        const app = express();
        app.use(metrics.middleware());
        app.get('/health/db', (_req, res) => res.status(200).send('ok'));
        app.get('/healthy-suffix', (_req, res) => res.status(200).send('ok'));

        // /health/db should be skipped (prefix + "/").
        await supertest(app).get('/health/db').expect(200);
        // /healthy-suffix should NOT be skipped - it's not a sub-path of /health.
        await supertest(app).get('/healthy-suffix').expect(200);

        const output = await metrics.getMetrics();
        expect(output).to.not.match(/route="\/health\/db"/);
        expect(output).to.match(/http_requests_total\{[^}]*route="\/healthy-suffix"[^}]*\} 1/);
    });
});
