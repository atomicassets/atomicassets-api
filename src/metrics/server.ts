import * as os from 'os';
import express from 'express';
import {Registry} from 'prom-client';

import logger from '../utils/winston';
import ConnectionManager from '../connections/manager';
import {ICollectOptions, MetricsCollectorHandler} from './handler';
import {HttpMetrics} from '../api/middlewares/http-metrics';


export class MetricsServer {
    private readonly metricsCollector: MetricsCollectorHandler;
    private readonly server: express.Express;

    constructor(
        private readonly port: number,
        connections: ConnectionManager,
        process: 'api' | 'filler',
        options: ICollectOptions = {},
        private readonly httpMetrics?: HttpMetrics,
    ) {
        this.metricsCollector = new MetricsCollectorHandler(connections, process, os.hostname(), options);
        this.server = express();
    }

    serve(): void {
        this.server.all('/metrics', async (_req, res) => {
            const collectorOutput = await this.metricsCollector.getMetrics(new Registry());
            if (this.httpMetrics) {
                const httpOutput = await this.httpMetrics.getMetrics();
                res.send(`${collectorOutput}\n${httpOutput}`);
                return;
            }
            res.send(collectorOutput);
        });


        this.server.listen(this.port, () => logger.info(`Serving metrics on http://localhost:${this.port}/metrics`));
    }
}