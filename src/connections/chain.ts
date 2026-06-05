import { ABI, APIClient, FetchProvider, Serializer } from '@wharfkit/antelope';

import { retryTransient } from '../utils/retry';

class RpcAdapter {
    constructor(private readonly client: APIClient) {}

    async get_info(): Promise<any> {
        const info = await retryTransient(() => this.client.v1.chain.get_info(), { label: 'chain.get_info' });
        return Serializer.objectify(info);
    }

    async get_abi(accountName: string): Promise<any> {
        const result = await retryTransient(() => this.client.v1.chain.get_abi(accountName), { label: 'chain.get_abi' });
        return Serializer.objectify(result as any);
    }

    async get_table_rows(params: any): Promise<any> {
        return await retryTransient(() => this.client.v1.chain.get_table_rows(params), { label: 'chain.get_table_rows' });
    }
}

export default class ChainApi {
    readonly client: APIClient;
    readonly rpc: RpcAdapter;

    constructor(readonly endpoint: string, readonly name: string, readonly chainId: string) {
        this.client = new APIClient(new FetchProvider(endpoint, { fetch }));
        this.rpc = new RpcAdapter(this.client);
    }

    async post(path: string, body: any): Promise<any> {
        // Retry the full round-trip — a transient disconnect can hit while
        // reading/parsing the response body, not just on connect — so the
        // fetch AND the json() are inside the retried unit.
        return await retryTransient(
            async () => {
                const request = await fetch(this.endpoint + path, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(body)
                });

                return await request.json();
            },
            { label: `chain.post ${path}` }
        );
    }

    async checkChainId(): Promise<boolean> {
        const info = await retryTransient(() => this.client.v1.chain.get_info(), { label: 'chain.checkChainId' });

        return String(info.chain_id) === this.chainId;
    }

    deserializeAbi(data: Uint8Array): ABI {
        return Serializer.decode({ data, type: ABI }) as ABI;
    }
}
