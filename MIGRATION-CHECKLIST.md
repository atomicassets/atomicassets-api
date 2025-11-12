# Migration Checklist: eosio-contract-api

**Date Started**: 2025-11-12
**Migrated By**: [Your name]

## Pre-Migration

- [x] Git history captured
- [x] Service files copied to monorepo
- [x] package.json updated for monorepo

## Code Migration

- [ ] Review and update imports for shared packages
- [ ] Extract shared code to `packages/` if needed
- [ ] Update TypeScript configuration
- [ ] Update environment variable handling
- [ ] Review and update Docker configuration
- [ ] Update any hardcoded paths

## Dependencies

- [ ] Install dependencies: `pnpm install`
- [ ] Verify all dependencies resolved
- [ ] Update any outdated dependencies
- [ ] Move shared dependencies to workspace packages

## Testing

- [ ] Unit tests pass: `pnpm test`
- [ ] Build succeeds: `pnpm build`
- [ ] Service runs locally
- [ ] Integration tests pass (if applicable)

## Local Development (Tilt + Kind)

- [ ] Add service to `infrastructure/local-dev/Tiltfile`
- [ ] Create Helm chart in `infrastructure/helm-charts/eosio-contract-api/`
- [ ] Create `values-local.yaml` for local dev
- [ ] Test deployment: `tilt up`
- [ ] Verify service starts and health checks pass
- [ ] Test database connectivity (if applicable)
- [ ] Test Redis connectivity (if applicable)
- [ ] Test S3 connectivity (if applicable)
- [ ] Verify endpoints respond correctly

## Documentation

- [ ] Update service README with accurate description
- [ ] Document environment variables
- [ ] Document dependencies
- [ ] Add to `docs/services/` index
- [ ] Update `COMPLETE-SERVICE-INVENTORY.md`

## Infrastructure

- [ ] Helm chart created and tested
- [ ] Resource limits defined
- [ ] Health checks configured
- [ ] Ingress rules configured (if needed)
- [ ] ConfigMaps/Secrets identified

## Validation

- [ ] Code review completed
- [ ] Performance similar to standalone version
- [ ] No regressions identified
- [ ] Monitoring/logging working

## Cleanup

- [ ] Remove original service from `repos/services/eosio-contract-api` (after validation)
- [ ] Archive original repo (optional)
- [ ] Update team documentation

## Notes

[Add any migration-specific notes, challenges, or decisions here]

