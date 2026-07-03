import { AttributeMap } from './types/actions';

export function convertAttributeMapToObject(data: AttributeMap): {[key: string]: string} {
    const result: {[key: string]: string} = {};
    for (const row of data) {
        // v2 ABIs may serialize the attribute pair as {first, second} instead of
        // {key, value}; accept both shapes.
        const key = 'key' in row ? row.key : row.first;
        const value = 'value' in row ? row.value : row.second;

        if (['uint64', 'int64'].indexOf(value[0]) >= 0) {
            result[key] = String(value[1]);
        } else if (['INT64_VEC', 'UINT64_VEC'].indexOf(value[0]) >= 0) {
            result[key] = value[1].map((data: number) => String(data));
        } else {
            result[key] = value[1];
        }
    }

    return result;
}
