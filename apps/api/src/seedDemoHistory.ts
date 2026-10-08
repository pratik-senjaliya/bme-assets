// Optional: gives the demo a year of believable history (PMS, calibration, breakdowns, expenses, contracts, service
// entries) so the dashboard and reports have something to show. Never part of an install: run it by hand on a demo
// database that already has the base seed:  npm run db:seed:history -w apps/api
// Refuses to run twice (it would double every number); FORCE=1 overrides.
import { prisma } from './lib/prisma';
import { addMonths, isoDate, parseDate, todayISO } from './lib/dates';
import { complaintNo } from './modules/complaints/complaints.service';

// A small fixed-seed random generator, so the demo looks the same every time.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(2026);
const between = (a: number, b: number) => a + rand() * (b - a);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const DAY = 86_400_000;
const HOUR = 3_600_000;

const PROBLEMS: Record<string, string[]> = {
  VENT: ['High pressure alarm keeps sounding', 'Turbine noise during use', 'Display flickering', 'Flow sensor error', 'Battery not charging'],
  MON: ['SpO2 reading not stable', 'ECG leads show noise', 'Screen frozen, needs restart', 'NIBP cuff not inflating'],
  DEFIB: ['Charge time too long', 'Self-test failed', 'Paddles cable damaged', 'Battery low warning'],
  INFP: ['Occlusion alarm without cause', 'Door sensor error', 'Keypad not responding', 'Drop sensor fault'],
};
const FIXES = ['Replaced the faulty part and tested', 'Cleaned and recalibrated, tested OK', 'Updated settings and ran the self-test', 'Replaced cable and checked readings', 'Reseated connector, working normally'];
const AGENCIES = ['Zoll Service Centre', 'Philips Calibration Lab', 'Drager Service', 'Mindray Service', 'B. Braun Service'];
const PARTS = ['Flow sensor', 'Power cable', 'Battery pack', 'SpO2 probe', 'ECG lead set', 'Keypad membrane', 'Cooling fan', 'Pressure transducer'];

async function main() {
  if ((await prisma.complaint.count()) > 5 && !process.env.FORCE) {
    console.log('This database already has history. Nothing done (set FORCE=1 to run anyway).');
    return;
  }
  const today = parseDate(todayISO());
  const [biomed, nursing, assets, settings] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email: 'biomed@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'nursing@demo.local' } }),
    prisma.asset.findMany({ include: { equipmentType: true }, orderBy: { assetCode: 'asc' } }),
    prisma.hospitalSettings.findFirstOrThrow(),
  ]);
  const templates = new Map((await prisma.pmsTemplate.findMany({ orderBy: { version: 'asc' } })).map((t) => [t.equipmentTypeId, t])); // the latest version wins

  // Equipment that has been in service for a while, some with a warranty about to end.
  const ageYears = [3.4, 3.4, 2.1, 5.2, 4.6, 6.8, 1.6, 1.6, 9.5, 7.3];
  let n = 0;
  for (const a of assets.filter((x) => x.status === 'active')) {
    const i = n++ % ageYears.length;
    const warrantyMonths = i === 3 ? 60 : i === 8 ? 24 : i === 6 || i === 7 ? 36 : 24;
    let installed = addMonths(today, -Math.round(ageYears[i] * 12));
    if (i === 3) installed = new Date(addMonths(today, -warrantyMonths).getTime() + 25 * DAY); // warranty ends in 25 days
    if (i === 6) installed = new Date(addMonths(today, -warrantyMonths).getTime() + 52 * DAY); // and one in about 7 weeks
    await prisma.asset.update({
      where: { id: a.id },
      data: { installationDate: installed, warrantyMonths, warrantyEnd: addMonths(installed, warrantyMonths), createdAt: new Date(today.getTime() - 400 * DAY) },
    });
  }

  // PMS: done on schedule, except a couple that have slipped (so "overdue" is a small, believable number).
  const live = assets.filter((a) => a.status === 'active');
  const lagging = new Set([live[1]?.id, live[5]?.id, live[8]?.id]);
  let pmsCount = 0;
  for (const a of live) {
    const months = a.pmsFrequencyMonths ?? a.equipmentType.defaultPmsMonths ?? 6;
    const template = templates.get(a.equipmentTypeId);
    if (!template) continue;
    let last = new Date(today.getTime() - (lagging.has(a.id) ? between(months * 30 + 20, months * 30 + 55) : between(8, months * 28)) * DAY);
    let latest: Date | null = null;
    while (last.getTime() > today.getTime() - 365 * DAY) {
      latest ??= last;
      await prisma.pmsRecord.create({
        data: { assetId: a.id, templateId: template.id, performedOn: parseDate(isoDate(last)), performedBy: biomed.id, answers: {}, result: rand() < 0.93 ? 'pass' : 'fail', submittedAt: new Date(last.getTime() + 11 * HOUR), createdBy: biomed.id },
      });
      pmsCount++;
      last = addMonths(last, -months);
    }
    if (latest) await prisma.asset.update({ where: { id: a.id }, data: { nextPmsDue: addMonths(parseDate(isoDate(latest)), months) } });
  }

  // Calibration: once a year, last done a few months ago.
  let calCount = 0;
  for (const a of live) {
    const months = a.equipmentType.defaultCalibrationMonths;
    if (!months) continue;
    const done = parseDate(isoDate(new Date(today.getTime() - between(20, months * 28) * DAY)));
    await prisma.calibrationRecord.create({ data: { assetId: a.id, doneOn: done, dueOn: addMonths(done, months), agency: pick(AGENCIES), result: 'pass', createdBy: biomed.id } });
    await prisma.asset.update({ where: { id: a.id }, data: { nextCalibrationDue: addMonths(done, months) } });
    calCount++;
  }

  // Breakdowns over the last 12 months, heavier on a few machines. The last two are still open; one of them is a
  // critical machine that has been down longer than the hospital's limit, so the flag shows.
  const weights = new Map(live.map((a, i) => [a.id, [7, 5, 3, 3, 2, 5, 5, 2, 1, 2][i % 10]]));
  const bag = live.flatMap((a) => Array(weights.get(a.id) ?? 1).fill(a));
  const total = 38;
  const raised = Array.from({ length: total }, () => new Date(today.getTime() - between(2, 360) * DAY + between(8, 18) * HOUR)).sort((x, y) => x.getTime() - y.getTime());
  const seqBefore = settings.complaintSeq;
  let expenseCount = 0;
  for (let k = 0; k < total; k++) {
    const open = k === total - 1;
    const a = open ? (live.find((x) => x.criticality === 'critical') ?? pick(bag)) : pick(bag);
    const type = a.equipmentType.code;
    const raisedAt = raised[k];
    const inProgress = k === total - 2;
    const critical = a.criticality === 'critical';
    const startedAt = open ? null : new Date(raisedAt.getTime() + between(0.2, 5) * HOUR);
    const downH = critical && rand() < 0.2 ? between(20, 40) : between(1, 14);
    const resolvedAt = open || inProgress ? null : new Date(raisedAt.getTime() + Math.max(downH, (startedAt!.getTime() - raisedAt.getTime()) / HOUR + 0.5) * HOUR);
    const raiser = a.departmentId === nursing.departmentId ? nursing : biomed;
    const row = await prisma.complaint.create({
      data: {
        complaintNo: complaintNo(seqBefore + k + 1),
        assetId: a.id,
        raisedById: raiser.id,
        departmentId: a.departmentId,
        description: pick(PROBLEMS[type] ?? ['Not working properly']),
        status: open ? 'open' : inProgress ? 'in_progress' : 'resolved',
        raisedAt: open ? new Date(Date.now() - 30 * HOUR) : inProgress ? new Date(Date.now() - 21 * HOUR) : raisedAt,
        startedAt: open ? null : inProgress ? new Date(Date.now() - 20 * HOUR) : startedAt,
        startedBy: open ? null : biomed.id,
        resolvedAt,
        resolvedBy: resolvedAt ? biomed.id : null,
        resolutionNotes: resolvedAt ? pick(FIXES) : null,
        createdBy: raiser.id,
      },
    });
    if (resolvedAt && rand() < 0.55) {
      const spare = rand() < 0.5;
      await prisma.serviceExpense.create({
        data: { assetId: a.id, complaintId: row.id, type: spare ? 'spare_part' : 'repair', description: spare ? pick(PARTS) : `Repair visit, ${pick(['fault tracing', 'board repair', 'recalibration'])}`, amount: Math.round(between(spare ? 900 : 1500, spare ? 24000 : 45000) / 50) * 50, date: parseDate(isoDate(resolvedAt)), vendor: pick(AGENCIES), createdBy: biomed.id },
      });
      expenseCount++;
    }
  }
  await prisma.hospitalSettings.update({ where: { id: settings.id }, data: { complaintSeq: seqBefore + total } });

  // Contracts: two running (one ending soon), one that has ended, and a quarterly service visit log.
  const contracts = [
    { asset: live[0], type: 'amc' as const, vendor: 'Drager Service', start: -10, end: 20, cost: 180000 },
    { asset: live[1], type: 'amc' as const, vendor: 'Drager Service', start: -9, end: 63, cost: 180000 },
    { asset: live[5], type: 'cmc' as const, vendor: 'Zoll Service Centre', start: -22, end: -40, cost: 240000 },
    { asset: live[4], type: 'amc' as const, vendor: 'Philips Care', start: -6, end: 190, cost: 90000 },
  ];
  for (const c of contracts) {
    if (!c.asset) continue;
    await prisma.serviceContract.create({
      data: { assetId: c.asset.id, type: c.type, vendor: c.vendor, startDate: addMonths(today, c.start), endDate: new Date(today.getTime() + c.end * DAY), cost: c.cost, createdBy: biomed.id },
    });
  }
  let logCount = 0;
  for (const a of [live[0], live[1]]) {
    for (let q = 1; q <= 3; q++) {
      if (!a) continue;
      await prisma.serviceLog.create({
        data: { assetId: a.id, serviceDate: parseDate(isoDate(new Date(today.getTime() - q * 88 * DAY))), kind: 'amc_visit', vendor: 'Drager Service', description: 'Quarterly AMC visit: filters changed, safety checks done', createdBy: biomed.id },
      });
      logCount++;
    }
  }
  console.log(`Demo history added: ${pmsCount} PMS records, ${calCount} calibrations, ${total} complaints, ${expenseCount} expenses, ${contracts.length} contracts, ${logCount} service entries.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
