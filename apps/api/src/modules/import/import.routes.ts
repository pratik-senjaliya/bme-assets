import { Router } from 'express';
import ExcelJS from 'exceljs';
import multer from 'multer';
import { z } from 'zod';
import { CRITICALITIES, isoDateSchema, type ImportError, type ImportResult } from '@bme/shared';
import { audit } from '../../lib/audit';
import { requirePermission } from '../../lib/auth';
import { isoDate } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { CREATE_TX_OPTIONS, assertOpeningDate, createAssets, type NewAsset } from '../assets/assets.service';

export const importRouter = Router();
importRouter.use(requirePermission('asset.create'));

const MAX_ROWS = 1000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

type ColumnKey =
  | 'equipmentTypeCode' | 'name' | 'make' | 'model' | 'serialNo' | 'departmentCode' | 'locationCode'
  | 'criticality' | 'installationDate' | 'warrantyMonths' | 'pmsFrequencyMonths' | 'openingPmsOn' | 'openingCalibrationOn';

// Template columns: header text → key. Headers are matched case-insensitively, so users can reorder columns.
const COLUMNS: { key: ColumnKey; header: string; required?: boolean; width: number }[] = [
  { key: 'equipmentTypeCode', header: 'Equipment type code', required: true, width: 20 },
  { key: 'name', header: 'Name', required: true, width: 28 },
  { key: 'make', header: 'Make', width: 18 },
  { key: 'model', header: 'Model', width: 18 },
  { key: 'serialNo', header: 'Serial no', width: 20 },
  { key: 'departmentCode', header: 'Department code', required: true, width: 18 },
  { key: 'locationCode', header: 'Location code', required: true, width: 16 },
  { key: 'criticality', header: 'Criticality', width: 14 },
  { key: 'installationDate', header: 'Installation date', width: 18 },
  { key: 'warrantyMonths', header: 'Warranty months', width: 16 },
  { key: 'pmsFrequencyMonths', header: 'PMS frequency months', width: 20 },
  { key: 'openingPmsOn', header: 'Last PMS done', width: 18 },
  { key: 'openingCalibrationOn', header: 'Last calibration done', width: 22 },
];
const headerOf = Object.fromEntries(COLUMNS.map((c) => [c.key, c.header])) as Record<ColumnKey, string>;

// ---------- Template ----------

importRouter.get('/template', async (_req, res) => {
  const [types, departments, locations] = await Promise.all([
    prisma.equipmentType.findMany({ orderBy: { code: 'asc' } }),
    prisma.department.findMany({ orderBy: { code: 'asc' } }),
    prisma.location.findMany({ include: { department: true }, orderBy: [{ departmentId: 'asc' }, { code: 'asc' }] }),
  ]);

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Assets', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  COLUMNS.forEach((c, i) => {
    if (c.required) sheet.getCell(1, i + 1).note = 'Required';
  });
  // For equipment that is already in use: when PMS / calibration was last done. The first due date runs from it.
  for (const key of ['openingPmsOn', 'openingCalibrationOn'] as const) {
    sheet.getCell(1, COLUMNS.findIndex((c) => c.key === key) + 1).note = 'Existing equipment only: the date it was last done before this system. Leave blank for new equipment.';
  }

  // Reference lists, used by the dropdowns and as a quick lookup for the person filling the sheet.
  const lists = wb.addWorksheet('Lists');
  lists.addRow(['Equipment type code', 'Equipment type', 'Department code', 'Department', 'Location code', 'Location', 'Location department', 'Criticality']);
  lists.getRow(1).font = { bold: true };
  const rows = Math.max(types.length, departments.length, locations.length, CRITICALITIES.length);
  for (let i = 0; i < rows; i++) {
    lists.addRow([
      types[i]?.code, types[i]?.name,
      departments[i]?.code, departments[i]?.name,
      locations[i]?.code, locations[i]?.name, locations[i]?.department.code,
      CRITICALITIES[i],
    ]);
  }
  lists.columns.forEach((c) => (c.width = 24));

  const dropdown = (key: ColumnKey, listCol: string, count: number) => {
    const col = COLUMNS.findIndex((c) => c.key === key) + 1;
    for (let r = 2; r <= MAX_ROWS + 1; r++) {
      sheet.getCell(r, col).dataValidation = { type: 'list', allowBlank: true, formulae: [`Lists!$${listCol}$2:$${listCol}$${Math.max(count, 1) + 1}`] };
    }
  };
  dropdown('equipmentTypeCode', 'A', types.length);
  dropdown('departmentCode', 'C', departments.length);
  dropdown('locationCode', 'E', locations.length);
  dropdown('criticality', 'H', CRITICALITIES.length);

  const buf = await wb.xlsx.writeBuffer();
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="asset-import-template.xlsx"',
  });
  res.send(Buffer.from(buf));
});

// ---------- Import ----------

type Cell = ExcelJS.CellValue;
function cellText(v: Cell): string {
  if (v == null) return '';
  if (v instanceof Date) return isoDate(v);
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('').trim();
    if ('result' in v) return cellText(v.result as Cell);
    if ('text' in v) return String(v.text).trim();
    return '';
  }
  return String(v).trim();
}

// Accepts 2026-10-07 and the Indian 07/10/2026 or 07-10-2026.
function normalizeDate(s: string): string {
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
}

const blank = (v: unknown) => (v === '' ? undefined : v);
const number = (max: number, min = 0) => z.preprocess(blank, z.coerce.number({ invalid_type_error: 'Must be a number' }).int('Whole number only').min(min).max(max).optional());
const text = (max: number) => z.preprocess(blank, z.string().max(max).optional());

const rowSchema = z.object({
  equipmentTypeCode: z.string().min(1, 'Required').transform((s) => s.toUpperCase()),
  name: z.string().min(1, 'Required').max(150),
  make: text(100),
  model: text(100),
  serialNo: text(100),
  departmentCode: z.string().min(1, 'Required').transform((s) => s.toUpperCase()),
  locationCode: z.string().min(1, 'Required').transform((s) => s.toUpperCase()),
  criticality: z.preprocess((v) => (typeof v === 'string' ? blank(v.toLowerCase()) : v), z.enum(CRITICALITIES).optional()),
  installationDate: z.preprocess((v) => (typeof v === 'string' ? blank(normalizeDate(v)) : v), isoDateSchema.optional()),
  warrantyMonths: number(240),
  pmsFrequencyMonths: number(120, 1),
  openingPmsOn: z.preprocess((v) => (typeof v === 'string' ? blank(normalizeDate(v)) : v), isoDateSchema.optional()),
  openingCalibrationOn: z.preprocess((v) => (typeof v === 'string' ? blank(normalizeDate(v)) : v), isoDateSchema.optional()),
});

importRouter.post('/assets', upload.single('file'), async (req, res) => {
  const dryRun = req.query.dryRun === 'true';
  if (!req.file) throw new HttpError(400, 'Choose an Excel (.xlsx) file');
  if (req.file.buffer.subarray(0, 2).toString('latin1') !== 'PK') throw new HttpError(415, 'That is not an .xlsx file');

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
  } catch {
    throw new HttpError(400, 'Could not read that file. Use the template and save it as .xlsx');
  }
  const sheet = wb.getWorksheet('Assets') ?? wb.worksheets[0];
  if (!sheet) throw new HttpError(400, 'The file has no sheets');

  // Map header text to column numbers.
  const col = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, n) => col.set(cellText(cell.value).toLowerCase(), n));
  const missing = COLUMNS.filter((c) => c.required && !col.has(c.header.toLowerCase())).map((c) => c.header);
  if (missing.length) throw new HttpError(400, `Missing columns: ${missing.join(', ')}. Download the template again.`);

  const rawRows: { row: number; values: Record<string, string> }[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const values = Object.fromEntries(
      COLUMNS.map((c) => [c.key, col.has(c.header.toLowerCase()) ? cellText(sheet.getCell(r, col.get(c.header.toLowerCase())!).value) : '']),
    );
    if (Object.values(values).some((v) => v !== '')) rawRows.push({ row: r, values });
  }
  if (rawRows.length === 0) throw new HttpError(400, 'The file has no data rows');
  if (rawRows.length > MAX_ROWS) throw new HttpError(400, `Too many rows (${rawRows.length}). Import up to ${MAX_ROWS} at a time.`);

  const [types, departments, locations] = await Promise.all([
    prisma.equipmentType.findMany(),
    prisma.department.findMany(),
    prisma.location.findMany(),
  ]);
  const typeByCode = new Map(types.map((t) => [t.code, t]));
  const deptByCode = new Map(departments.map((d) => [d.code, d]));
  const locationOf = (departmentId: string, code: string) => locations.find((l) => l.departmentId === departmentId && l.code === code);

  const errors: ImportError[] = [];
  const valid: NewAsset[] = [];
  const serialRows = new Map<string, number>();

  for (const { row, values } of rawRows) {
    const parsed = rowSchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({ row, field: headerOf[issue.path[0] as ColumnKey], message: issue.message });
      }
      continue;
    }
    const v = parsed.data;
    const type = typeByCode.get(v.equipmentTypeCode);
    const dept = deptByCode.get(v.departmentCode);
    const loc = dept && locationOf(dept.id, v.locationCode);
    if (!type) errors.push({ row, field: headerOf.equipmentTypeCode, message: `Unknown equipment type "${v.equipmentTypeCode}"` });
    if (!dept) errors.push({ row, field: headerOf.departmentCode, message: `Unknown department "${v.departmentCode}"` });
    else if (!loc) errors.push({ row, field: headerOf.locationCode, message: `No location "${v.locationCode}" in department ${dept.code}` });
    if (v.serialNo) {
      const first = serialRows.get(v.serialNo);
      if (first) errors.push({ row, field: headerOf.serialNo, message: `Serial number repeated from row ${first}` });
      else serialRows.set(v.serialNo, row);
    }
    for (const key of ['openingPmsOn', 'openingCalibrationOn'] as const) {
      try {
        assertOpeningDate(key, v[key], v.installationDate);
      } catch (e) {
        errors.push({ row, field: headerOf[key], message: e instanceof Error ? e.message : 'Invalid date' });
      }
    }
    if (type && dept && loc) {
      valid.push({
        equipmentTypeId: type.id,
        name: v.name,
        make: v.make,
        model: v.model,
        serialNo: v.serialNo,
        departmentId: dept.id,
        locationId: loc.id,
        criticality: v.criticality,
        installationDate: v.installationDate,
        warrantyMonths: v.warrantyMonths,
        pmsFrequencyMonths: v.pmsFrequencyMonths,
        openingPmsOn: v.openingPmsOn,
        openingCalibrationOn: v.openingCalibrationOn,
      });
    }
  }

  const existing = await prisma.asset.findMany({ where: { serialNo: { in: [...serialRows.keys()] } }, select: { serialNo: true, assetCode: true } });
  for (const e of existing) {
    errors.push({ row: serialRows.get(e.serialNo!)!, field: headerOf.serialNo, message: `Serial number already used by ${e.assetCode}` });
  }

  // All-or-nothing: one bad row means nothing is inserted and every bad row is reported.
  errors.sort((a, b) => a.row - b.row);
  const result: ImportResult = { ok: errors.length === 0, dryRun, total: rawRows.length, created: 0, errors };
  if (errors.length > 0) {
    res.status(422).json(result);
    return;
  }
  if (!dryRun) {
    await prisma.$transaction(async (tx) => {
      const created = await createAssets(tx, req, valid);
      await audit(tx, req, { action: 'asset.import', entityType: 'asset', after: { file: req.file!.originalname, count: created.length } });
      result.created = created.length;
    }, CREATE_TX_OPTIONS);
  }
  res.json(result);
});
