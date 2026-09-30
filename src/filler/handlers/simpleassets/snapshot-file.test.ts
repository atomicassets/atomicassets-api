import 'mocha';
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSnapshotRows } from './snapshot-file';

describe('readSnapshotRows', () => {
    let dir: string;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-snapshot-'));
    });

    after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function write(name: string, content: string): string {
        const file = path.join(dir, name);
        fs.writeFileSync(file, content, 'utf8');

        return file;
    }

    async function collect(file: string): Promise<Record<string, unknown>[]> {
        const rows = [];

        for await (const row of readSnapshotRows(file)) {
            rows.push(row);
        }

        return rows;
    }

    async function collectError(file: string): Promise<Error | null> {
        try {
            await collect(file);
        } catch (e) {
            return e as Error;
        }

        return null;
    }

    it('yields one object per line and skips blank lines', async () => {
        const file = write('rows.jsonl', '{"contract":"simpleassets","asset_id":"1"}\n\n{"contract":"simpleassets","asset_id":"2"}\n');

        expect(await collect(file)).to.deep.equal([
            { contract: 'simpleassets', asset_id: '1' },
            { contract: 'simpleassets', asset_id: '2' },
        ]);
    });

    it('reads a last line with no trailing newline', async () => {
        const file = write('tail.jsonl', '{"a":1}\n{"a":2}');

        expect(await collect(file)).to.have.length(2);
    });

    it('fails on a line that is not JSON and names the file and line', async () => {
        const file = write('bad.jsonl', '{"a":1}\n{"a":\n');
        const error = await collectError(file);

        expect(error).to.not.equal(null);
        expect(error.message).to.contain(file).and.to.contain('line 2');
    });

    it('fails on a line that holds no JSON object', async () => {
        const file = write('array.jsonl', '[1,2]\n');
        const error = await collectError(file);

        expect(error).to.not.equal(null);
        expect(error.message).to.contain('line 1');
    });

    it('fails on an integer above the safe range and names the file, line and column', async () => {
        const file = write('big.jsonl', '{"asset_id":"1"}\n{"asset_id":9007199254740993}\n');
        const error = await collectError(file);

        expect(error).to.not.equal(null);
        expect(error.message).to.contain(file).and.to.contain('line 2').and.to.contain('asset_id');
    });

    it('fails on a number that is not finite', async () => {
        const error = await collectError(write('inf.jsonl', '{"total_ever":1e400}\n'));

        expect(error).to.not.equal(null);
        expect(error.message).to.contain('total_ever');
    });

    it('keeps a quoted integer above the safe range as its exact text', async () => {
        const rows = await collect(write('quoted.jsonl', '{"asset_id":"9007199254740993","mint_number":5}\n'));

        expect(rows).to.deep.equal([{ asset_id: '9007199254740993', mint_number: 5 }]);
    });
});
