import { objectifyNumericFloats } from '@atomichub/antelope-ship-utils';
import { ABI, Serializer } from '@wharfkit/antelope';
import { expect } from 'chai';

import {
    deserializeEosioType,
    extractShipContractRows,
    extractShipTraces,
    getActionAbiType,
    getTableAbiType
} from './eosio';
import { ShipTableDelta, ShipTransactionTrace } from '../types/ship';
import { EosioActionTrace, EosioContractRow, EosioTransaction } from '../types/eosio';

// The reference bodies are the helpers this service carried before it took
// them from @atomichub/antelope-ship-utils, kept here so the package-backed
// exports are proven equal on every fixture the filler meets.
/* eslint-disable @typescript-eslint/no-unused-vars */
function referenceDeserializeEosioType(type: string, data: Uint8Array | string, abi: ABI, _checkLength: boolean = true): any {
    let dataArray;
    if (typeof data === 'string') {
        dataArray = Uint8Array.from(Buffer.from(data, 'hex'));
    } else {
        dataArray = new Uint8Array(data);
    }

    const result = Serializer.decode({ data: dataArray, type, abi, ignoreInvalidUTF8: true });

    // Serializer.objectify renders the Float32 and Float64 wrappers as strings,
    // so a float attribute decoded here would reach jsonb as a string where the
    // @atomichub/atomicassets deserialize stores a number. Under
    // @wharfkit/antelope 1.x that string is lossy as well, because
    // Float32.toString is toFixed(7). From 2.x it is the shortest round-trip
    // string (wharfkit/antelope f70dadd), so the numeric objectify stays a
    // shape choice there. A non-finite value has no JSON number, and
    // JSON.stringify writes it as null.
    return objectifyNumericFloats(result);
}

function referenceExtractShipTraces(data: ShipTransactionTrace[]): Array<{trace: EosioActionTrace<any>, tx: EosioTransaction<any>}> {
    const transactions: EosioTransaction[] = [];

    for (const transaction of data) {
        if (transaction[0] === 'transaction_trace_v0') {
            if (transaction[1].status !== 0) {
                continue;
            }

            transactions.push({
                id: transaction[1].id,
                cpu_usage_us: transaction[1].cpu_usage_us,
                net_usage_words: transaction[1].net_usage_words,
                traces: transaction[1].action_traces.map(trace => {
                    if (trace[0] === 'action_trace_v0' || trace[0] === 'action_trace_v1') {
                        if (trace[1].receiver !== trace[1].act.account) {
                            return null;
                        }

                        return {
                            action_ordinal: trace[1].action_ordinal,
                            creator_action_ordinal: trace[1].creator_action_ordinal,
                            global_sequence: trace[1].receipt[1].global_sequence,
                            account_ram_deltas: trace[1].account_ram_deltas,
                            act: {
                                account: trace[1].act.account,
                                name: trace[1].act.name,
                                authorization: trace[1].act.authorization,
                                data: trace[1].act.data
                            }
                        };
                    }

                    throw new Error('Invalid action trace type ' + trace[0]);
                }).filter(trace => !!trace).sort((a, b) => {
                    return parseInt(a.global_sequence, 10) - parseInt(b.global_sequence, 10);
                })
            });
        } else {
            throw new Error('Unsupported transaction response received: ' + transaction[0]);
        }
    }

    const result: Array<{trace: EosioActionTrace<any>, tx: EosioTransaction<any>}> = [];

    for (const tx of transactions) {
        for (const trace of tx.traces) {
            result.push({trace, tx});
        }
    }

    result.sort((a, b) => {
        return parseInt(a.trace.global_sequence, 10) - parseInt(b.trace.global_sequence, 10);
    });

    return result;
}

function referenceExtractShipContractRows(deltas: ShipTableDelta[]): Array<EosioContractRow<any>> {
    const result: EosioContractRow<any>[] = [];

    for (const delta of deltas) {
        if (delta[0] === 'table_delta_v0' || delta[0] === 'table_delta_v1') {
            if (delta[1].name === 'contract_row') {
                for (const row of delta[1].rows) {
                    if (row.data[0] === 'contract_row_v0') {
                        result.push({...row.data[1], present: !!row.present});
                    } else {
                        throw new Error('Unsupported contract row received: ' + row.data[0]);
                    }
                }
            }
        } else {
            throw new Error('Unsupported table delta response received: ' + delta[0]);
        }
    }

    return result;
}

function referenceGetTableAbiType(abi: ABI, contract: string, table: string): string {
    for (const row of abi.tables) {
        if (row.name == table) {
            return String(row.type);
        }
    }

    throw new Error('Type for table not found ' + contract + ':' + table);
}

function referenceGetActionAbiType(abi: ABI, contract: string, action: string): string {
    for (const row of abi.actions) {
        if (row.name == action) {
            return String(row.type);
        }
    }

    throw new Error('Type for action not found ' + contract + ':' + action);
}

/* eslint-enable @typescript-eslint/no-unused-vars */

const abi = ABI.from({
    version: 'eosio::abi/1.1',
    types: [],
    structs: [
        {name: 'transfer', base: '', fields: [
            {name: 'from', type: 'name'}, {name: 'to', type: 'name'}, {name: 'quantity', type: 'asset'}, {name: 'memo', type: 'string'}
        ]},
        {name: 'attrs', base: '', fields: [
            {name: 'weight', type: 'float32'}, {name: 'ratio', type: 'float64'}, {name: 'tags', type: 'string[]'}, {name: 'id', type: 'uint64'}
        ]},
        {name: 'pair', base: '', fields: [{name: 'id', type: 'uint64'}]}
    ],
    actions: [{name: 'transfer', type: 'transfer', ricardian_contract: ''}],
    tables: [{name: 'pairs', type: 'pair', index_type: 'i64', key_names: [], key_types: []}],
    variants: []
});

function encode(type: string, object: any): Uint8Array {
    return Serializer.encode({object, type, abi}).array;
}

function trace(ordinal: number, account: string, receiver: string, name: string, seq: string, data: Uint8Array): any {
    return ['action_trace_v1', {
        action_ordinal: ordinal,
        creator_action_ordinal: ordinal > 1 ? 1 : 0,
        receipt: ['action_receipt_v0', {receiver, global_sequence: seq}],
        receiver,
        account_ram_deltas: [{account, delta: 8}],
        act: {account, name, authorization: [{actor: account, permission: 'active'}], data}
    }];
}

const transferBytes = encode('transfer', {from: 'alice', to: 'bob', quantity: '1.00000000 WAX', memo: 'ok'});

const traces: ShipTransactionTrace[] = [
    ['transaction_trace_v0', {
        id: 'aa', status: 0, cpu_usage_us: 10, net_usage_words: 2,
        action_traces: [
            trace(2, 'eosio.token', 'bob', 'transfer', '102', transferBytes),
            trace(1, 'eosio.token', 'eosio.token', 'transfer', '100', transferBytes),
            trace(3, 'atomicassets', 'atomicassets', 'logmint', '101', new Uint8Array([1, 2, 3]))
        ]
    } as any],
    ['transaction_trace_v0', {id: 'bb', status: 1, cpu_usage_us: 0, net_usage_words: 0, action_traces: [trace(1, 'x', 'x', 'y', '99', new Uint8Array())]} as any],
    ['transaction_trace_v0', {
        id: 'cc', status: 0, cpu_usage_us: 5, net_usage_words: 1,
        action_traces: [['action_trace_v0', {
            action_ordinal: 1, creator_action_ordinal: 0, receipt: ['action_receipt_v0', {receiver: 'z', global_sequence: '90'}], receiver: 'z',
            account_ram_deltas: [], act: {account: 'z', name: 'w', authorization: [], data: new Uint8Array([9])}
        }]]
    } as any]
];

const deltas: ShipTableDelta[] = [
    ['table_delta_v0', {name: 'contract_row', rows: [
        {present: true, data: ['contract_row_v0', {code: 'atomicassets', scope: 'atomicassets', table: 'config', primary_key: '0', payer: 'atomicassets', value: new Uint8Array([1])}]},
        {present: false, data: ['contract_row_v0', {code: 'atomicassets', scope: 'alice', table: 'assets', primary_key: '7', payer: 'alice', value: new Uint8Array([2, 2])}]}
    ]} as any],
    ['table_delta_v1', {name: 'account', rows: [{present: true, data: ['account_v0', {name: 'alice'}]}]} as any]
];

describe('eosio utils, package-backed helpers against the reference bodies', () => {
    it('deserializeEosioType decodes a transfer, an attribute struct with floats, and a hex string alike', () => {
        const attrs = encode('attrs', {weight: 92.13924923, ratio: 0.1, tags: ['a', 'b'], id: 42});
        for (const [type, data] of [['transfer', transferBytes], ['attrs', attrs], ['attrs', Buffer.from(attrs).toString('hex')]] as Array<[string, Uint8Array | string]>) {
            expect(deserializeEosioType(type, data, abi)).to.deep.equal(referenceDeserializeEosioType(type, data, abi));
        }
        const decoded = deserializeEosioType('attrs', attrs, abi);
        expect(decoded.weight).to.be.a('number');
        expect(decoded.ratio).to.equal(0.1);
    });

    it('deserializeEosioType tolerates invalid UTF-8 in a string field as the reference did', () => {
        const invalid = Uint8Array.from(transferBytes);
        invalid[invalid.length - 2] = 0xff;
        invalid[invalid.length - 1] = 0xfe;
        const viaPackage = deserializeEosioType('transfer', invalid, abi);
        expect(viaPackage).to.deep.equal(referenceDeserializeEosioType('transfer', invalid, abi));
        expect(viaPackage.from).to.equal('alice');
    });

    it('extractShipTraces drops failed transactions and notified receivers, keeps v0 and v1 traces, and orders by global sequence', () => {
        const viaPackage = extractShipTraces(traces);
        expect(viaPackage).to.deep.equal(referenceExtractShipTraces(traces));
        expect(viaPackage.map((t) => t.trace.global_sequence)).to.deep.equal(['90', '100', '101']);
        expect(viaPackage.map((t) => t.tx.id)).to.deep.equal(['cc', 'aa', 'aa']);
    });

    it('extractShipTraces throws on an unknown trace or transaction shape as the reference did', () => {
        const badTrace = [['transaction_trace_v0', {id: 'd', status: 0, cpu_usage_us: 0, net_usage_words: 0, action_traces: [['action_trace_v9', {}]]}]] as any;
        const badTx = [['transaction_trace_v9', {}]] as any;
        expect(() => extractShipTraces(badTrace)).to.throw('Invalid action trace type action_trace_v9');
        expect(() => referenceExtractShipTraces(badTrace)).to.throw('Invalid action trace type action_trace_v9');
        expect(() => extractShipContractRows(badTx)).to.throw('Unsupported table delta response received: transaction_trace_v9');
        expect(() => extractShipTraces(badTx)).to.throw('Unsupported transaction response received: transaction_trace_v9');
    });

    it('extractShipContractRows keeps contract_row rows flat with present and skips other delta names', () => {
        const viaPackage = extractShipContractRows(deltas);
        expect(viaPackage).to.deep.equal(referenceExtractShipContractRows(deltas));
        expect(viaPackage).to.have.length(2);
        expect(viaPackage[1].present).to.equal(false);
        expect(viaPackage[1].table).to.equal('assets');
    });

    it('getTableAbiType and getActionAbiType resolve and throw as the reference did', () => {
        expect(getTableAbiType(abi, 'c', 'pairs')).to.equal(referenceGetTableAbiType(abi, 'c', 'pairs'));
        expect(getActionAbiType(abi, 'c', 'transfer')).to.equal(referenceGetActionAbiType(abi, 'c', 'transfer'));
        expect(() => getTableAbiType(abi, 'c', 'nope')).to.throw('Type for table not found c:nope');
        expect(() => getActionAbiType(abi, 'c', 'nope')).to.throw('Type for action not found c:nope');
    });
});
