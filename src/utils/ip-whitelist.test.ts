import 'mocha';
import {expect} from 'chai';
import * as sinon from 'sinon';

import {compileAddressList, compileRequestWhitelist, warnIfWhitelistTrustsForwardedHeader} from './ip-whitelist';
import logger from './winston';

describe('compileAddressList', () => {
    it('matches an exact address and nothing else', () => {
        const isWhitelisted = compileAddressList('ip_whitelist', ['192.0.2.10']);

        expect(isWhitelisted('192.0.2.10')).to.be.true;
        expect(isWhitelisted('192.0.2.11')).to.be.false;
        expect(isWhitelisted('198.51.100.10')).to.be.false;
    });

    it('matches the IPv4-mapped IPv6 form of an exact IPv4 address', () => {
        const isWhitelisted = compileAddressList('ip_whitelist', ['192.0.2.10']);

        expect(isWhitelisted('::ffff:192.0.2.10')).to.be.true;
    });

    it('matches an address inside an IPv4 CIDR range and not one outside it', () => {
        const isWhitelisted = compileAddressList('ip_whitelist', ['192.0.2.0/24']);

        expect(isWhitelisted('192.0.2.1')).to.be.true;
        expect(isWhitelisted('192.0.2.254')).to.be.true;
        expect(isWhitelisted('192.0.3.1')).to.be.false;
        expect(isWhitelisted('203.0.113.1')).to.be.false;
    });

    it('matches an address inside an IPv6 CIDR range and not one outside it', () => {
        const isWhitelisted = compileAddressList('ip_whitelist', ['2001:db8::/32']);

        expect(isWhitelisted('2001:db8::1')).to.be.true;
        expect(isWhitelisted('2001:db8:ffff::1')).to.be.true;
        expect(isWhitelisted('2001:db9::1')).to.be.false;
    });

    it('matches against every entry of a mixed list', () => {
        const isWhitelisted = compileAddressList('ip_whitelist', ['192.0.2.10', '198.51.100.0/24', '2001:db8::/32']);

        expect(isWhitelisted('192.0.2.10')).to.be.true;
        expect(isWhitelisted('198.51.100.77')).to.be.true;
        expect(isWhitelisted('2001:db8::5')).to.be.true;
        expect(isWhitelisted('203.0.113.1')).to.be.false;
    });

    it('matches nothing for an empty list', () => {
        const isWhitelisted = compileAddressList('ip_whitelist', []);

        expect(isWhitelisted('192.0.2.10')).to.be.false;
        expect(isWhitelisted('::1')).to.be.false;
    });

    it('rejects a missing or malformed request address', () => {
        const isWhitelisted = compileAddressList('ip_whitelist', ['192.0.2.0/24']);

        expect(isWhitelisted(undefined)).to.be.false;
        expect(isWhitelisted('')).to.be.false;
        expect(isWhitelisted('not-an-address')).to.be.false;
    });

    it('rejects a malformed candidate for both list kinds without reaching proxy-addr', () => {
        const isIpWhitelisted = compileAddressList('ip_whitelist', ['192.0.2.0/24']);
        const isPeerWhitelisted = compileAddressList('peer_whitelist', ['192.0.2.0/24']);

        expect(isIpWhitelisted('not-an-address')).to.be.false;
        expect(isPeerWhitelisted('not-an-address')).to.be.false;
    });

    it('throws at construction for an entry that is not an address', () => {
        expect(() => compileAddressList('ip_whitelist', ['192.0.2.10', 'not-an-address']))
            .to.throw(Error, /ip_whitelist entry "not-an-address"/);
    });

    it('throws at construction for a CIDR range with an invalid prefix length', () => {
        expect(() => compileAddressList('ip_whitelist', ['192.0.2.0/33']))
            .to.throw(Error, /ip_whitelist entry "192.0.2.0\/33"/);
    });

    it('throws at construction for a proxy-addr pre-defined range name', () => {
        expect(() => compileAddressList('ip_whitelist', ['uniquelocal']))
            .to.throw(Error, /ip_whitelist entry "uniquelocal"/);
    });

    it('still accepts a literal range covering the same addresses as a range name', () => {
        const isWhitelisted = compileAddressList('ip_whitelist', ['10.0.0.0/8']);

        expect(isWhitelisted('10.1.2.3')).to.be.true;
        expect(isWhitelisted('192.0.2.10')).to.be.false;
    });

    it('throws at construction for an entry that is not a string', () => {
        expect(() => compileAddressList('ip_whitelist', [42 as unknown as string]))
            .to.throw(Error, /ip_whitelist entry 42/);
        expect(() => compileAddressList('ip_whitelist', ['']))
            .to.throw(Error, /ip_whitelist entry ""/);
    });

    it('names the list it was compiled for in the error', () => {
        expect(() => compileAddressList('peer_whitelist', ['not-an-address']))
            .to.throw(Error, /Invalid peer_whitelist entry "not-an-address"/);
    });
});

describe('compileRequestWhitelist', () => {
    const request = (ip: string | undefined, remoteAddress: string | undefined): {ip?: string, socket: {remoteAddress?: string}} => ({
        ip,
        socket: {remoteAddress},
    });

    it('whitelists a request whose req.ip is outside every list but whose socket peer is in peer_whitelist', () => {
        const isWhitelisted = compileRequestWhitelist({
            ip_whitelist: ['198.51.100.0/24'],
            peer_whitelist: ['192.0.2.0/24'],
        });

        expect(isWhitelisted(request('203.0.113.7', '192.0.2.10'))).to.be.true;
    });

    it('whitelists a request whose socket peer is outside every list but whose req.ip is in ip_whitelist', () => {
        const isWhitelisted = compileRequestWhitelist({
            ip_whitelist: ['198.51.100.0/24'],
            peer_whitelist: ['192.0.2.0/24'],
        });

        expect(isWhitelisted(request('198.51.100.20', '203.0.113.7'))).to.be.true;
    });

    it('ignores req.ip for peer_whitelist, so a forwarded address inside the peer list does not match', () => {
        const isWhitelisted = compileRequestWhitelist({peer_whitelist: ['192.0.2.0/24']});

        expect(isWhitelisted(request('192.0.2.10', '203.0.113.7'))).to.be.false;
        expect(isWhitelisted(request('192.0.2.10', undefined))).to.be.false;
    });

    it('ignores the socket peer for ip_whitelist, so a peer inside the ip list does not match', () => {
        const isWhitelisted = compileRequestWhitelist({ip_whitelist: ['192.0.2.0/24']});

        expect(isWhitelisted(request('203.0.113.7', '192.0.2.10'))).to.be.false;
    });

    it('rejects a request outside both lists', () => {
        const isWhitelisted = compileRequestWhitelist({
            ip_whitelist: ['198.51.100.0/24'],
            peer_whitelist: ['192.0.2.0/24'],
        });

        expect(isWhitelisted(request('203.0.113.7', '203.0.113.8'))).to.be.false;
    });

    it('treats an absent key as an empty list', () => {
        const isWhitelisted = compileRequestWhitelist({});

        expect(isWhitelisted(request('192.0.2.10', '192.0.2.10'))).to.be.false;
    });

    it('throws at construction for an invalid peer_whitelist entry, naming the entry', () => {
        expect(() => compileRequestWhitelist({ip_whitelist: [], peer_whitelist: ['192.0.2.0/33']}))
            .to.throw(Error, /Invalid peer_whitelist entry "192.0.2.0\/33"/);
    });
});

describe('warnIfWhitelistTrustsForwardedHeader', () => {
    let warnSpy: sinon.SinonSpy;

    beforeEach(() => {
        warnSpy = sinon.spy(logger, 'warn');
    });

    afterEach(() => {
        warnSpy.restore();
    });

    it('warns for trust_proxy true and a non-empty ip_whitelist', () => {
        warnIfWhitelistTrustsForwardedHeader({trust_proxy: true, ip_whitelist: ['192.0.2.10']});

        expect(warnSpy.calledOnce).to.be.true;
        expect(String(warnSpy.firstCall.args[0])).to.match(/trust_proxy is true/);
        expect(String(warnSpy.firstCall.args[0])).to.match(/ip_whitelist/);
        expect(String(warnSpy.firstCall.args[0])).to.match(/peer_whitelist/);
    });

    it('warns for a hop-count trust_proxy and a non-empty ip_whitelist', () => {
        warnIfWhitelistTrustsForwardedHeader({trust_proxy: 2, ip_whitelist: ['192.0.2.0/24']});

        expect(warnSpy.calledOnce).to.be.true;
        expect(String(warnSpy.firstCall.args[0])).to.match(/trust_proxy is 2/);
    });

    it('does not warn for a CIDR-list trust_proxy', () => {
        warnIfWhitelistTrustsForwardedHeader({trust_proxy: ['198.51.100.0/24'], ip_whitelist: ['192.0.2.10']});

        expect(warnSpy.called).to.be.false;
    });

    it('does not warn for a named-subnet trust_proxy', () => {
        warnIfWhitelistTrustsForwardedHeader({trust_proxy: 'loopback', ip_whitelist: ['192.0.2.10']});

        expect(warnSpy.called).to.be.false;
    });

    it('does not warn for an empty or absent ip_whitelist', () => {
        warnIfWhitelistTrustsForwardedHeader({trust_proxy: true, ip_whitelist: []});
        warnIfWhitelistTrustsForwardedHeader({trust_proxy: true});

        expect(warnSpy.called).to.be.false;
    });

    it('does not warn when trust_proxy is off', () => {
        warnIfWhitelistTrustsForwardedHeader({trust_proxy: false, ip_whitelist: ['192.0.2.10']});
        warnIfWhitelistTrustsForwardedHeader({trust_proxy: 0, ip_whitelist: ['192.0.2.10']});

        expect(warnSpy.called).to.be.false;
    });
});
