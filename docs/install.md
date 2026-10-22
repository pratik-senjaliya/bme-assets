# Installing on the hospital server

One install = one hospital. The system runs as five containers on one Linux server and is used from PCs on the
hospital LAN. Nothing in it needs the internet after installation.

| Container | What it is |
|---|---|
| `proxy` | Caddy. The only thing staff reach (port 80). |
| `web` | The web app (Next.js). |
| `api` | The API and the daily reminder job. Applies database migrations when it starts. |
| `db` | PostgreSQL 16. Data lives in a Docker volume. |
| `backup` | Nightly backup of the database and uploaded files, 14 days kept. |

## What you need

- A Linux server (Ubuntu 22.04 / 24.04 recommended): 2 CPU cores, 4 GB RAM, 20 GB free disk plus space for backups.
- Docker Engine with the Compose plugin: <https://docs.docker.com/engine/install/> (on Ubuntu: `curl -fsSL https://get.docker.com | sudo sh`).
- Internet **during installation only**, to download Docker images and packages. For a server with no internet at all, see "Offline server" below.
- Staff PCs on the same network, and a fixed address or hostname for the server (for example `http://192.168.1.20` or `http://bme.hospital.local`).

## Install

1. **Get the files** onto the server (git clone, or unzip the release) and go into the folder.

2. **Create the settings file.**
   ```bash
   cp .env.example .env
   nano .env
   ```
   Fill in:
   - `DB_PASSWORD`: a long random password (`openssl rand -hex 24`).
   - `JWT_SECRET`: a long random string (`openssl rand -base64 48`).
   - `PUBLIC_URL`: the address staff will type, e.g. `http://192.168.1.20`.
   - Leave the rest as it is unless you need to (port, time zone, backup folder and hour).

   Keep `.env` private. It is not part of the repository.

3. **Build and start.**
   ```bash
   docker compose up -d --build
   ```
   The first build downloads packages and takes several minutes. Check that everything is healthy:
   ```bash
   docker compose ps          # api, web and db should say "healthy"
   ```

4. **Set up the hospital (first install only).** This creates the hospital profile, the roles, the vendor's super admin
   and the hospital's first admin (the Biomedical HOD). It adds no demo data.
   ```bash
   docker compose run --rm api node dist/bootstrap.js \
     --hospital-name "Shalby Hospital" --code SHL \
     --admin-email hod@hospital.in --admin-name "Dr. A. Shah" \
     --starter-types
   ```
   - `--code` is the short hospital code used in asset IDs (2 to 10 letters or digits).
   - `--starter-types` adds four equipment types (ventilator, patient monitor, defibrillator, infusion pump) with generic PMS checklists. Leave it out to start empty.
   - The sign-in details for the super admin and the admin are **printed once**. Write them down.
   - Running it again is refused once the install has users.

5. **Open the system** in a browser at the `PUBLIC_URL`, sign in as the admin, and:
   1. Change the admin's password: your name at the top right > **Change password**. The admin cannot change the super admin's password (that login belongs to the vendor): sign in once as the super admin and change it the same way, then keep it in the vendor's password store, not at the hospital. Each new user should do the same after their first sign-in.
   2. Check the asset ID pattern in Admin > Hospital settings **before adding the first asset**. It cannot be changed afterwards. Only the super admin can change it.
   3. Add departments and their locations, and any more equipment types (Admin).
   4. Add users: biomedical staff, and nursing staff (each tied to one department).
   5. If the server can reach a mail server, add it under Admin > Hospital settings for reminder emails. Without it, reminders appear in the app only.

6. **Check the backup works** (it also runs by itself every night at 02:00):
   ```bash
   docker compose exec backup bash /backup.sh once
   ls backups/
   ```

## Day to day

```bash
docker compose ps                  # is everything running?
docker compose logs -f api         # follow the API's log (also: web, db, backup, proxy)
docker compose restart api         # restart one part
docker compose down                # stop everything (data is kept)
docker compose up -d               # start again
```
The containers start again by themselves after a server reboot.

## Backups and restoring

Each night the `backup` container writes three files to the `backups/` folder (`BACKUP_DIR` in `.env`):
`db-<date>.sql.gz` (the whole database), `uploads-<date>.tar.gz` (attachments and certificates) and `env-<date>` (a copy
of `.env`, with the passwords and secrets a rebuilt server needs). Files older than 14 days are deleted. Every run is
recorded: Admin > Hospital settings > Backups shows the last one, and if a backup fails or has not run for two days the
HOD gets a notice in the bell. **Copy that folder off the server regularly** (another machine, a USB disk, the hospital's own backup
system): a backup on the same disk does not survive the disk failing.

To restore (this replaces everything currently in the system):
```bash
docker compose stop web api proxy
docker compose exec -T db psql -U bme -d postgres -c "DROP DATABASE bme" -c "CREATE DATABASE bme OWNER bme"
gunzip -c backups/db-YYYYMMDD-HHMMSS.sql.gz | docker compose exec -T db psql -U bme -d bme -v ON_ERROR_STOP=1
# attachments (only if the uploads volume is lost):
docker compose run --rm --no-deps -v "$PWD/backups:/backups:ro" --entrypoint sh api \
  -c "tar -xzf /backups/uploads-YYYYMMDD-HHMMSS.tar.gz -C /data"
docker compose up -d
```
Try a restore on a spare machine before you need it.

### Rebuilding the server

If the server itself is lost (disk failure, theft), on a new machine with the latest copy of the `backups/` folder:

1. Install Docker and get this release as in steps 1–2 of **Install**.
2. Instead of writing a new `.env`, copy the latest `backups/env-<date>` to `.env` in the release folder. It keeps the
   database password, the session secret (signed-in sessions stay valid) and `PUBLIC_URL`. If the new server has a
   different address, change `PUBLIC_URL` (QR labels already printed point at the old address, so keep the old name in
   the hospital's DNS if you can).
3. Put the backup files in `backups/` and start only the database: `docker compose up -d db`.
4. Restore the database and the attachments with the commands above, then `docker compose up -d`.
5. Sign in and check a few assets, their documents and Admin > Hospital settings > Backups (run a backup now with
   `docker compose exec backup bash /backup.sh once`).

Keep the `env-<date>` files as carefully as the database backups: they contain the passwords.

## If someone cannot sign in

An admin can set a new password for anyone in Admin > Users. If nobody can sign in, reset it on the server:
```bash
docker compose run --rm api node dist/resetPassword.js --email hod@hospital.in --password "a new password"
```
(Leave out `--password` to get a random one.) The reset is recorded in the audit log.

## Offline server (no internet at all)

Build on any machine with internet and Docker, then carry the images over:
```bash
docker compose build
docker pull postgres:16 && docker pull caddy:2
docker save bme-api bme-web postgres:16 caddy:2 -o bme-images.tar
```
Copy `bme-images.tar` and the repository folder (with your `.env`) to the server, then:
```bash
docker load -i bme-images.tar
docker compose up -d --no-build
```

## HTTPS on the LAN (optional)

Plain HTTP is the default because hospital LANs usually have no public name or certificate. To use HTTPS with Caddy's
own certificate authority:
1. In `deploy/Caddyfile`, replace `:80` with your server name (`bme.hospital.local`) and add `tls internal` inside the block.
2. In `docker-compose.yml`, add `- "443:443"` under the `proxy` ports.
3. In `.env`, set `PUBLIC_URL=https://bme.hospital.local` and `COOKIE_SECURE=true`.
4. `docker compose up -d`, then install Caddy's root certificate (from the `caddy-data` volume,
   `pki/authorities/local/root.crt`) on the staff PCs so browsers trust it.

Phones that scan QR labels must trust that certificate too, or they show a warning first; on a LAN where that is a
burden, keep plain HTTP.

*This option has not been tested yet.*

## QR labels and the server's address

QR labels hold the address of each machine's page. Set **Admin > Hospital settings > Address on QR labels** to the
address staff use on the hospital network (for example `http://bme.hospital.local`, or `http://192.168.1.20` if
there is no name), so labels printed from any computer open the right place. If the server's address ever changes,
labels already stuck on machines keep the old one: give the new server the old name or address if you can.

## Keeping an eye on it

- **Admin > Hospital settings > System** shows the version, when the daily check last ran and the free disk space.
- `http://<server>/api/v1/health` answers with the version, whether the database is up and when the daily check last
  ran (for a monitoring tool, if the hospital has one).
- The HOD gets a notice in the bell when a backup failed or stopped, or when the disk has less than 2 GB or 10% free.
- Container logs rotate by themselves (5 files of 10 MB each per service).

## What was and was not tested

Tested with the real images in Docker: build, start, first-install bootstrap, sign-in through the proxy, creating an
asset (ID `TST-ICU-VENT-ICU1-001` on a test install), a 6 MB upload and identical download, reports, the audit log,
backup and its 14-day clean-up, restoring a backup into a new database with matching row counts, stopping and starting
with data kept, and the password reset.
Not tested: the HTTPS option, the offline `docker save` route, and the plan's target of a working login within
30 minutes on a *fresh* Linux VM (the steps above are the ones that were run, but the clock was not).
