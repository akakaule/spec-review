# Notebook: agent instructions

Fictional project used as the golden fixture for spec 021 (evaluate-claims).

## Conventions

- The HTTP API is generated from `api/openapi.yaml`. Edit the spec and regenerate; never hand-edit
  `web/src/api-client.ts`.
- Every new storage method must be implemented in both the SQLite and the Postgres store, and covered
  by the shared store tests.

## What not to do

- Don't add a plugin system; third-party extensions are not part of the product.
- Don't rewrite existing UI pages; change them incrementally.
