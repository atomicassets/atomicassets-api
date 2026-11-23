import 'mocha';
import {expect} from 'chai';
import express from 'express';
import bodyParser from 'body-parser';
import request from 'supertest';
import {initAtomicMarketTest} from '../test';
import {getTestContext} from '../../../../utils/test';
import {getTemplateStatsAction} from './stats';
import {mergeRequestData} from '../../utils';
import {respondApiError} from '../../../utils';

const {client, txit} = initAtomicMarketTest();

describe('AtomicMarket template stats boolean filters', () => {
    for (const method of ['get', 'post'] as const) {
        for (const hideUnlisted of [true, 'true', false, 'false', undefined]) {
            txit(`${method.toUpperCase()} filters listed templates with hide_unlisted_templates=${JSON.stringify(hideUnlisted)}`, async () => {
                await client.createContractReader();
                const unlisted = await client.createTemplate();
                const listed = await client.createTemplate();
                await client.createFullSale({collection_name: listed.collection_name}, {template_id: listed.template_id});
                await client.refreshSalesFilters();

                const context = getTestContext(client);
                const app = express();
                app.use(bodyParser.json());
                app.all('/atomicmarket/v1/stats/templates', async (req, res) => {
                    try {
                        res.json(await getTemplateStatsAction(mergeRequestData(req), context));
                    } catch (error) {
                        respondApiError(res, error);
                    }
                });

                const params = {
                    symbol: 'TEST', sort: 'sales', limit: '1', after: '9999999999999',
                    ...(hideUnlisted === undefined ? {} : {hide_unlisted_templates: hideUnlisted}),
                };
                const call = request(app)[method]('/atomicmarket/v1/stats/templates');
                const response = await (method === 'get' ? call.query(params) : call.send(params)).expect(200);
                const hidden = hideUnlisted === true || hideUnlisted === 'true';
                const expectedId = hidden ? listed.template_id : unlisted.template_id;
                expect(response.body.results.map((row: any) => row.template.template_id)).to.deep.equal([expectedId]);
                expect(response.body.results[0]).to.include({sales: '0', volume: '0'});

                for (const invalid of ['TRUE', 'FALSE', '2', 'invalid']) {
                    const params = {symbol: 'TEST', hide_unlisted_templates: invalid};
                    const call = request(app)[method]('/atomicmarket/v1/stats/templates');
                    const response = await (method === 'get' ? call.query(params) : call.send(params)).expect(400);
                    expect(response.body).to.deep.equal({success: false, message: 'Invalid value for parameter hide_unlisted_templates'});
                }
            });
        }
    }

    after(async () => await client.end());
});
