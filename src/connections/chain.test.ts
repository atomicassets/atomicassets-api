import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { ABI, Name, Serializer } from '@wharfkit/antelope';

import ChainApi from './chain';

/**
 * The RPC adapter renders every decoded client result through one helper, so a
 * float64 the client hands back reaches the caller as a JavaScript number
 * rather than as the fixed-precision string a wharfkit objectify produces.
 * atomicmarket's config row is the shape that matters: its market fees are
 * float64, and the filler stores what this adapter returns.
 */
describe('ChainApi rpc adapter', () => {
    const feeAbi = ABI.from({
        version: 'eosio::abi/1.1',
        structs: [
            {
                name: 'config',
                base: '',
                fields: [
                    { name: 'maker_market_fee', type: 'float64' },
                    { name: 'taker_market_fee', type: 'float64' },
                    { name: 'version', type: 'string' },
                ],
            },
        ],
        actions: [],
        tables: [{ name: 'config', type: 'config', index_type: 'i64', key_names: [], key_types: [] }],
    });

    function decodedConfigRow(): unknown {
        const bytes = Serializer.encode({
            object: { maker_market_fee: 0.02, taker_market_fee: 0.05, version: '1.2.0' },
            type: 'config',
            abi: feeAbi,
        }).array;

        return Serializer.decode({ data: bytes, type: 'config', abi: feeAbi });
    }

    let api: ChainApi;

    beforeEach(() => {
        // The provider is never reached: every client method under test is stubbed.
        api = new ChainApi('http://127.0.0.1:1', 'test', 'testchainid');
    });

    afterEach(() => {
        sinon.restore();
    });

    it('should return a float64 field as a number', async () => {
        sinon.stub(api.client.v1.chain, 'get_info').resolves(decodedConfigRow() as any);

        const result = await api.rpc.get_info();

        expect(result.maker_market_fee).to.equal(0.02);
        expect(typeof result.maker_market_fee).to.equal('number');
        expect(result.taker_market_fee).to.equal(0.05);
        expect(typeof result.taker_market_fee).to.equal('number');
    });

    it('should still render the non-float parts of a decoded result', async () => {
        sinon.stub(api.client.v1.chain, 'get_abi').resolves({
            account_name: Name.from('atomicassets'),
            abi: feeAbi,
        } as any);

        const result = await api.rpc.get_abi('atomicassets');

        expect(result.account_name).to.equal('atomicassets');
        expect(result.abi.version).to.equal('eosio::abi/1.1');
        expect(result.abi.structs[0].fields[2]).to.deep.equal({ name: 'version', type: 'string' });
    });
});
