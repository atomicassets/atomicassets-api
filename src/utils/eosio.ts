import {
    deserializeEosioType as decodeEosioType,
    extractShipDeltas,
    extractShipTraces as extractPackageShipTraces,
    getActionAbiType,
    getTableAbiType,
    serializeEosioType
} from '@atomichub/antelope-ship-utils';
import { ABI, Name, UInt64 } from '@wharfkit/antelope';

import { deserializeUInt, serializeUInt } from './binary';
import { ShipTableDelta, ShipTransactionTrace } from '../types/ship';
import { EosioActionTrace, EosioContractRow, EosioTransaction } from '../types/eosio';

export function serializeEosioName(name: string): string {
    // Wharfkit Name.from().value returns the canonical big-endian uint64.
    // The database stores names in little-endian byte order (matching the
    // original eosjs pushName encoding), so we byte-reverse before storage.
    const beValue = BigInt(Name.from(name).value.toString());
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(beValue);
    const leValue = buf.readBigUInt64LE();

    return serializeUInt(leValue).toString();
}

export function deserializeEosioName(data: string): string {
    // Database stores little-endian uint64; convert back to big-endian
    // for wharfkit Name reconstruction.
    const leValue = deserializeUInt(data);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(leValue);
    const beValue = buf.readBigUInt64BE();

    return Name.from(UInt64.from(beValue) as UInt64).toString();
}

export function eosioTimestampToDate(timestamp: string): Date {
    return new Date(timestamp + '+0000');
}

export function splitEosioToken(asset: string, contract?: string): {amount: string, token_symbol: string, token_precision: number, token_contract?: string} {
    const split1 = asset.split(' ');
    const split2 = split1[0].split('.');

    return {
        amount: split2.join(''),
        token_symbol: split1[1],
        token_precision: split2[1] ? split2[1].length : 0,
        token_contract: contract
    };
}

// The serialization helpers come from @atomichub/antelope-ship-utils, the
// same code the package's BlockProcessor decodes with. The three wrappers
// below keep this service's call shapes: a decode that tolerates invalid
// UTF-8 in string fields, a trace extractor that takes the raw list, and a
// row extractor that returns flat rows.
export { getActionAbiType, getTableAbiType, serializeEosioType };

export function deserializeEosioType(type: string, data: Uint8Array | string, abi: ABI, _checkLength: boolean = true): any {
    // Chains carry memos and attribute values whose bytes no UTF-8 sequence
    // allows; the row is wanted, not the exception.
    return decodeEosioType(type, data, abi, { ignoreInvalidUTF8: true });
}

export function extractShipTraces(data: ShipTransactionTrace[]): Array<{trace: EosioActionTrace<any>, tx: EosioTransaction<any>}> {
    return extractPackageShipTraces({ traces: data });
}

export function extractShipContractRows(deltas: ShipTableDelta[]): Array<EosioContractRow<any>> {
    return extractShipDeltas({ deltas, serializedDeltas: ['contract_row'] }).map((row) => row.delta as EosioContractRow<any>);
}
