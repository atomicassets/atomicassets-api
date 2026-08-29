import {isIP} from 'net';
import {compile} from 'proxy-addr';

import logger from './winston';
import type {IServerConfig} from '../types/config';

type AddressMatcher = (ip: string | undefined) => boolean;

// The two config keys that carry an address list. The name reaches the error
// message for a bad entry, so an operator sees which list to fix.
type AddressListKey = 'ip_whitelist' | 'peer_whitelist';

// The part of an express request the whitelist reads: `ip` follows `trust proxy`
// and may come from a forwarded header, `socket.remoteAddress` is the TCP peer.
type RequestAddresses = {
    ip?: string;
    socket: {remoteAddress?: string};
};

type RequestWhitelist = (req: RequestAddresses) => boolean;

type WhitelistConfig = Pick<Partial<IServerConfig>, 'ip_whitelist' | 'peer_whitelist' | 'trust_proxy'>;

type CompiledTrust = (addr: string, hop: number) => boolean;

// proxy-addr ships no type declarations; this is the shape of its `compile` export.
const compileTrust: (entries: string[]) => CompiledTrust = compile;

// proxy-addr's own `compile` also accepts its pre-defined range names (`loopback`,
// `linklocal`, `uniquelocal`), splicing in the subnets they stand for. A whitelist
// only ever means a literal address or CIDR range, so reject anything whose
// address part (before an optional `/prefix`) does not parse as one.
function assertLiteralAddressOrCidr(entry: string): void {
    const slashIndex = entry.lastIndexOf('/');
    const address = slashIndex === -1 ? entry : entry.slice(0, slashIndex);

    if (isIP(address) === 0) {
        throw new Error(`not a literal IP address or CIDR range: ${JSON.stringify(entry)}`);
    }
}

// Turns one address list from the server config into a predicate. An entry is an
// exact address or a CIDR range, in IPv4 or IPv6 notation, matched by the same
// code express uses for `trust proxy`. An entry that does not parse throws here,
// so a bad list stops the server at startup instead of failing on the first request.
export function compileAddressList(key: AddressListKey, entries: string[]): AddressMatcher {
    for (const entry of entries) {
        if (typeof entry !== 'string' || entry.length === 0) {
            throw new Error(
                `Invalid ${key} entry ${JSON.stringify(entry)}: expected an IP address or a CIDR range`
            );
        }

        try {
            assertLiteralAddressOrCidr(entry);
            compileTrust([entry]);
        } catch (error) {
            throw new Error(
                `Invalid ${key} entry "${entry}": expected an IP address or a CIDR range (${error.message})`,
                {cause: error}
            );
        }
    }

    const trust = compileTrust(entries);

    // proxy-addr's compiled `trust` documents `false` for a candidate that
    // does not parse, but only once it has parsed it; guard with `isIP` so a
    // malformed candidate (an unparseable forwarded-header token, say) never
    // reaches it.
    return (ip: string | undefined): boolean => typeof ip === 'string' && isIP(ip) !== 0 && trust(ip, 0);
}

// Builds the predicate the rate limiter and the response cache share. A request
// is whitelisted when `ip_whitelist` matches `req.ip` or `peer_whitelist` matches
// the TCP peer address of the connection, which no forwarded header can alter.
export function compileRequestWhitelist(config: WhitelistConfig): RequestWhitelist {
    const isWhitelisted = compileAddressList('ip_whitelist', config.ip_whitelist ?? []);
    const isPeerWhitelisted = compileAddressList('peer_whitelist', config.peer_whitelist ?? []);

    return (req: RequestAddresses): boolean => isWhitelisted(req.ip) || isPeerWhitelisted(req.socket.remoteAddress);
}

// A `trust_proxy` of `true` or a hop count makes express read `req.ip` from the
// forwarded header of whatever connects, so a client that forges the header
// takes any `ip_whitelist` entry. A named subnet or a CIDR list scopes the trust
// to the listed proxies and gets no warning.
export function warnIfWhitelistTrustsForwardedHeader(config: WhitelistConfig): void {
    const entries = config.ip_whitelist ?? [];
    const trustProxy = config.trust_proxy;
    const trustsHops = trustProxy === true || (typeof trustProxy === 'number' && trustProxy > 0);

    if (entries.length === 0 || !trustsHops) {
        return;
    }

    logger.warn(
        `trust_proxy is ${JSON.stringify(trustProxy)}, so req.ip derives from a client-supplied forwarded header ` +
        'and every ip_whitelist entry is reachable by any client that can forge it. ' +
        'List directly connected callers in peer_whitelist, which matches the TCP peer address instead.'
    );
}
