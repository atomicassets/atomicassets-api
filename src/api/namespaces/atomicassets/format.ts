import type {IApiSchema} from '@atomichub/atomicassets';

export function formatAsset(row: any): any {
    const data = {...row};

    data.collection = formatCollection(data.collection);
    data.schema = formatSchema(data.schema);

    data.mutable_data = Object.assign({}, data.mutable_data);
    data.immutable_data = Object.assign({}, data.immutable_data);

    data['data'] = {
        ...data.mutable_data,
        ...data.immutable_data
    };

    if (data.template) {
        data.template.immutable_data = Object.assign({}, data.template.immutable_data);
        data.template.mutable_data = Object.assign({}, data.template.mutable_data);
        data.template.data = {...data.template.mutable_data, ...data.template.immutable_data};

        data['data'] = {
            ...data.template.mutable_data,
            ...data.mutable_data,
            ...data.immutable_data,
            ...data.template.immutable_data,
        };
    }

    data.name = data.data.name;

    delete data['template_id'];
    delete data['schema_name'];
    delete data['collection_name'];
    delete data['authorized_accounts'];

    return data;
}

export function formatTemplate(row: any): any {
    const data = {...row};

    data.collection = formatCollection(data.collection);
    data.schema = formatSchema(data.schema);

    data.immutable_data = data.immutable_data || {};
    data.mutable_data = data.mutable_data || {};
    data.data = {...data.mutable_data, ...data.immutable_data};
    data.name = data.data.name;

    delete data['schema_name'];
    delete data['collection_name'];
    delete data['authorized_accounts'];

    return data;
}

export interface FormatSchemaOptions {
    // Keep the raw `types` array on the response instead of dropping it.
    //
    // `format[].mediatype` merges the stored descriptors with a name/type
    // heuristic, so a reader cannot tell an authored value from a derived one.
    // That is the right answer for a consumer asking "how do I render this
    // field", and the wrong one for an author: `setschematyp` replaces the whole
    // descriptor array, so a client that cannot see which entries are real will
    // write the heuristic's guesses to chain on its first save.
    //
    // Opt in on the schema routes, where authors read. The nested schema inside
    // an asset or template keeps the merged view alone: nobody authors from an
    // asset response, and assets is the highest-volume endpoint in the API.
    includeTypes?: boolean;
}

export function formatSchema(row: any, options: FormatSchemaOptions = {}): IApiSchema {
    const {collection_name: _collection_name, authorized_accounts: _authorized_accounts, ...data} = row;

    data.collection = formatCollection(data.collection);

    // v2: derive a per-field `mediatype`/`info`, preferring the explicit schema
    // `types` (set via the contract `schematypes` table) and falling back to a
    // name/type heuristic.
    const types: Array<{name: string, mediatype: string, info: string}> = data.types || [];
    data.format = (data.format || []).map((field: {name: string, type: string}) => {
        const type = types.find((x) => x.name === field.name);

        const checkName = (match: string): boolean =>
            field.name.toLowerCase().startsWith(match) || field.name.toLowerCase().endsWith(match);

        let adjustedType = null;

        if (field.name === 'name') {
            adjustedType = 'name';
        }

        if (checkName('image') || checkName('img') || field.type === 'image') {
            adjustedType = 'image';
        }

        if (checkName('video')) {
            adjustedType = 'video';
        }

        if (checkName('audio')) {
            adjustedType = 'audio';
        }

        return {
            ...field,
            mediatype: type?.mediatype || adjustedType,
            info: type?.info || null,
        };
    });

    if (options.includeTypes) {
        // A schema with no descriptors reports [] rather than null, so a client
        // never has to treat "no rows" and "no column" as the same input.
        //
        // The distinction that matters to an author, between "this schema has
        // none" and "this response does not report them", is carried by the
        // branch itself: present means the former, absent means the latter.
        data.types = types;
    } else {
        delete data['types'];
    }

    return data;
}

export function formatCollection(row: any): any {
    return row;
}

export function formatOffer(row: any): any {
    const data = {...row};

    delete data['recipient_contract_account'];

    return data;
}

export function formatTransfer(row: any): any {
    return {...row};
}
