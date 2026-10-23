# Facility maintenance add-on

An add-on for the hospital's maintenance (engineering) team: DG sets, chillers, AHUs, lifts, UPS, fire pumps, RO plant,
and the day-to-day faults of a ward (lights, taps, AC). It is the same app, switched on per install, so a hospital that
buys it gets one system for both teams. This file holds the scope, the decisions and the build order. Later sessions
follow the decisions here.

## Decisions (agreed 23 Oct 2026)

- **G. One app, two registers.** A facility item is an asset like any machine, in the same tables. Each equipment type
  belongs to a register: `biomedical` or `facility`. Asset IDs, PMS (with the date lock), contracts, suppliers,
  complaints, approvals, reminders, QR labels, audit and exports work for both without a second copy.
- **H. Teams by role and permission.** A new role **Maintenance staff** (`maintenance`) works on the facility register
  the way Biomedical staff work on the biomedical one. Which register a person works on is a permission
  (`register.biomedical`, `register.facility`), so a hospital can adjust it in Roles like any other. The **HOD stays the
  one approver** for both (condemnation, deletion, key-field edits, holds, assignment). A deputy can be named in either
  team.
- **I. Medical gases belong to whichever team the hospital says.** See "Medical gases" below.
- **J. Trades: engineering only.** Ward complaints without a machine are for these trades: Electrical, Plumbing and
  water, AC and ventilation, Civil (seepage, tiles, doors, windows), Carpentry and furniture (non-medical), Lift, Fire
  safety, Medical gas, Other. Housekeeping, pest control, laundry, security, diet and IT are left out: other teams, high
  volume, no equipment or PMS. They could be a later "service desk" add-on.
- **K. No licensing or payment flow for now.** The module is a switch in Hospital settings that only the super admin
  (the vendor) can change: `facilityEnabled`, off by default. Off means nothing about facility shows anywhere and the
  app behaves exactly as today. A signed licence file can replace the switch later.

## Who sees what

| Role | Biomedical register | Facility register |
|---|---|---|
| Admin (HOD) | everything | everything |
| Biomedical staff | works on it | — |
| Maintenance staff | — | works on it |
| Nursing staff | own department, read-only + raise complaints | same |
| Super admin | as today, both registers | as today |

"Works on it" means what Biomedical staff can do today, limited to that register: assets, PMS, contracts, complaints
(start, resolve), expenses, consumables, reports, the bell and reminders. A person with neither register permission sees
no equipment work at all. Lists, counts, dashboards, reports, reminders, notices, My work, global search and the audit
pack all follow the register, as they follow the department today. A user with both registers gets a register switch
on lists, the dashboard and reports (default: both).

Consumables stay one store per register (a filter is a light bulb, not a ventilator part): each item belongs to a
register.

## Ward complaints

The ward has one "Raise complaint" screen and does not need to know which team fixes what:

1. **A machine** (as today): pick the equipment. The complaint goes to the team of that equipment's register.
2. **Something else in my ward**: pick the location (room, bed, toilet) and the trade, describe it, add a photo. The
   complaint goes to the team that owns the trade.

A complaint without a machine follows the same workflow (open → in progress ⇄ on hold → resolved → closed, assign,
escalate, close by the raiser, auto-close) and the same timestamps. It has no downtime, since no machine is down; its
figure is **resolution time** (resolved − raised), next to response time. Uptime and the critical-downtime limit only
count complaints on machines. Each trade can carry a response target in hours (optional, e.g. Electrical urgent 1 h),
flagged on the complaint and in the report like the critical-downtime limit.

## Medical gases

Some hospitals give the oxygen plant, manifolds, compressors, vacuum and pipeline outlets to biomedical, others to
maintenance. The hospital answers once, in Hospital settings: **"Medical gases are looked after by: Biomedical /
Maintenance"** (shown only when the module is on; Biomedical when it is off). That one answer sets:

- the register of every equipment type marked as a medical gas type (a checkbox on the type), and
- the team of the "Medical gas" trade, for outlet faults raised without a machine.

Changing it later moves those types, their assets and their unresolved complaints to the other team in one
transaction: assignments are cleared (the other team takes them), the HOD is told, and it is audited. Records already
made (PMS, calibration, expenses) stay as they are and simply show under the new team.

The ward never sees any of this: they raise "oxygen outlet at bed 4 not working" and it reaches whoever owns gases.

## Statutory licences and inspections

Certificates the law requires, with the authority, number, valid from / to, the document, and what it covers (an item,
or the site): lift licence, fire NOC, DG pollution certificate, electrical inspector's approval, PESO licence (oxygen
tank), boiler / pressure vessel inspection, water test reports. Reminders at the same lead days, an "expired" state, a
compliance register report (PDF / Excel) for NABH and inspections, and a section in the audit pack. Kept by whoever has
the register of what it covers; site-wide ones by the facility team.

## Daily logs and readings

The plant-room logbook on screen: DG run hours and diesel level, energy meter, water meter, chiller temperatures, RO
TDS, oxygen manifold pressure. Each item has the readings it takes (name, unit, normal range, how often). A reading is
dated by the server like an in-house PMS and cannot be edited; a correction is a new linked entry. A reading outside its
range flags the item and tells the team. A missed reading (none today for a daily one) shows on My work.

**PMS by run hours:** a PMS checklist can be due every N hours (DG service every 250 h) instead of, or as well as,
every N months; the due point moves with the hours logged.

## Reports

Facility figures on the dashboard and in the monthly report (same layout, by register). New reports: compliance
register; complaints by trade and location with response targets; consumption (energy, diesel, water) by month; PMS by
run hours. The audit pack adds a facility section (licences, logbooks, facility PMS).

## Build order

1. **F1. Switch, register and team.** Done (branch `facility-maintenance`, see CLAUDE.md status). `facilityEnabled` (super admin only), the register on equipment types (existing
   types are biomedical), the `maintenance` role and `register.*` permissions, register scope in every query that has
   department scope today, the register switch on lists, dashboard and reports, menus that follow it, consumables per
   register. Sellable on its own as "register + PMS + contracts + complaints for facility equipment".
2. **F2. Ward complaints without a machine.** Done (branch `facility-f2`). Optional asset on a complaint, location +
   trade, trades in Setup (name, team, response target), routing, resolution time, complaints-by-trade report. Medical
   gases setting. Not in F2: costs on a complaint without a machine (service expenses need a machine), a trade filter on
   the complaints board (search finds trade and place).
3. **F3. Statutory licences.** Register, reminders, compliance report, audit pack.
4. **F4. Logs and readings.** Reading types per item, server-dated entries, out-of-range flags, missed readings, run-hour
   PMS, consumption charts.
5. **F5. Facility reports.** Dashboard, monthly report and the audit-pack section, by register.

Later, not planned: QR checkpoints for rounds, energy cost per bed, work permits (hot work, electrical shutdown), a
signed licence file for paid modules.

## Open

- The HOD's label is "Admin (Biomedical HOD)"; with the module on it could read "Admin (HOD)".
- Starter types so far: DG set, chiller, AHU, UPS, lift, RO plant, oxygen plant, medical gas manifold. Fire pump,
  compressor and vacuum are still to add, with their checklists.
