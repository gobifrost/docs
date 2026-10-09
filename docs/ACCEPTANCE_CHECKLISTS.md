# Bifrost Docs acceptance checklist template

Use this template for a named environment and release. Do not attach customer data,
credentials, or production screenshots to the public Solution repository.

## Release details

- Environment and URL: _TBD_
- Solution version and install ID: _TBD_
- Acceptance owner: _TBD_
- Test organizations and roles: _TBD_
- Approved window and rollback owner: _TBD_

## Core documentation

- [ ] Reader, Editor, and Administrator roles receive only their intended app and
  workflow access.
- [ ] A customer user sees only their organization’s records and files.
- [ ] A provider user’s cross-organization access is limited to the configured
  provider roles.
- [ ] Users can search and open representative documents, folders, configurations,
  locations, assets, and password metadata.
- [ ] Editors can create, revise, archive, and recover a safe test document.
- [ ] Attachments upload, download, and delete with the expected organization scope.
- [ ] Restricted and archived records follow the approved visibility rules.
- [ ] The app is usable in the agreed desktop and narrow viewport range.

## Secrets, AI, and migration

- [ ] Password and TOTP values do not appear in the app, tables, search, logs, or
  agent context.
- [ ] The Documentation Agent returns only authorized, cited information.
- [ ] If no IT Glue integration is configured, native documentation continues to
  work and migration controls explain that setup is required.
- [ ] If IT Glue is configured, an interruption and resume do not duplicate rows or
  files, and mapped-record behavior matches the approved source-sync policy.

## Approval

Acceptance owner: ____________________  Date: __________

Rollback owner: ______________________  Date: __________
