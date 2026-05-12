import express from 'express';

import { ApiNamespace } from './namespaces/interfaces';
import { HTTPServer } from './server';
import { IServerConfig } from '../types/config';
import ConnectionManager from '../connections/manager';
import { getNamespaces } from './namespaces';
import { HttpMetrics } from './middlewares/http-metrics';

export default class Api {
    private readonly namespaces: ApiNamespace[];
    private readonly server: HTTPServer;

    constructor(
        private readonly config: IServerConfig,
        private readonly connection: ConnectionManager,
        httpMetrics?: HttpMetrics,
    ) {
        this.namespaces = getNamespaces(config.namespaces, connection);
        this.server = new HTTPServer(config, connection, httpMetrics);
    }

    async listen(): Promise<void> {
        for (const namespace of this.namespaces) {
            await namespace.init();
            this.server.web.express.use(namespace.path, await namespace.router(this.server));
            await namespace.socket(this.server);
        }

        this.server.docs.render();

        this.server.web.express.use((_: express.Request, res: express.Response) => {
            res.status(404).json({
                success: false, message: 'Endpoint not found'
            });
        });

        this.server.listen();
    }
}
