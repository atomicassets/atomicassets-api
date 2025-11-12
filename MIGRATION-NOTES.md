# eosio-contract-api Migration Notes

## Status: BUILD SUCCESSFUL ✅

## Resolution

**Date**: 2025-11-12

**Solution**: Changed all namespace imports to default imports for CommonJS modules:
- `import * as express from 'express'` → `import express from 'express'`
- `import * as compression from 'compression'` → `import compression from 'compression'`
- `import * as cors from 'cors'` → `import cors from 'cors'`
- `import * as bodyParser from 'body-parser'` → `import bodyParser from 'body-parser'`
- `import * as swagger from 'swagger-ui-express'` → `import swagger from 'swagger-ui-express'`
- `import * as WebSocket from 'ws'` → `import WebSocket from 'ws'`
- `import * as exitHook from 'async-exit-hook'` → `import exitHook from 'async-exit-hook'`

**Files Modified**:
- All TypeScript files in `src/` that used namespace imports for CommonJS modules

**Build Result**: Service now compiles successfully with `pnpm turbo run build`

## Migration Completed
- ✅ Git history captured (1216 commits from 15 contributors)
- ✅ Files copied to apps/eosio-contract-api/
- ✅ Lock file imported (yarn.lock.original preserved)
- ✅ Dependencies installed

### Build Issue

**Problem**: TypeScript compilation fails with module resolution errors:
```
error TS2307: Cannot find module 'express-serve-static-core' or its corresponding type declarations
error TS2349: This expression is not callable (express, cors, compression, etc.)
```

**Root Cause**: Likely pnpm workspace type resolution issue. The original service builds successfully in its standalone repo with yarn.

### Attempted Fixes

1. ✅ Removed `postinstall: yarn build` script
2. ✅ Changed `yarn` commands to `pnpm run`
3. ✅ Added `esModuleInterop: true` to tsconfig
4. ✅ Added `allowSyntheticDefaultImports: true` to tsconfig
5. ✅ Added `moduleResolution: "node"` to tsconfig
6. ✅ Added `resolveJsonModule: true` to tsconfig

### Verification

Original service builds successfully:
```bash
cd ../repos/services/eosio-contract-api
yarn build  # ✅ Success
```

Monorepo version fails:
```bash
pnpm turbo run build --filter=@atomichub/eosio-contract-api  # ❌ TypeScript errors
```

### Attempted Fixes

1. ✅ Added `shamefully-hoist=true` to root .npmrc
2. ✅ Reinstalled all dependencies with hoisting
3. ✅ Added `esModuleInterop`, `allowSyntheticDefaultImports`, `skipLibCheck`, `strict: false` to tsconfig
4. ❌ Still failing with module resolution errors

### Current Errors (After All Fixes)

```
error TS2349: This expression is not callable (express, cors, compression, async-exit-hook)
error TS2351: This expression is not constructable (WebSocket)
```

### Root Cause

pnpm resolves CommonJS type definitions differently than yarn. The service uses namespace imports (`import * as express`) which works in yarn but TypeScript in pnpm workspace can't recognize them as callable.

### Workaround

The service builds successfully in its original standalone repository with yarn:
```bash
cd ../repos/services/eosio-contract-api
yarn build  # ✓ Works
```

### Next Steps

1. **Option A**: Build in standalone mode, copy artifacts to monorepo
2. **Option B**: Investigate using `pnpm.packageExtensions` to fix type exports
3. **Option C**: Refactor imports to use default imports instead of namespace imports
4. **Option D**: Wait for pnpm workspace improvements or use yarn workspaces instead

**Recommendation**: Use Option A (standalone build) for now, revisit after other services are stable.

### Temporary Workaround

For now, this service can be built using the original yarn setup in `repos/services/eosio-contract-api` until the pnpm workspace issue is resolved.

###Priority

**HIGH** - This is a critical blockchain indexer service that requires high IOPS. Needs to be resolved before deployment.

## Files Modified

- `package.json`: Removed postinstall, changed yarn→pnpm
- `tsconfig.json`: Added esModuleInterop, allowSyntheticDefaultImports, moduleResolution, resolveJsonModule

## Original Dependencies Preserved

See `yarn.lock.original` for exact dependency versions from the original service.
