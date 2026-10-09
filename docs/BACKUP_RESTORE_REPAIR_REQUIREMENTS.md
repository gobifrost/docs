# Backup and restore requirements

Backups and restores are platform operations. Before a production migration or
cutover, confirm the selected Bifrost backup mechanism supports the expected table
rows, managed-file sizes, encryption mode, retention period, and restore target.

A restore rehearsal should verify that:

- table rows retain their identifiers and relationships;
- managed files retain their expected size and checksum;
- Solution-owned definitions, policies, and workflow registrations are present;
- integration credentials and mappings are restored only through the platform’s
  approved secure mechanism; and
- unsafe, malformed, or tampered archives are rejected.

Do not store backup archives, table exports, customer records, credentials, or live
verification evidence in this repository.
