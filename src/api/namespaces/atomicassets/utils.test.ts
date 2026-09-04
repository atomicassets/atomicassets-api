import 'mocha';
import { expect } from 'chai';

import QueryBuilder from '../../builder';
import { buildDataConditions } from './utils';

// A template stores its attributes across immutable_data and mutable_data, and
// the collection decides which column holds a given attribute. These pin that
// every template-level condition reads both columns, that the caller's key and
// value travel as bind parameters rather than as SQL text, and that the
// asset-level branch is untouched.

function templateQuery(values: Record<string, any>): QueryBuilder {
    const query = new QueryBuilder('SELECT "template".template_id FROM atomicassets_templates "template"');

    buildDataConditions(values, query, {templateTable: '"template"'});

    return query;
}

describe('buildDataConditions', () => {

    describe('template data conditions', () => {

        it('matches a template_data pair against either data column', () => {
            const query = templateQuery({'template_data.rarity': 'common'});

            expect(query.buildString()).to.contain('"template".immutable_data @> $1::jsonb');
            expect(query.buildString()).to.contain('"template".mutable_data @> $1::jsonb');
            expect(query.buildValues()).to.deep.equal(['{"rarity":"common"}']);
        });

        it('matches a data pair against either data column', () => {
            const query = templateQuery({'data:number.level': '3'});

            expect(query.buildString()).to.contain('"template".immutable_data @> $1::jsonb');
            expect(query.buildString()).to.contain('"template".mutable_data @> $1::jsonb');
            expect(query.buildValues()).to.deep.equal(['{"level":3}']);
        });

        // One containment test over the whole object would demand that a single
        // column hold every requested pair, which returns nothing for a
        // collection that splits its attributes across the two.
        it('gives each requested pair its own disjunction so the pairs can come from different columns', () => {
            const query = templateQuery({
                'template_data.rarity': 'common',
                'template_data.lore': 'origin',
            });

            const sql = query.buildString();

            expect(sql).to.contain('"template".immutable_data @> $1::jsonb OR "template".mutable_data @> $1::jsonb');
            expect(sql).to.contain('"template".immutable_data @> $2::jsonb OR "template".mutable_data @> $2::jsonb');
            expect(query.buildValues()).to.deep.equal(['{"rarity":"common"}', '{"lore":"origin"}']);
        });

        it('keeps a caller-supplied key and value out of the query text', () => {
            const query = templateQuery({'template_data.a\' OR 1=1 --': 'x\' OR 1=1 --'});

            expect(query.buildString()).to.not.contain('1=1');
            expect(query.buildValues()).to.deep.equal(['{"a\' OR 1=1 --":"x\' OR 1=1 --"}']);
        });

        it('adds no condition when no data filter is given', () => {
            const query = templateQuery({collection_name: 'somecollection'});

            expect(query.buildString()).to.not.contain('immutable_data');
            expect(query.buildString()).to.not.contain('mutable_data');
            expect(query.buildValues()).to.deep.equal([]);
        });
    });

    describe('template name conditions', () => {

        it('matches the name in either data column and binds the pattern once', () => {
            const query = templateQuery({match: 'orig'});

            expect(query.buildString()).to.contain('"template".immutable_data->>\'name\' ILIKE $1');
            expect(query.buildString()).to.contain('"template".mutable_data->>\'name\' ILIKE $1');
            expect(query.buildValues()).to.deep.equal(['%orig%']);
        });

        it('searches the name in either data column and binds the term once', () => {
            const query = templateQuery({search: 'orig'});

            expect(query.buildString()).to.contain('$1 <% ("template".immutable_data->>\'name\')');
            expect(query.buildString()).to.contain('$1 <% ("template".mutable_data->>\'name\')');
            expect(query.buildValues()).to.deep.equal(['orig']);
        });

        it('escapes the wildcards a caller puts in match', () => {
            const query = templateQuery({match: 'par%_tial'});

            expect(query.buildValues()).to.deep.equal(['%par\\%\\_tial%']);
        });
    });

    describe('asset data conditions', () => {

        it('reads the asset columns alone when no template table is joined', () => {
            const query = new QueryBuilder('SELECT asset.asset_id FROM atomicassets_assets asset');

            buildDataConditions({'data.rarity': 'common'}, query, {assetTable: '"asset"'});

            const sql = query.buildString();

            expect(sql).to.contain('"asset".immutable_data @> $2::jsonb');
            expect(sql).to.not.contain('template');
            expect(query.buildValues()).to.deep.equal(['{}', '{"rarity":"common"}']);
        });

        it('keeps mutable_data on the asset columns when a template table is joined', () => {
            const query = new QueryBuilder('SELECT asset.asset_id FROM atomicassets_assets asset');

            buildDataConditions({'mutable_data.wear': '1'}, query, {
                assetTable: '"asset"',
                templateTable: '"template"',
            });

            const sql = query.buildString();

            expect(sql).to.contain('"asset".mutable_data @> $1::jsonb');
            expect(sql).to.not.contain('"template".mutable_data');
            expect(query.buildValues()).to.deep.equal(['{"wear":"1"}']);
        });
    });
});
