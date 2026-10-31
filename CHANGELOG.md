# Changelog

What changed in each release of BME Asset Management, newest first. The version running on a server shows in the
account menu, in Admin > Hospital settings > System and at `/api/v1/health`. Upgrading: `docs/upgrade.md`.

Versions are `major.minor.patch`: a new minor version adds features, a patch only fixes. Database changes are applied
by themselves when the API starts.

## Unreleased

- **Demo logins on the sign-in page (cloud demo only):** on `*.vercel.app` the sign-in page lists six sample logins
  with their roles and the shared password; picking one signs in. A hospital's own install (any other address) never
  shows them.
- **Walkthrough video tooling** (`tools/walkthrough-video/`, nothing in the app changes): records the product
  walkthrough shown in meetings, every module in about 13 minutes, with captions and an optional English voice-over,
  against its own demo database so no real data is touched. How to re-make it: its `README.md`.
- **Session log** (`docs/session-log.md`): what each working session did, decided and left open, so work can continue
  from another device with the same context.
- **Docs:** the live demo address is https://bme-assets.vercel.app (`docs/deployment.md`, `CLAUDE.md`, `render.yaml`
  had an old example); `docs/deployment.md` shows the current state of the demo and how to reload the full demo
  hospital into it.

## 1.6.1 (24 October 2026)

- **Full demo hospital:** `npm run db:demo -w apps/api` replaces a demo database with a complete hospital and about
  18 months of history in every module (equipment, purchases, contracts, PMS, calibration certificates, breakdowns and
  ward complaints, expenses, consumables, licences, logbook readings, approvals, saved monthly reports, reminders and
  the audit log), so every screen and report has realistic data to show. It wipes the database first: never run it on
  a hospital's real data. New demo logins are listed in CLAUDE.md.

## 1.6.0 (24 October 2026)

- **Costs on ward complaints:** parts and bills can be booked when resolving a ward complaint that has no machine (a
  tap, a light, a door). The expenses report lists them as "Ward complaint", grouped by trade.
- **Machine or trade filter** on the complaints board and history: one trade's ward complaints (Electrical,
  Plumbing…), or only complaints about a machine.
- **New starter types with PMS checklists:** Fire Pump (maintenance), Medical Air Compressor and Medical Vacuum Plant
  (with whichever team looks after medical gases). New installs get them; an existing hospital adds them under
  Admin > Equipment types.
- **Stay signed in:** two minutes before the 12-hour sign-in ends, a message offers to carry on, so a long PMS is not
  cut off at submit.
- **Sign-in lock kept in the database:** five wrong passwords lock a login for 15 minutes, and a server restart no
  longer lifts it.
- **Faster dashboard:** its figures come from fewer database queries, asked for at once.

## 1.5.0 (23 October 2026)

- **Facility reports (facility add-on):** the dashboard has a Facility card for the maintenance team and the HOD (ward
  complaints open and over target, licences expired or ending, readings still to take or out of range, PMS due by run
  hours). The monthly report adds a facility section (ward complaints by trade, readings out of range, licences expired
  or ending) and, like the audit pack, now has an "All equipment / Biomedical / Facility" switch. The audit pack adds
  "12 Logbook.xlsx" when it covers facility equipment.

## 1.4.0 (23 October 2026)

- **Logbook (facility add-on):** the plant-room logbook on screen. On a machine's Logbook tab the team sets what is
  read (run hours, diesel level, temperatures, TDS, pressures, energy and water meters), its unit, normal range and how
  often (daily, weekly, monthly). A reading is dated by the system and cannot be changed; a wrong one is corrected with
  a reason and the original stays. A reading outside its range tells the team at once; readings still to take, readings
  out of range and PMS due by run hours show on My work. Equipment > Logbook lists what is owed now for the round.
  Meters never go back.
- **PMS by run hours:** a machine with a run-hours meter can have PMS every N hours (DG set every 250 h), counted from
  the meter at its last PMS.
- **New report:** Consumption and readings (meter use per month, readings out of range, PMS by run hours).
- New permission "Take logbook readings".

## 1.3.0 (23 October 2026)

- **Statutory licences and inspections (facility add-on):** Equipment > Licences keeps lift licences, fire NOC, DG
  pollution certificates, electrical inspector's approvals, PESO licences, pressure vessel inspections, water test
  reports and AERB licences: who issued them, the number, valid from and to, the document, and what they cover (one
  item, or the whole site). Each team keeps its own (a licence follows the team of what it covers). Reminders come at
  the same lead days as PMS, then once when a licence has expired. Renewing records the new licence and keeps the old
  one as history. "Licences" on My work lists those expired or ending. New report: Compliance register; the audit pack
  adds it and a Licences folder with the documents. New permission "Keep statutory licences".

## 1.2.0 (23 October 2026)

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

## 1.1.0 (23 October 2026)

- **Facility maintenance add-on (first part):** the maintenance team's equipment (DG sets, chillers, AHUs, UPS, lifts,
  RO plant) in the same register, PMS, contracts, complaints, reminders and reports, kept apart from the biomedical
  team's. Switched on per hospital by the super admin (Hospital settings > Facility maintenance); off, nothing about it
  shows. New role Maintenance staff; which equipment a role works on is a permission (Roles & permissions > Equipment
  they work on). Wards see and report on both in their department; the HOD sees both, with a Biomedical / Facility
  switch on the dashboard, lists, complaints board, due lists and reports. Each team keeps its own consumables store.
  Starter facility types with PMS checklists are added when the add-on is first switched on. A maintenance engineer
  can be deputy HOD.

## 1.0.0 (22 October 2026)

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
