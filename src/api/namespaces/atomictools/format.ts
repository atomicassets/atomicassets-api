import { PublicKey } from '@wharfkit/antelope';

const keyTypeMap: Record<number, string> = { 0: 'K1', 1: 'R1', 2: 'WA' };

export function formatLink(row: any): any {
    const data = {...row};

    const typeName = keyTypeMap[data['key_type']] || 'K1';
    data['public_key'] = PublicKey.from({ type: typeName, compressed: data['key_data'] }).toString();

    delete data['key_type'];
    delete data['key_data'];

    return data;
}
