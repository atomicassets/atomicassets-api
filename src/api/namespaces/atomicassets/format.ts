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

export function formatSchema(row: any): any {
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

    delete data['types'];

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

export function formatMove(row: any): any {
    return {...row};
}
