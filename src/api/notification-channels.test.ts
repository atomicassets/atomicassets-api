import 'mocha';
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

// The filler publishes each notification on a channel name and the API's socket
// handlers subscribe by that same name, matched with strict equality in
// ApiNotificationReceiver. Nothing links the two literals, so a name that
// differs on one side silently drops every notification on that channel: the
// socket connects, the room joins, and no event ever arrives. That is how
// `buyoffer`/`buyoffers` and `template_buyoffer`/`template_buyoffers` stayed
// broken. These tests pin the pairing so the next divergence fails here.

const SRC = path.join(__dirname, '..');

function walk(dir: string): string[] {
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap(item => {
        const full = path.join(dir, item.name);

        if (item.isDirectory()) {
            return walk(full);
        }

        return item.name.endsWith('.ts') && !item.name.includes('.test.') ? [full] : [];
    });
}

function channelsMatching(dir: string, pattern: RegExp): Set<string> {
    const found = new Set<string>();

    for (const file of walk(dir)) {
        const source = fs.readFileSync(file, 'utf8');

        for (const match of source.matchAll(pattern)) {
            found.add(match[1]);
        }
    }

    return found;
}

describe('notification channel names', () => {
    const published = channelsMatching(
        path.join(SRC, 'filler'), /send(?:ActionTrace|ContractRow)\('([a-z_]+)'/g
    );
    const subscribed = channelsMatching(
        path.join(SRC, 'api'), /\.onData\('([a-z_]+)'/g
    );

    it('publishes on at least one channel, so an empty scan cannot pass vacuously', () => {
        expect(published.size).to.be.greaterThan(0);
        expect(subscribed.size).to.be.greaterThan(0);
    });

    it('every channel the filler publishes has a subscriber in the API', () => {
        const orphaned = [...published].filter(channel => !subscribed.has(channel));

        expect(orphaned, `filler publishes on ${orphaned.join(', ')} with nothing subscribed`).to.deep.equal([]);
    });

    it('every channel the API subscribes to is published by the filler', () => {
        const unfed = [...subscribed].filter(channel => !published.has(channel));

        expect(unfed, `API subscribes to ${unfed.join(', ')} which nothing publishes`).to.deep.equal([]);
    });
});
