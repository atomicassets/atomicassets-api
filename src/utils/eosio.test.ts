import { ABI } from '@wharfkit/antelope';
import { expect } from 'chai';

import {
    serializeEosioName,
    deserializeEosioName,
    eosioTimestampToDate,
    splitEosioToken,
    deserializeEosioType,
    serializeEosioType,
    getTableAbiType,
    getActionAbiType,
} from './eosio';

describe('eosio utils', () => {
    describe('serializeEosioName / deserializeEosioName', () => {
        it('should serialize names to little-endian encoding (matching eosjs/database format)', () => {
            // These values match the original eosjs pushName encoding stored in the database
            expect(serializeEosioName('eosio').toString()).to.equal('15347797');
            expect(serializeEosioName('eosio.token').toString()).to.equal('46868006049558613');
            expect(serializeEosioName('pinknetworkx').toString()).to.equal('-3395250964074485845');
        });

        it('should deserialize little-endian values from the database', () => {
            expect(deserializeEosioName('15347797')).to.equal('eosio');
            expect(deserializeEosioName('46868006049558613')).to.equal('eosio.token');
            expect(deserializeEosioName('-3395250964074485845')).to.equal('pinknetworkx');
        });

        it('should round-trip names through serialize/deserialize', () => {
            const names = ['eosio', 'eosio.token', 'alice', 'pinknetworkx', 'bob', 'atomicassets', 'atomicmarket'];
            for (const name of names) {
                const serialized = serializeEosioName(name);
                const deserialized = deserializeEosioName(serialized);
                expect(deserialized).to.equal(name, `Failed round-trip for ${name}`);
            }
        });

        it('should be deterministic', () => {
            expect(serializeEosioName('eosio')).to.equal(serializeEosioName('eosio'));
        });
    });

    describe('eosioTimestampToDate', () => {
        it('should convert EOSIO timestamp to UTC Date', () => {
            const date = eosioTimestampToDate('2023-06-15T10:30:00.000');
            expect(date.toISOString()).to.equal('2023-06-15T10:30:00.000Z');
        });

        it('should handle timestamps without milliseconds', () => {
            const date = eosioTimestampToDate('2024-01-01T00:00:00');
            expect(date.toISOString()).to.equal('2024-01-01T00:00:00.000Z');
        });
    });

    describe('splitEosioToken', () => {
        it('should parse a token amount with precision', () => {
            const result = splitEosioToken('100.00000000 WAX');
            expect(result.amount).to.equal('10000000000');
            expect(result.token_symbol).to.equal('WAX');
            expect(result.token_precision).to.equal(8);
        });

        it('should parse a 4-precision token', () => {
            const result = splitEosioToken('50.0000 EOS');
            expect(result.amount).to.equal('500000');
            expect(result.token_symbol).to.equal('EOS');
            expect(result.token_precision).to.equal(4);
        });

        it('should handle whole numbers (no decimal)', () => {
            const result = splitEosioToken('1 TOKEN');
            expect(result.amount).to.equal('1');
            expect(result.token_symbol).to.equal('TOKEN');
            expect(result.token_precision).to.equal(0);
        });

        it('should include contract when provided', () => {
            const result = splitEosioToken('10.0000 EOS', 'eosio.token');
            expect(result.token_contract).to.equal('eosio.token');
        });

        it('should have undefined contract when not provided', () => {
            const result = splitEosioToken('10.0000 EOS');
            expect(result.token_contract).to.be.undefined;
        });
    });

    describe('deserializeEosioType / serializeEosioType', () => {
        const testAbi = ABI.from({
            version: 'eosio::abi/1.1',
            structs: [
                {
                    name: 'transfer',
                    base: '',
                    fields: [
                        { name: 'from', type: 'name' },
                        { name: 'to', type: 'name' },
                        { name: 'quantity', type: 'asset' },
                        { name: 'memo', type: 'string' },
                    ],
                },
            ],
            actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }],
            tables: [],
        });

        it('should round-trip a transfer action', () => {
            const original = {
                from: 'alice',
                to: 'bob',
                quantity: '10.00000000 WAX',
                memo: 'hello',
            };

            const serialized = serializeEosioType('transfer', original, testAbi);
            const deserialized = deserializeEosioType('transfer', serialized, testAbi);

            expect(deserialized.from).to.equal('alice');
            expect(deserialized.to).to.equal('bob');
            expect(deserialized.quantity).to.equal('10.00000000 WAX');
            expect(deserialized.memo).to.equal('hello');
        });

        it('should accept hex string input', () => {
            const original = { from: 'alice', to: 'bob', quantity: '1.0000 EOS', memo: '' };
            const serialized = serializeEosioType('transfer', original, testAbi);
            const hex = Buffer.from(serialized).toString('hex');

            const deserialized = deserializeEosioType('transfer', hex, testAbi);
            expect(deserialized.from).to.equal('alice');
        });

        it('should handle invalid UTF-8 in string fields without throwing', () => {
            // Serialize a valid transfer, then corrupt the memo bytes with invalid UTF-8
            const original = { from: 'alice', to: 'bob', quantity: '1.0000 EOS', memo: 'ok' };
            const serialized = serializeEosioType('transfer', original, testAbi);
            const buf = Buffer.from(serialized);

            // The memo is at the end: 1 byte varint length + N bytes content.
            // Replace the last content byte with 0xFF (invalid UTF-8 continuation byte)
            buf[buf.length - 1] = 0xff;

            const deserialized = deserializeEosioType('transfer', new Uint8Array(buf), testAbi);
            // Other fields decode normally
            expect(deserialized.from).to.equal('alice');
            expect(deserialized.to).to.equal('bob');
            expect(deserialized.quantity).to.equal('1.0000 EOS');
            // Invalid byte replaced with U+FFFD replacement character
            expect(deserialized.memo).to.include('\ufffd');
        });
    });

    describe('deserializeEosioType with ATOMIC_ATTRIBUTE values', () => {
        // Mirrors the atomicassets contract ABI: every attribute value is an
        // ATOMIC_ATTRIBUTE variant, and an action payload carries a list of them.
        const attributeAbi = ABI.from({
            version: 'eosio::abi/1.1',
            types: [
                { new_type_name: 'ATTRIBUTE_MAP', type: 'pair_string_ATOMIC_ATTRIBUTE[]' },
                { new_type_name: 'FLOAT_VEC', type: 'float32[]' },
                { new_type_name: 'DOUBLE_VEC', type: 'float64[]' },
            ],
            variants: [
                {
                    name: 'ATOMIC_ATTRIBUTE',
                    types: ['uint64', 'float32', 'float64', 'string', 'FLOAT_VEC', 'DOUBLE_VEC'],
                },
            ],
            structs: [
                {
                    name: 'pair_string_ATOMIC_ATTRIBUTE',
                    base: '',
                    fields: [
                        { name: 'key', type: 'string' },
                        { name: 'value', type: 'ATOMIC_ATTRIBUTE' },
                    ],
                },
                {
                    name: 'setassetdata',
                    base: '',
                    fields: [
                        { name: 'authorized_editor', type: 'name' },
                        { name: 'asset_owner', type: 'name' },
                        { name: 'asset_id', type: 'uint64' },
                        { name: 'new_mutable_data', type: 'ATTRIBUTE_MAP' },
                    ],
                },
            ],
            actions: [{ name: 'setassetdata', type: 'setassetdata', ricardian_contract: '' }],
            tables: [],
        });

        it('should decode float32 and float64 attributes as numbers', () => {
            const payload = {
                authorized_editor: 'editor11111',
                asset_owner: 'owner1111111',
                asset_id: '1099511627776',
                new_mutable_data: [
                    { key: 'wear', value: ['float32', 0.75] },
                    { key: 'score', value: ['float64', 92.13924923] },
                ],
            };

            const serialized = serializeEosioType('setassetdata', payload, attributeAbi);
            const deserialized = deserializeEosioType('setassetdata', serialized, attributeAbi);

            // The table path decodes the same attribute to a number, so the
            // action-payload path has to agree with it. A serializer that renders
            // the float wrappers through their toJSON yields '0.7500000' here.
            expect(deserialized.new_mutable_data).to.deep.equal([
                { key: 'wear', value: ['float32', 0.75] },
                { key: 'score', value: ['float64', 92.13924923] },
            ]);
            expect(typeof deserialized.new_mutable_data[0].value[1]).to.equal('number');
            expect(typeof deserialized.new_mutable_data[1].value[1]).to.equal('number');
        });

        it('should decode float vectors as arrays of numbers', () => {
            const payload = {
                authorized_editor: 'editor11111',
                asset_owner: 'owner1111111',
                asset_id: '1099511627777',
                new_mutable_data: [{ key: 'stats', value: ['DOUBLE_VEC', [1.5, 2.25]] }],
            };

            const serialized = serializeEosioType('setassetdata', payload, attributeAbi);
            const deserialized = deserializeEosioType('setassetdata', serialized, attributeAbi);

            expect(deserialized.new_mutable_data).to.deep.equal([
                { key: 'stats', value: ['DOUBLE_VEC', [1.5, 2.25]] },
            ]);
        });

        it('should leave the non-float attribute types unchanged', () => {
            const payload = {
                authorized_editor: 'editor11111',
                asset_owner: 'owner1111111',
                asset_id: '1099511627778',
                new_mutable_data: [
                    { key: 'name', value: ['string', 'Test NFT'] },
                    { key: 'level', value: ['uint64', 5] },
                    { key: 'mint', value: ['uint64', '18446744073709551000'] },
                ],
            };

            const serialized = serializeEosioType('setassetdata', payload, attributeAbi);
            const deserialized = deserializeEosioType('setassetdata', serialized, attributeAbi);

            // Only the two float types change shape. A uint64 beyond the safe
            // integer range still arrives as a decimal string, so no precision
            // is traded for the float fix.
            expect(deserialized.new_mutable_data).to.deep.equal([
                { key: 'name', value: ['string', 'Test NFT'] },
                { key: 'level', value: ['uint64', 5] },
                { key: 'mint', value: ['uint64', '18446744073709551000'] },
            ]);
            expect(deserialized.asset_id).to.equal('1099511627778');
        });
    });

    describe('getTableAbiType / getActionAbiType', () => {
        const abi = ABI.from({
            version: 'eosio::abi/1.1',
            structs: [
                { name: 'account', base: '', fields: [{ name: 'balance', type: 'asset' }] },
                { name: 'transfer', base: '', fields: [] },
            ],
            actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }],
            tables: [{ name: 'accounts', type: 'account', index_type: 'i64', key_names: [], key_types: [] }],
        });

        it('should find table type', () => {
            expect(getTableAbiType(abi, 'eosio.token', 'accounts')).to.equal('account');
        });

        it('should throw for unknown table', () => {
            expect(() => getTableAbiType(abi, 'c', 'missing')).to.throw('Type for table not found');
        });

        it('should find action type', () => {
            expect(getActionAbiType(abi, 'eosio.token', 'transfer')).to.equal('transfer');
        });

        it('should throw for unknown action', () => {
            expect(() => getActionAbiType(abi, 'c', 'missing')).to.throw('Type for action not found');
        });
    });
});
