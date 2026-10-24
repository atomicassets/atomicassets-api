import {expect} from 'chai';
import express from 'express';
import supertest from 'supertest';

import ConnectionManager from '../connections/manager';
import {IServerConfig} from '../types/config';
import {mergeRequestData} from './namespaces/utils';
import {HTTPServer} from './server';

describe('WebServer request parsers', () => {
    const limit = 10 * 1024 * 1024;
    let server: HTTPServer;
    let app: express.Application;

    before(() => {
        const connection = {
            database: {createPool: () => ({})},
            redis: {ioRedis: {}},
            // Keep the health poll pending without timers or external services.
            chain: {name: 'test', rpc: {get_info: () => new Promise(() => {})}},
        } as unknown as ConnectionManager;
        server = new HTTPServer({} as IServerConfig, connection);
        app = server.web.express;
        app.set('env', 'test');
        app.post('/parser', (req, res) => res.json(mergeRequestData(req)));
        app.post('/body-size', (req, res) => res.json({bytes: Buffer.byteLength(req.body.value)}));
    });

    after(() => {
        server.socket.io.close();
    });

    it('parses JSON before merging body values over query parameters', async () => {
        const body = {value: 1.25, nested: {enabled: true}, items: ['one', 'two']};
        const res = await supertest(app).post('/parser?value=query&queryOnly=yes')
            .set('Origin', 'https://example.test')
            .send(body).expect(200);

        expect(res.body).to.deep.equal({...body, queryOnly: 'yes'});
        expect(res.headers['access-control-allow-origin']).to.equal('https://example.test');
    });

    it('keeps form bracket keys literal and repeated values as arrays (extended: false)', async () => {
        const res = await supertest(app).post('/parser?value=query&queryOnly=yes')
            .type('form').send('value=body&nested[key]=literal&item=one&item=two').expect(200);

        expect(res.body).to.deep.equal({
            value: 'body', queryOnly: 'yes', 'nested[key]': 'literal', item: ['one', 'two'],
        });
    });

    it('allows an empty request body', async () => {
        const res = await supertest(app).post('/parser?queryOnly=yes').expect(200);
        expect(res.body).to.deep.equal({queryOnly: 'yes'});
    });

    it('leaves unrecognized content types unparsed', async () => {
        const res = await supertest(app).post('/parser?queryOnly=yes')
            .type('text').send('{"value":"ignored"}').expect(200);
        expect(res.body).to.deep.equal({queryOnly: 'yes'});
    });

    for (const payload of ['{"value":', '"primitive"']) {
        it(`returns the existing HTML 400 response before CORS for invalid JSON: ${payload}`, async () => {
            const res = await supertest(app).post('/parser')
                .set('Origin', 'https://example.test')
                .type('json').send(payload).expect(400).expect('Content-Type', /text\/html/);

            expect(res.headers).to.have.property('last-modified');
            expect(res.headers).not.to.have.property('access-control-allow-origin');
            expect(res.headers).not.to.have.property('access-control-allow-headers');
        });
    }

    it('rejects an unsupported JSON charset with 415', async () => {
        await supertest(app).post('/parser')
            .set('Content-Type', 'application/json; charset=iso-8859-1')
            .send('{"value":"test"}').expect(415).expect('Content-Type', /text\/html/);
    });

    for (const type of ['json', 'form']) {
        function payload(bytes: number): string {
            // Include a multibyte character to exercise the byte limit for JSON.
            return type === 'json'
                ? '{"value":"\u00e9' + 'a'.repeat(bytes - Buffer.byteLength('{"value":"\u00e9"}')) + '"}'
                : 'value=' + 'a'.repeat(bytes - 'value='.length);
        }

        it(`accepts a ${type} body exactly at the 10MB byte limit`, async () => {
            const body = payload(limit);
            expect(Buffer.byteLength(body)).to.equal(limit);

            const res = await supertest(app).post('/body-size').type(type).send(body).expect(200);
            expect(res.body.bytes).to.equal(limit - (type === 'json' ? 12 : 6));
        });

        it(`rejects a ${type} body one byte over 10MB with the existing HTML 413 response`, async () => {
            const body = payload(limit + 1);
            expect(Buffer.byteLength(body)).to.equal(limit + 1);

            const res = await supertest(app).post('/body-size')
                .set('Origin', 'https://example.test')
                .type(type).send(body).expect(413).expect('Content-Type', /text\/html/);

            expect(res.headers).not.to.have.property('access-control-allow-origin');
        });
    }
});
