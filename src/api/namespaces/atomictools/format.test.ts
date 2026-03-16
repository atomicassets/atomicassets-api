import * as assert from 'assert';
import { formatLink } from './format';

describe('formatLink', () => {
    // Real K1 compressed public key bytes (33 bytes)
    const compressedKey = new Uint8Array([
        0x02, 0x23, 0x87, 0x46, 0x72, 0x38, 0x54, 0xf1,
        0xbd, 0x68, 0x3f, 0xe2, 0xe8, 0x4a, 0xfb, 0xbb,
        0xbb, 0x81, 0x8c, 0xff, 0xcf, 0xea, 0xff, 0xb8,
        0xac, 0x95, 0xf3, 0x65, 0xd2, 0xa8, 0x41, 0xe7, 0x26,
    ]);

    it('returns public_key in PUB_K1_ format, not legacy EOS format', () => {
        const row = { key_type: 0, key_data: compressedKey, link_id: 1 };
        const result = formatLink(row);

        assert.ok(
            result.public_key.startsWith('PUB_K1_'),
            `Expected PUB_K1_ prefix but got: ${result.public_key}`
        );
        assert.ok(
            !result.public_key.startsWith('EOS'),
            `Must not use legacy EOS prefix: ${result.public_key}`
        );
    });

    it('removes key_type and key_data from output', () => {
        const row = { key_type: 0, key_data: compressedKey, link_id: 1 };
        const result = formatLink(row);

        assert.strictEqual(result.key_type, undefined);
        assert.strictEqual(result.key_data, undefined);
        assert.strictEqual(result.link_id, 1);
    });

    it('does not mutate the input row', () => {
        const row = { key_type: 0, key_data: compressedKey, link_id: 1 };
        formatLink(row);

        assert.strictEqual(row.key_type, 0);
        assert.ok(row.key_data);
    });

    it('defaults to K1 for unknown key_type', () => {
        const row = { key_type: 99, key_data: compressedKey };
        const result = formatLink(row);

        assert.ok(result.public_key.startsWith('PUB_K1_'));
    });
});
