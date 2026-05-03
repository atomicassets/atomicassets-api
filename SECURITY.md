# Security Policy

The AtomicAssets API powers infrastructure that many users depend on.
We take security reports seriously and appreciate responsible disclosure.

## Supported versions

The latest release on the `main` branch is supported. Older tagged
releases are not actively patched; please upgrade to the latest version
before reporting a vulnerability that already exists in newer code.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security concerns.

Instead use one of:

1. **GitHub Private Vulnerability Reporting** (preferred):
   <https://github.com/atomicassets/atomicassets-api/security/advisories/new>
2. **Email** the AtomicHub security team at `security@atomichub.io`. If
   sending sensitive reproduction details, please request a PGP key in
   your initial message.

Include in your report:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, including request payloads, configuration, or
  exploit scripts.
- The version (commit SHA or release tag) you tested against.
- Any suggested mitigations.

## What to expect

- We will acknowledge receipt of your report within **2 business days**.
- We aim to provide an initial assessment within **5 business days** and
  to ship a fix or coordinated disclosure within **30 days** for
  confirmed high-severity issues.
- We will credit reporters in the release notes unless you ask
  otherwise.

## Scope

In scope: code in this repository (the indexer, the HTTP API, the
WebSocket server, the database migrations).

Out of scope: vulnerabilities in dependencies (please report those
upstream), production deployment misconfigurations, and issues affecting
only third-party forks.

Thank you for helping keep the AtomicAssets ecosystem secure.
