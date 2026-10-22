# Changelog

What changed in each release of BME Asset Management, newest first. The version running on a server shows in the
account menu, in Admin > Hospital settings > System and at `/api/v1/health`. Upgrading: `docs/upgrade.md`.

Versions are `major.minor.patch`: a new minor version adds features, a patch only fixes. Database changes are applied
by themselves when the API starts.

## 1.0.0 (October 2026)

The first numbered release: everything built so far, as installed for the first hospitals.

- **Asset register:** IDs from the hospital's pattern, purchase orders, contracts, documents, Excel import, QR labels
  and PMS stickers, suppliers and their contacts, transfers and condemnation with the committee's form.
- **PMS and calibration:** versioned checklists, server-dated read-only PMS records (OEM visits within 30 days),
  corrections as linked records, certificates, due lists, reminders at 30/15/5 days, failed results flag the machine.
- **Complaints:** Open → In progress (⇄ On hold) → Resolved → Closed, escalation, assignment and My work, urgent
  complaints first, the ward closes or sends back a fix, costs booked while resolving, downtime and response times.
- **Approvals:** key-field edits, deletions, condemnation and transfer decided by the HOD (or a deputy HOD).
- **Reports:** dashboard, fourteen reports on screen, in Excel and as signed PDFs (including engineer and supplier
  performance, and replacement and renewals), the monthly report and the audit pack; the audit log exports to Excel.
- **Loading data:** Excel import of the asset register (with tag numbers, status, purchase orders and contracts) and
  of user logins.
- **Running it:** Docker Compose install, nightly backups of the database, uploads and `.env` with a failure notice,
  disk-space and daily-job checks, first sign-in password change, usernames and "forgot password" to the HOD,
  sign-out of idle shared PCs.
