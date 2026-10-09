# Bifrost Docs cutover and rollback runbook

This runbook applies when moving existing documentation into Bifrost Docs. Native
Docs installations that do not use IT Glue can skip the migration phases and record
their role, file-policy, backup, and app acceptance checks instead.

## Before migration

1. Name the release owner, source-system owner, Bifrost administrator, migration
   exception owner, acceptance owner, and rollback owner.
2. Install the Solution in a non-production environment and verify the role matrix
   with representative non-administrator users.
3. Configure the optional `IT Glue` Integration secret in Bifrost. Map every target
   Bifrost organization to its IT Glue organization ID. The migration refuses
   missing or ambiguous mappings; it does not use organization names as authority.
4. Confirm that password values, TOTP values, and embedded secret values are out of
   scope. Only approved metadata and source links may migrate.
5. Run a representative API-first migration, interrupt a file transfer, resume it,
   and verify deterministic IDs, attachment hashes, restricted handling, and native
   record protection.
6. Review backup and restore capacity for the target instance before any production
   maintenance window.

## Cutover

1. Record the Solution version, install ID, source watermark, migration scope, and
   approved exception list in the private change record.
2. Run the bulk migration while the source remains authoritative.
3. Reconcile counts by organization and resource type. Investigate every critical
   mismatch before proceeding.
4. During the approved maintenance window, pause source writes, run the final delta,
   and re-run reconciliation.
5. Verify app CRUD, search, file access, agent access, and tenant policies with the
   approved roles. Do not use platform-administrator success as policy evidence.
6. Enable production roles only after the acceptance checklist is complete. Keep the
   former system available read-only for the agreed observation period.

## Rollback

Rollback changes routing and access; it does not delete migrated data.

1. Disable Bifrost Docs app and agent access for the affected roles.
2. Restore user access to the previous documentation system and, if approved, resume
   source writes there.
3. Preserve Bifrost migration rows, files, mappings, logs, and the private change
   record for diagnosis.
4. Use a tested platform backup only within its supported retention and scope. Verify
   Integration credentials and mappings before relying on a restored environment.
5. Classify and repair the blocking condition, repeat the required non-production
   proof, and schedule a new go/no-go decision.
