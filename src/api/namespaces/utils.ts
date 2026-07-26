import express from 'express';
import QueryBuilder from '../builder';
import {filterQueryArgs, FiltersDefinition, FilterValues} from './validation';

/**
 * A column a list endpoint may ORDER BY.
 *
 * `numericIndex` marks a column whose ORDER BY may carry an arithmetic hint (`+ 0` or
 * `+ 1`), which makes the planner abandon that column's btree. Honour it only where the
 * WHERE clause cannot be answered from an ordered index: the lossy GIN array containment
 * on `atomicmarket_sales_filters` (`atomicmarket/handlers/sales2.ts`) and the JSONB and
 * trigram searches on assets (`atomicassets/handlers/assets.ts`). Matching rows there are
 * unordered with respect to the sort key, so streaming the ordered index is skew-unbounded
 * and the bounded bitmap-plus-top-N plan wins.
 *
 * Where the filters are btree-checkable equalities the hint is a pessimization: Postgres
 * streams the ordered index under an Incremental Sort and stops once the limit is filled,
 * and the hint discards that plan for a full scan plus a top-N sort. Set the flag only
 * next to a filter of the first kind.
 */
export type SortColumn = {column: string, nullable?: boolean, numericIndex?: boolean};
export type SortColumnMapping = {[key: string]: SortColumn};

export type RequestValues = {[key: string]: any};

export function mergeRequestData(req: express.Request): RequestValues {
    return {...req.query, ...req.body};
}

export async function buildBoundaryFilter(
    values: FilterValues, query: QueryBuilder,
    primaryColumn: string, primaryType: 'string' | 'int',
    dateColumn: string | null
): Promise<void> {
    const filters: FiltersDefinition = {
        lower_bound: {type: primaryType, min: 1},
        upper_bound: {type: primaryType, min: 1},
        before: {type: 'int', min: 1},
        after: {type: 'int', min: 1},
        ids: {type: 'list[string]'},
    };
    let primaryColumnName;

    if (primaryColumn) {
        primaryColumnName = primaryColumn.split('.')[1] || primaryColumn;
        filters[primaryColumnName] = {type: 'list[string]'};
    }
    const args = await filterQueryArgs(values, filters);

    if (primaryColumn && (args.ids.length || args[primaryColumnName].length)) {
        query.equalMany(primaryColumn, [...args.ids, ...args[primaryColumnName]]);
    }

    if (primaryColumn && args.lower_bound) {
        query.addCondition(primaryColumn + ' >= ' + query.addVariable(args.lower_bound));
    }

    if (primaryColumn && args.upper_bound) {
        query.addCondition(primaryColumn + ' < ' + query.addVariable(args.upper_bound));
    }

    if (dateColumn && args.before) {
        query.addCondition(dateColumn + ' < ' + query.addVariable(args.before) + '::BIGINT');
    }

    if (dateColumn && args.after) {
        query.addCondition(dateColumn + ' > ' + query.addVariable(args.after) + '::BIGINT');
    }
}
