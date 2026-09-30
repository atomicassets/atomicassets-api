import * as fs from 'fs';
import * as readline from 'readline';

/**
 * Streams the rows of one snapshot file: UTF-8 JSON lines, one object per
 * line, keys equal to the ECA column names. The import reads its files only
 * through this function, so a different file format changes this module
 * alone.
 */
export async function* readSnapshotRows(file: string): AsyncGenerator<Record<string, unknown>> {
    const lines = readline.createInterface({
        input: fs.createReadStream(file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });

    let lineNumber = 0;

    for await (const line of lines) {
        lineNumber += 1;

        if (line.trim().length === 0) {
            continue;
        }

        let row: unknown;

        try {
            row = JSON.parse(line);
        } catch (e) {
            throw new Error('Snapshot file ' + file + ' line ' + lineNumber + ' is not JSON: ' + (e as Error).message, { cause: e });
        }

        if (row === null || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error('Snapshot file ' + file + ' line ' + lineNumber + ' holds no JSON object');
        }

        // JSON.parse rounds an integer above 2^53 - 1 to a nearby double, so a bigint written as a
        // number would load as another id. A quoted one stays exact text for Postgres to cast.
        for (const [column, value] of Object.entries(row)) {
            if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isSafeInteger(value) && Number.isInteger(value))) {
                throw new Error(
                    'Snapshot file ' + file + ' line ' + lineNumber + ' column ' + column +
                    ' holds a number JSON cannot carry exactly: quote integers above 2^53 - 1 as strings'
                );
            }
        }

        yield row as Record<string, unknown>;
    }
}
