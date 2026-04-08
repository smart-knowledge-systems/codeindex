-- Phase 3 dedup unification: the legacy global-store content_blobs table is
-- replaced by the per-repo file_blobs table introduced in migration 0010.
-- src/dedup/global-store-pg.ts now reads/writes file_blobs directly. Drop the
-- old table on existing deployments. Packages / package_files / repo_packages
-- still live in the global namespace and are unaffected.

DROP TABLE IF EXISTS content_blobs;
