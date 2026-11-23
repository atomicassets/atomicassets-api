// Run: node --require @swc-node/register scripts/benchmark-logger.cjs
// Serialization/dispatch microbenchmark with a counting sink: no terminal, disk,
// pretty printing, SHIP, database work or actual indexing throughput is measured.
const { performance } = require('node:perf_hooks');
const { createLogger } = require('../src/utils/logger');

const iterations = 100_000;
let bytes = 0;
const sink = { write(line) { bytes += Buffer.byteLength(line); } };
const enabled = createLogger({ level: 'debug', production: false, output: sink, errorOutput: sink });
const disabled = createLogger({ level: 'info', production: true, output: sink, errorOutput: sink });
const data = { asset_id: '123456789', owner: 'example', attributes: 'x'.repeat(1024) };
const metadata = { contract: 'atomicassets', action: 'logtransfer', data };
const failure = new Error('representative database failure', { cause: new Error('connection reset') });

const workloads = {
    'disabled debug, existing metadata': () => disabled.debug('Trace received', metadata),
    'disabled debug, guarded action payload': () => {
        if (disabled.isLevelEnabled('debug')) {
            disabled.debug('Trace for reader example received', { contract: 'atomicassets', action: 'logtransfer', data });
        }
    },
    'enabled debug, action payload (1 KiB attribute)': () => {
        if (enabled.isLevelEnabled('debug')) {
            enabled.debug('Trace for reader example received', { contract: 'atomicassets', action: 'logtransfer', data });
        }
    },
    'enabled info, SQL metadata': () => enabled.info('query', { queryText: 'select * from assets where asset_id = $1', values: ['123456789'] }),
    'enabled error, Error + multiple metadata args, two sinks': () => enabled.error(failure, metadata, { reader: 'example' })
};

console.log(`Node ${process.version}; ${process.platform}/${process.arch}; ${iterations} calls/sample, median of 5 samples after 10000 warmup calls.`);
console.log('Microbenchmark only; counting sinks exclude I/O and pretty printing. No indexing speed claim.');
for (const [name, run] of Object.entries(workloads)) {
    for (let i = 0; i < 10_000; i++) run();
    const timings = [];
    let sampleBytes = 0;
    for (let sample = 0; sample < 5; sample++) {
        bytes = 0;
        const start = performance.now();
        for (let i = 0; i < iterations; i++) run();
        timings.push(performance.now() - start);
        sampleBytes = bytes;
    }
    timings.sort((a, b) => a - b);
    const ms = timings[2];
    console.log(`${name}: ${ms.toFixed(2)} ms, ${(ms * 1000 / iterations).toFixed(3)} us/call, ${sampleBytes} sink bytes/sample`);
}
