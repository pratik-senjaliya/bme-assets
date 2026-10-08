# Upgrading an installed system

An upgrade replaces the program and applies any database changes. Your data, uploads and settings are kept.
Plan for a few minutes when nobody is entering data.

1. **Back up first.**
   ```bash
   docker compose exec backup bash /backup.sh once
   ```
   Check that new `db-...sql.gz` and `uploads-...tar.gz` files appeared in `backups/`, and copy them somewhere safe.

2. **Get the new version** into the same folder (`git pull`, or unzip the new release over it). Keep your `.env`.
   Compare `.env.example` with your `.env` in case a new setting was added; `docker compose up` will tell you if a
   required one is missing.

3. **Rebuild and restart.**
   ```bash
   docker compose up -d --build
   ```
   When the `api` container starts it applies any new database migrations automatically (it logs
   `N migrations found` and `All migrations have been successfully applied` or `No pending migrations`).
   The `db` and `backup` containers are not touched.

4. **Check.**
   ```bash
   docker compose ps                  # all healthy
   docker compose logs --tail 30 api
   ```
   Sign in, open the dashboard and an asset. New permission codes introduced by a release are added automatically when the API starts, and are given to the roles that have them by default. Permission changes you made yourself (Admin > Roles) are never overwritten. If a release *changes a default* for an existing permission, the release notes say so, because existing roles keep what they have.

## Rolling back

Database migrations only move forward, so going back means restoring the backup you took in step 1 together with the old version:
1. `docker compose down`
2. Put the previous version's files back (`git checkout <previous tag>` or the old release folder), keeping `.env`.
3. `docker compose up -d --build`, then stop `web`, `api` and `proxy`, and restore the database from the backup as described in `docs/install.md` ("Backups and restoring").
4. `docker compose up -d`.

Anything entered between the backup and the rollback is lost, so keep the window short.

## Server-wide notes

- Docker images are rebuilt from the files in the folder, so an upgrade needs internet once (or the offline route in `docs/install.md`).
- Old images pile up: `docker image prune` removes the unused ones.
