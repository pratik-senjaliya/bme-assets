// QR labels: a scanned label finds its record only within the person's department scope, and the label sheet lists
// exactly the requested or filtered equipment, for the people who look after it. Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AssetLabelsResponse } from '@bme/shared';
import { prisma } from './lib/prisma';
import { call, login, startServer } from './testUtils';

const PREFIX = 'QTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let nurse = '';
const made = { icu: { id: '', assetCode: '' }, bme: { id: '', assetCode: '' } };

async function cleanUp() {
  const assets = await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  await prisma.asset.deleteMany({ where: { id: { in: assets.map((a) => a.id) } } });
}

before(async () => {
  await cleanUp();
  ({ server, base } = startServer());
  [admin, nurse] = await Promise.all([login(base, 'admin@demo.local'), login(base, 'nursing@demo.local')]);
  const type = await prisma.equipmentType.findFirstOrThrow({ where: { code: 'VENT' } });
  const make = async (dept: string, loc: string, name: string) => {
    const [d, l] = await Promise.all([prisma.department.findUniqueOrThrow({ where: { code: dept } }), prisma.location.findFirstOrThrow({ where: { code: loc } })]);
    const res = await call(base, admin, 'POST', '/assets', { equipmentTypeId: type.id, name: `${PREFIX}${name}`, departmentId: d.id, locationId: l.id });
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json()) as { id: string; assetCode: string };
  };
  made.icu = await make('ICU', 'ICU1', 'icu');
  made.bme = await make('BME', 'WKSP', 'workshop');
});
after(async () => {
  await cleanUp();
  server.close();
  await prisma.$disconnect();
});

describe('Scanning a QR label', () => {
  it('finds the record by the asset ID printed on the label', async () => {
    const res = await call(base, admin, 'GET', `/assets/by-code/${encodeURIComponent(made.icu.assetCode)}`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { id: string }).id, made.icu.id);
  });

  it('keeps nursing staff to their own department: another department’s label is not found', async () => {
    assert.equal((await call(base, nurse, 'GET', `/assets/by-code/${encodeURIComponent(made.icu.assetCode)}`)).status, 200);
    assert.equal((await call(base, nurse, 'GET', `/assets/by-code/${encodeURIComponent(made.bme.assetCode)}`)).status, 404);
  });

  it('says not found for a label that matches nothing, and needs a sign-in', async () => {
    assert.equal((await call(base, admin, 'GET', '/assets/by-code/NOPE-0000')).status, 404);
    assert.equal((await fetch(`${base}/api/v1/assets/by-code/${encodeURIComponent(made.icu.assetCode)}`)).status, 401);
  });
});

describe('Printing a sheet of labels', () => {
  it('lists exactly the requested equipment, with the hospital name', async () => {
    const res = await call(base, admin, 'GET', `/assets/labels?ids=${made.icu.id},${made.bme.id}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as AssetLabelsResponse;
    assert.deepEqual(body.items.map((i) => i.id).sort(), [made.icu.id, made.bme.id].sort());
    assert.equal(body.total, 2);
    const settings = await prisma.hospitalSettings.findFirstOrThrow();
    assert.equal(body.hospitalName, settings.name);
    const icu = body.items.find((i) => i.id === made.icu.id)!;
    assert.equal(icu.assetCode, made.icu.assetCode);
    assert.equal(icu.locationName, 'ICU 1');
  });

  it('follows the register’s filters when no ids are given', async () => {
    const body = (await (await call(base, admin, 'GET', `/assets/labels?search=${PREFIX}`)).json()) as AssetLabelsResponse;
    assert.deepEqual(body.items.map((i) => i.assetCode), [made.bme.assetCode, made.icu.assetCode].sort());
  });

  it('is for the people who look after equipment: nursing staff cannot print labels', async () => {
    assert.equal((await call(base, nurse, 'GET', `/assets/labels?ids=${made.icu.id}`)).status, 403);
  });

  it('refuses ids that are not asset ids', async () => {
    assert.equal((await call(base, admin, 'GET', '/assets/labels?ids=not-an-id')).status, 400);
  });
});
