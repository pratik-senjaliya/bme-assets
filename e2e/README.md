# Browser tests (end to end)

These drive the real screens in Chrome, as each role, against a running install. They complement the API tests
(`npm test -w apps/api`), which check the rules at the server; these check what a person actually sees and does.

## Run

You need the stack running and a seeded database:

```bash
npm run db:up
npm run dev:api        # http://localhost:4000
npm run dev:web        # http://localhost:3000 (a production build also works and is much faster)
npm run db:seed -w apps/api
npm run db:seed:history -w apps/api     # optional: a year of demo history for the charts

npm run e2e                  # everything (about 10 minutes against `next dev`)
npm run e2e -- fixes a11y    # only some scripts
npm run e2e:cleanup          # remove anything a stopped run left behind
```

A Chrome is found automatically (`CHROME_PATH` to choose one; `E2E_BASE` for another address). Everything the tests
create is named `E2E-…` and is removed at the start and the end of a run, so the demo data is left as it was.

## What each script covers

| Script | Covers |
|---|---|
| `core` | Asset ID generation, form validation, PMS date lock and read-only records, complaint workflow and metrics, department scope |
| `flows` | HOD approvals (key edits, condemnation, deleting a wrong entry), audit log, sign-in audit |
| `ops` | Calibration, purchase orders, contracts, expenses, status changes, PMS corrections, print view, users, roles, departments |
| `checklists` | PMS checklist versions (old records keep theirs) |
| `misc` | Menus per role, sign in / out, session expiry, notifications, Excel import, every report to Excel and PDF, documents, keyboard |
| `fixes` | The QA fixes: session expiry, form safety, login lock, change password, permission pages, approvals buttons, sorting, exports that match lists, roles and audit wording, 404, tab titles, tablet sizes |
| `a11y` | Every screen as every role: errors, headings, tab titles, sideways scroll at 3 widths, serious accessibility problems (axe-core) |
| `phone` | Phones (375 and 320 wide): each list starts on the first screen, no sideways scroll, bottom bar, sort control; dark mode passes the accessibility check; the light/dark choice is kept |
| `labels` | QR labels: the sheet follows the list's filters, every printed code decodes to its machine's link, scanning opens the machine (after sign-in), another department's label is refused, nursing cannot print |
| `assign` | Complaint assignment and My work: the HOD assigns from the board and the engineer is told, the engineer finds it under "Assigned to me" and takes another, the nurse sees who has it, My work only for people who fix things |

Failures leave a screenshot in `e2e/.out/`.
