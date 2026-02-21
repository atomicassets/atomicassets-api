import { ABI, APIClient, FetchProvider, Serializer } from '@wharfkit/antelope';

class RpcAdapter {
    constructor(private readonly client: APIClient) {}

    async get_info(): Promise<any> {
        const info = await this.client.v1.chain.get_info();
        return Serializer.objectify(info);
    }

    async get_abi(accountName: string): Promise<any> {
        const result = await this.client.v1.chain.get_abi(accountName);
        return Serializer.objectify(result as any);
    }

    async get_table_rows(params: any): Promise<any> {
        return await this.client.v1.chain.get_table_rows(params);
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
        const request = await fetch(this.endpoint + path, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        return await request.json();
    }

    async checkChainId(): Promise<boolean> {
        const info = await this.client.v1.chain.get_info();

        return String(info.chain_id) === this.chainId;
    }

    deserializeAbi(data: Uint8Array): ABI {
        return Serializer.decode({ data, type: ABI }) as ABI;
    }
}
