# Requirements from the October 2026 meetings

Three recorded meetings (in Gujarati) with the biomedical team: a walk through the app, a consumables discussion and
a stock-register discussion. This file holds what was asked, what already existed, the decisions taken and the build
order. Later sessions follow the decisions here.

## Decisions (agreed 20 Oct 2026)

- **A. OEM PMS date.** In-house PMS stays dated today by the server (rule 1). A PMS done by the OEM engineer may carry
  the date on the OEM's report, within these limits:
  - never after today
  - never before the asset's last PMS
  - at most 30 days back
  - the report file is required
  - the record is marked "entered from OEM report"
- **B. Closing a complaint.** After the engineer resolves a complaint, the person who raised it closes it. Until they
  do, they see "Resolved, waiting for you to close" and get a daily reminder. After 3 days (a hospital setting) the
  complaint closes itself with a note. Closing never changes downtime.
- **C. On hold.** Downtime is not paused while a complaint is on hold. It runs from raised to resolved by the engineer.
- **D. Critical equipment.** The levels are General, Minor, Critical and Most critical. "Critical equipment" (critical
  uptime, the critical-downtime limit, reports) means Critical + Most critical.
- **E. Transfer out.** Transferring equipment to another unit needs HOD approval, the same as condemnation.
- **F. Consumables.** Track quantity, with an optional unit cost so spend can show in reports.

## Already in the app

These were asked for in the meetings but already existed, so they needed no build:

- PMS checklist editing: Admin → PMS checklists → Edit checklist saves a new version.
- AMC/CMC contracts per machine, with the contract copy.
- Expenses with bills.
- Email through the hospital's SMTP.
- Reminder lead times.
- Roles and permissions.
- Department → location (for example ICU → bed).

Equipment type stays: PMS checklists hang off it.

## Build order

1. **Quick wins.**
   - Criticality levels.
   - PO upload on Add asset.
   - Several calibration certificates.
   - QR label weights (hospital name and asset ID large and bold).
   - PMS sticker: done date and next due date, no QR code.
2. **Complaint workflow.**
   - A note on Start work.
   - Escalate to the HOD ("needs OEM support").
   - On hold, set by the HOD only, with a note.
   - Resolve, by the engineer, also from On hold.
   - Close, by the raiser (decisions B and C).
   - This changes rule 6.
3. **OEM PMS.** Engineer name and the OEM's report; checklist optional (decision A). This changes rule 1.
4. **Condemnation form and transfer.**
   - Condemnation: a reason category (end of support, repair over 50% of price, damaged, other), estimated value and
     committee date.
   - A condemnation register grouped by committee date (PDF and Excel).
   - Transfer to another unit: a "Transferred" status that keeps the timeline up to the transfer (decision E).
5. **Suppliers and contacts.** Companies with several contacts each; Supplier and Service vendor on the asset.
   Calibration agency stays free text.
6. **Consumables.**
   - Items with quantity and an optional unit cost.
   - Stock in on purchase.
   - Issue to a department with a date, optionally linked to a machine or complaint, with a reason such as "replaced
     the broken one".
   - Low-stock warning.
   - A register of everything given out (decision F).

## Not now

A shared multi-hospital cloud (SaaS) is a redesign. Until then, a hospital without its own server gets its own
install on a cloud server, with no code change. The LAN install already works without internet.
