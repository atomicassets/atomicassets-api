# @atomichub/eosio-contract-api

**Status**: Migrated from standalone repository
**Migration Date**: 2025-11-12
**Original Repository**: `repos/services/eosio-contract-api`

## Overview

[Add service description here]

## Git History

Complete git history from the original repository is preserved in:
`docs/services/eosio-contract-api-GIT-HISTORY.md`

## Development

```bash
# Install dependencies (from monorepo root)
pnpm install

# Build this service
pnpm turbo run build --filter=@atomichub/eosio-contract-api

# Development mode
pnpm turbo run dev --filter=@atomichub/eosio-contract-api

# Run tests
pnpm turbo run test --filter=@atomichub/eosio-contract-api
```

## Local Development with Tilt

This service can be run locally using Tilt + Kind:

```bash
cd infrastructure/local-dev
tilt up
```

See `infrastructure/local-dev/README.md` for more details.

## Configuration

[Document environment variables and configuration here]

## Dependencies

- **Database**: [Specify if needed]
- **Redis**: [Specify if needed]
- **S3**: [Specify if needed]
- **Other Services**: [List dependencies]

## Deployment

See `infrastructure/README.md` for deployment instructions.

