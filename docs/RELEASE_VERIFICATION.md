# Docs 0.1.3 verification

Runtime checks completed on 0.1.2; 0.1.3 changes the test dependency graph to
restore server-side npm 10.9.3 builds. Verified against Bifrost 1.4.2 with the tenant-write authorization
fix from Bifrost #791. This describes release verification; installers still
configure and verify their own roles and connections.

- Docker Python suite: 342 tests passed.
- Frontend Vitest: 308 tests across 85 suites passed; focused rich-editor tests passed.
- Frontend build passed; npm audit reported zero findings.
- Version 0.1.3 canonical npm 10.9.3 install and Vite build with injected SDK passed.
  Vitest 4.1.11 replaces the npm-10-incompatible Vitest 5 dependency graph.
- Fresh non-production global Solution deployment succeeded without shared workspace modules.
- Ordinary customer and provider Reader, Editor, and Administrator roles were verified.
  No-role app access was denied; customer and restricted-record reads were isolated.
- Updates, both upsert modes, and atomic batch writes rejected organization retargeting.
- Native drafts, edits, explicit publication confirmation, publisher authorization,
  credential-shaped input rejection, and tenant boundaries passed.
- Managed attachment signed upload, registration, download, deletion, and foreign
  organization denial passed.
- The installed document page rendered in light and dark themes at desktop and
  mobile widths, with no page errors or horizontal overflow.
- Optional migration used a synthetic IT Glue HTTP source: nested folders/documents,
  attachment bytes, password metadata only, taxonomy, unchanged and changed delta runs,
  completed-run resume rejection, and source-confirmed deletion reconciliation passed.
  Temporary users, organizations, rows, files, mappings, and connection settings were removed.

Migration verification used synthetic fixtures. This release does not claim a fresh
production customer cutover, large-volume recovery rehearsal, or full backup/restore
verification. Follow the acceptance and cutover runbooks for those operations.

Broader platform/backend/browser suites were not rerun for the Solution package.
The platform authorization fix has its own regression coverage.
