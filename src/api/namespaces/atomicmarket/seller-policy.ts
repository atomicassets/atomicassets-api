import type express from 'express';
import { ApiError } from '../../error';
import { respondApiError } from '../../utils';
import { mergeRequestData } from '../utils';
import { validateName } from '../validation';

import type { AtomicMarketNamespace } from './index';

const cache = new Map<string, { expires: number; sellers: string[] }>();
const pending = new Map<string, Promise<string[]>>();

async function getSellers(chain: string): Promise<string[]> {
    const hit = cache.get(chain);
    if (hit && hit.expires > Date.now()) return hit.sellers;
    const active = pending.get(chain);
    if (active) return active;
    const url = process.env.SELLER_POLICY_URL;
    if (!url) throw new Error('SELLER_POLICY_URL is required');
    const request = fetch(`${url}/v1/atomichub-config/seller-policy?chains=${encodeURIComponent(chain)}`, {
        signal: AbortSignal.timeout(3_000),
        redirect: 'error',
    }).then(async response => {
        if (!response.ok) throw new Error(`Seller policy returned ${response.status}`);
        const length = Number(response.headers.get('content-length') ?? 0);
        if (length > 5_000_000) {
            await response.body?.cancel();
            throw new Error('Seller policy is too large');
        }
        if (!response.body) throw new Error('Seller policy response has no body');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > 5_000_000) throw new Error('Seller policy is too large');
                chunks.push(value);
            }
        } catch (error) {
            await reader.cancel().catch(() => undefined);
            throw error;
        } finally {
            reader.releaseLock();
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        const body = new TextDecoder().decode(bytes);
        const data = JSON.parse(body) as { data?: { blocked_accounts?: Array<{ chain: string; account: string }>; sellers?: Array<{ chain: string; account: string; state?: string }> } };
        if (!Array.isArray(data.data?.blocked_accounts) || !Array.isArray(data.data?.sellers)) throw new Error('Invalid seller policy');
        const accounts = [...data.data.blocked_accounts, ...data.data.sellers];
        if (accounts.some(row => !row || typeof row.chain !== 'string' || typeof row.account !== 'string')) throw new Error('Invalid seller policy account');
        if (data.data.sellers.some(row => !['blacklisted', 'whitelisted'].includes(row.state ?? ''))) throw new Error('Invalid seller policy state');
        await validateName(accounts.map(row => row.account));
        const sellers = [...new Set([
            ...(data.data?.blocked_accounts ?? []).filter(row => row.chain === chain).map(row => row.account),
            ...(data.data?.sellers ?? []).filter(row => row.chain === chain && row.state === 'blacklisted').map(row => row.account),
        ])];
        if (sellers.length > 1000) throw new Error('Seller policy is too large');
        cache.set(chain, { expires: Date.now() + 10_000, sellers });
        return sellers;
    });
    pending.set(chain, request);
    try {
        return await request;
    } finally {
        pending.delete(chain);
    }
}

export function serverSellerPolicy(core: AtomicMarketNamespace): express.RequestHandler {
    return async (req, res, next) => {
        try {
            const source = mergeRequestData(req);
            if (source.hide_blocked_sellers !== true && source.hide_blocked_sellers !== 'true') return next();
            const sellers = await getSellers(core.connection.chain.name);
            const personal = Array.isArray(source.seller_blacklist) ? source.seller_blacklist.join(',') : String(source.seller_blacklist ?? '');
            req.body = { ...source, seller_blacklist: [...new Set([...personal.split(',').filter(Boolean), ...sellers])].join(',') };
            delete req.body.hide_blocked_sellers;
            const query = { ...req.query };
            delete query.hide_blocked_sellers;
            Object.defineProperty(req, 'query', { value: query, writable: true });
            next();
        } catch {
            respondApiError(res, new ApiError('Seller policy unavailable', 503));
        }
    };
}
