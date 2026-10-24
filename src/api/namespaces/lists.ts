import { DB } from '../server';
import {memoize} from 'micro-memoize';
import { addValidationType, parseTypeString, validateId, validateName, validateString } from './validation';

async function expandLists(strings: string[], db: DB): Promise<string[]> {
    const result: string[] = [];

    for (const s of strings) {
        if (s.startsWith('$list:')) {
            result.push(...(await getListItems(s.replace(/^\$list:/, ''), db)));
        } else {
            result.push(s);
        }
    }

    return result;
}

const getListItems = memoize(
    async (listName: string, db: DB): Promise<string[]> => {
        const {items} = await db.fetchOne(`
            SELECT ARRAY_AGG(item_name) items
            FROM list_items
                JOIN lists ON list_items.list_id = lists.id
            WHERE lists.list_name = $1
        `, [listName]);

        return items ?? [];
    },
    {
        async: true,
        maxSize: 9999990,
        maxArgs: 1,
        // Fixed TTL from insertion; hits and promise resolution must not reset it.
        expires: 1000 * 60 * 5,
        // Preserve moize's SameValueZero equality, including 0 and -0.
        isKeyItemEqual: (a, b) => a === b || Object.is(a, b),
    },
);

export function initListValidator(db: DB): void {
    addValidationType('list', async (values, filter) => {
        const result = await expandLists(values, db);

        const {innerType} = parseTypeString(filter.type);

        switch (innerType) {
            case 'id':
                return validateId(result);
            case 'name':
                return validateName(result);
            default:
                return validateString(result, filter);
        }
    });
}
