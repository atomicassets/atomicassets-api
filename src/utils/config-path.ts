import * as path from 'path';

// Resolve the directory the runtime config files (connections/server/readers)
// are loaded from. Defaults to the path the Docker image mounts them at, so the
// container and the production deployment are unchanged. Set CONFIG_DIR (an
// absolute path, or one relative to the working directory) to run the binaries
// outside the image - e.g. `CONFIG_DIR=./config pnpm start:server` for a local
// checkout.
const configured = process.env.CONFIG_DIR || '/home/node/app/config';
const CONFIG_DIR = path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);

export function configFile(name: string): string {
    return path.join(CONFIG_DIR, name);
}
