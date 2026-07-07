import { expect } from 'chai';
import express from 'express';
import supertest from 'supertest';

import { DocumentationServer, HTTPServer } from './server';

function makeDocsServer(): { app: express.Express; docs: DocumentationServer } {
    const app = express();
    const stub = {
        config: {
            server_name: 'test.api.atomicassets.io',
            provider_name: 'Test',
            provider_url: 'https://example.test',
        },
        connection: { chain: { name: 'wax' } },
        web: { express: app },
    } as unknown as HTTPServer;

    const docs = new DocumentationServer(stub);
    docs.addTags([{ name: 'assets' }]);
    docs.addPaths({ '/v1/assets': { get: { tags: ['assets'] } } });
    docs.render();
    return { app, docs };
}

describe('DocumentationServer /openapi.json', () => {
    it('serves the assembled OpenAPI 3.0 document as JSON', async () => {
        const { app, docs } = makeDocsServer();

        const res = await supertest(app).get('/openapi.json').expect(200);

        expect(res.body.openapi).to.equal('3.0.0');
        // The route serves the same object the Swagger UI renders, including
        // the paths and tags the namespaces registered.
        expect(res.body).to.deep.equal(docs.documentation);
        expect(res.body.paths).to.have.property('/v1/assets');
        expect(res.body.tags).to.deep.include({ name: 'assets' });
    });
});
