import ConnectionManager from '../connections/manager';
import logger from '../utils/winston';
import { IConnectionsConfig, IServerConfig } from '../types/config';
import Api from '../api/api';
import {MetricsServer} from '../metrics/server';
import {HttpMetrics} from '../api/middlewares/http-metrics';
import { configFile } from '../utils/config-path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const serverConfig: IServerConfig = require(configFile('server.config.json'));

let connectionConfig: IConnectionsConfig = {postgres: {}, redis: {}, chain: {}} as IConnectionsConfig;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    connectionConfig = require(configFile('connections.config.json'));
} catch {
    logger.warn('No connections.config.json found. Falling back to environment variables');
}

logger.info('Starting API Server...');

process.on('unhandledRejection', error => {
    logger.error('Unhandled Rejection', error);
});

process.on('uncaughtException', error => {
    logger.error('Uncaught Exception', error);
});

const connection = new ConnectionManager(connectionConfig);

(async (): Promise<void> => {
    await connection.connect();

    connection.chain.checkChainId().then(result => {
        if (!result) {
            logger.error('Chain Id in config mismatches node chain id. Stopping API...');

            process.exit(1);
        }
    }).catch(error => {
        logger.error('Failed to query chain id on startup. Ignoring it but please check the config for the correct endpoint', error);
    });

    if (!(await connection.database.tableExists('dbinfo'))) {
        logger.error('Tables not initialized yet. Stopping API...');

        process.exit(1);
    }

    try {
        // Shared HTTP metrics instance: middleware records into its Registry
        // on the main API port; MetricsServer exposes that Registry alongside
        // the existing collector gauges on the separate metrics_port. The
        // ServiceMonitor in Kubernetes scrapes metrics_port, so HTTP latency
        // and the collector's pool/connection gauges are served from one
        // endpoint, matching the prometheus-adapter rule that feeds the HPA.
        const httpMetrics = new HttpMetrics({
            serviceName: 'eosio-contract-api-server',
            // Skip /metrics and infra probes so scrape and probe traffic
            // don't pollute the p95 used for HPA scaling. /metrics is served
            // both on this app (API port, scraped by ServiceMonitor) and on
            // MetricsServer's metrics_port (legacy scrape config).
            skipPaths: [
                '/metrics',
                '/health',
                '/healthc',
                '/alive',
                '/eosio-contract-api/metrics',
                '/eosio-contract-api/health',
                '/eosio-contract-api/alive',
            ],
        });
        const server = new Api(serverConfig, connection, httpMetrics);
        if (serverConfig.metrics_port) {
            new MetricsServer(serverConfig.metrics_port, connection, 'api', {}, httpMetrics).serve();
        }
        await server.listen();
    } catch (e) {
        // Exit so the orchestrator restarts us. The most common cause on a fresh
        // deployment is the contract-handler tables not existing yet (the filler
        // creates them via its startup migrations); restarting lets the server
        // retry until the schema is ready instead of sitting alive but not
        // listening. Mirrors the `dbinfo` check above, which also exits.
        logger.error('Failed to start server', e);
        process.exit(1);
    }
})();
