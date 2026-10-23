# Changelog

What changed in each release of BME Asset Management, newest first. The version running on a server shows in the
account menu, in Admin > Hospital settings > System and at `/api/v1/health`. Upgrading: `docs/upgrade.md`.

Versions are `major.minor.patch`: a new minor version adds features, a patch only fixes. Database changes are applied
by themselves when the API starts.

## 1.3.0 (November 2026)

- **Statutory licences and inspections (facility add-on):** Equipment > Licences keeps lift licences, fire NOC, DG
  pollution certificates, electrical inspector's approvals, PESO licences, pressure vessel inspections, water test
  reports and AERB licences: who issued them, the number, valid from and to, the document, and what they cover (one
  item, or the whole site). Each team keeps its own (a licence follows the team of what it covers). Reminders come at
  the same lead days as PMS, then once when a licence has expired. Renewing records the new licence and keeps the old
  one as history. "Licences" on My work lists those expired or ending. New report: Compliance register; the audit pack
  adds it and a Licences folder with the documents. New permission "Keep statutory licences".

## 1.2.0 (November 2026)

- **Ward complaints without a machine (facility add-on):** "Raise complaint" now offers "Something else in the ward":
  what kind of problem (Electrical, Plumbing and water, AC and ventilation, Civil, Carpentry and furniture, Lift, Fire
  safety, Medical gas, Other) and where. It goes to the team that owns the trade and follows the usual steps (start,
  hold, resolve, close by the ward). It has a resolution time instead of downtime and is not counted as a breakdown or
  in uptime. Trades are set up in Admin > Trades, each with its team and an optional response target in hours; a
  complaint where work starts later than that is flagged. Costs are booked only on complaints about a machine.
- **Medical gases:** Hospital settings > "Medical gases are looked after by" Biomedical or Maintenance. Equipment types
  can be marked as medical gas equipment; changing the setting moves those types, their equipment, the Medical gas
  trade and their unresolved complaints (unassigned) to the other team in one step, and tells both teams and the HOD.
  New starter types: Oxygen Plant and Medical Gas Manifold.
- **Maintenance contact for the wards**, shown next to the biomedical one.
- **New report:** Ward complaints by trade (by trade, by location, response and resolution times, over target).

## 1.1.0 (October 2026)

- **Facility maintenance add-on (first part):** the maintenance team's equipment (DG sets, chillers, AHUs, UPS, lifts,
  RO plant) in the same register, PMS, contracts, complaints, reminders and reports, kept apart from the biomedical
  team's. Switched on per hospital by the super admin (Hospital settings > Facility maintenance); off, nothing about it
  shows. New role Maintenance staff; which equipment a role works on is a permission (Roles & permissions > Equipment
  they work on). Wards see and report on both in their department; the HOD sees both, with a Biomedical / Facility
  switch on the dashboard, lists, complaints board, due lists and reports. Each team keeps its own consumables store.
  Starter facility types with PMS checklists are added when the add-on is first switched on. A maintenance engineer
  can be deputy HOD.

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
