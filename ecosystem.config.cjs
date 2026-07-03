// PM2 process file for running atomicassets-api on bare metal / a VM.
//
// The filler (indexes blocks from SHIP into Postgres) and the server (serves the
// REST + WebSocket API) are independent processes; this starts and supervises both.
//
// Prerequisites (PM2 runs `node build/...` directly, so it does NOT trigger the
// `prestart*` build hooks that `pnpm start:*` rely on):
//   pnpm install
//   pnpm build          # produces ./build/bin/{filler,server}.js
//   pnpm db:schema:init # once, before the first start
//
// Then:
//   pm2 start ecosystem.config.cjs
//   pm2 logs            # follow both processes
//   pm2 save && pm2 startup   # survive reboots
//
// CONFIG_DIR points the binaries at your config/ directory; override it (or any of
// the values below) by exporting the env var before `pm2 start`.

const path = require('path');

const CONFIG_DIR = process.env.CONFIG_DIR || path.join(__dirname, 'config');
const NODE_ARGS = '--enable-source-maps';

module.exports = {
  apps: [
    {
      name: 'atomicassets-filler',
      cwd: __dirname,
      script: './build/bin/filler.js',
      node_args: NODE_ARGS,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: process.env.FILLER_MAX_MEMORY || '2G',
      env: {
        CONFIG_DIR,
      },
    },
    {
      name: 'atomicassets-server',
      cwd: __dirname,
      script: './build/bin/server.js',
      node_args: NODE_ARGS,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: process.env.SERVER_MAX_MEMORY || '1G',
      env: {
        CONFIG_DIR,
      },
    },
  ],
};
