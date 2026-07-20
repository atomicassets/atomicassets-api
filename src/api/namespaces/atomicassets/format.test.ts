import 'mocha';
import { expect } from 'chai';

import { formatSchema } from './format';

// `format[].mediatype` deliberately merges the authored `schematypes` descriptors
// with a name/type heuristic, which answers "how should I render this field" and
// destroys "what is actually stored". `setschematyp` replaces the whole descriptor
// array, so an authoring client that cannot tell the two apart rewrites the
// heuristic's guesses onto chain the first time it saves. These pin both halves:
// the merge stays as consumers see it, and the raw array is reachable where an
// author reads.

function schemaRow(format: Array<{name: string, type: string}>, types?: Array<{name: string, mediatype: string, info: string}>): any {
    return {
        contract: 'atomicassets',
        collection_name: 'testcol',
        schema_name: 'testschema',
        authorized_accounts: ['someauthor'],
        collection: {collection_name: 'testcol'},
        format,
        ...(types === undefined ? {} : {types}),
    };
}

describe('formatSchema', () => {
    it('drops the raw descriptor array by default, keeping the nested asset payload unchanged', () => {
        const result = formatSchema(schemaRow(
            [{name: 'img', type: 'image'}],
            [{name: 'img', mediatype: 'image/png', info: ''}]
        ));

        expect(result).to.not.have.property('types');
    });

    it('returns the raw descriptor array when the caller asks for it', () => {
        const result = formatSchema(schemaRow(
            [{name: 'img', type: 'image'}],
            [{name: 'img', mediatype: 'image/png', info: ''}]
        ), {includeTypes: true});

        expect(result.types).to.deep.equal([{name: 'img', mediatype: 'image/png', info: ''}]);
    });

    // Absent and empty must stay distinguishable: absent means this response
    // cannot report descriptors at all, empty means the schema has none.
    it('reports an empty descriptor array rather than omitting it when a schema has none', () => {
        const result = formatSchema(schemaRow([{name: 'img', type: 'image'}]), {includeTypes: true});

        expect(result.types).to.deep.equal([]);
    });

    // The reason the raw array is needed at all: these two schemas are identical
    // in `format`, and only `types` says which one an author actually wrote.
    it('distinguishes an authored descriptor from a derived one that reads the same', () => {
        const authored = formatSchema(schemaRow(
            [{name: 'video', type: 'string'}],
            [{name: 'video', mediatype: 'video', info: ''}]
        ), {includeTypes: true});
        const derived = formatSchema(schemaRow([{name: 'video', type: 'string'}]), {includeTypes: true});

        expect(authored.format[0].mediatype).to.equal('video');
        expect(derived.format[0].mediatype).to.equal('video');

        expect(authored.types).to.have.lengthOf(1);
        expect(derived.types).to.have.lengthOf(0);
    });

    it('prefers an authored descriptor over the heuristic for the merged field', () => {
        const result = formatSchema(schemaRow(
            [{name: 'img', type: 'image'}],
            [{name: 'img', mediatype: 'image/png', info: 'cover art'}]
        ), {includeTypes: true});

        expect(result.format[0].mediatype).to.equal('image/png');
        expect(result.format[0].info).to.equal('cover art');
    });

    // The merged `info` collapses an authored empty string to null, so it cannot
    // express "authored, deliberately blank". The raw array can, and does.
    it('preserves an authored empty info in the raw array where the merged field cannot', () => {
        const result = formatSchema(schemaRow(
            [{name: 'img', type: 'image'}],
            [{name: 'img', mediatype: 'image/png', info: ''}]
        ), {includeTypes: true});

        expect(result.format[0].info).to.equal(null);
        expect(result.types[0].info).to.equal('');
    });

    it('falls back to the heuristic for a field with no authored descriptor', () => {
        const result = formatSchema(schemaRow([
            {name: 'name', type: 'string'},
            {name: 'img', type: 'image'},
            {name: 'lore', type: 'string'},
        ]), {includeTypes: true});

        expect(result.format.map((field: any) => field.mediatype)).to.deep.equal(['name', 'image', null]);
    });
});
