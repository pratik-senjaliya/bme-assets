import { readFileSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { ChartSpec, Kpi, ReportColumn, ReportData, ReportSheetData, ValueFmt } from '@bme/shared';
import { config } from '../../lib/config';
import { parseDate, wallClock } from '../../lib/dates';

// Excel and PDF are made from the same ReportData the screen shows, so the numbers never disagree. The layout is
// their own: the PDF is a document to print, sign and file (letterhead, report details, key figures, summary tables,
// the registers, signatures); the Excel file is one to work in (an overview first, real dates and numbers, filters,
// totals that follow the filter, set up to print).

const DEPARTMENT = 'Biomedical Engineering Department';

const prettyDay = (iso: string) => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(parseDate(iso));
const stamp = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone })
    .format(new Date(iso))
    .replace(/(\d{4}) /, '$1, ');
const isInstant = (v: string) => /^\d{4}-\d{2}-\d{2}T/.test(v);

const period = (d: ReportData) => (d.from && d.to ? `${prettyDay(d.from)} to ${prettyDay(d.to)}` : `As at ${prettyDay(d.generatedAt.slice(0, 10))}`);
const covers = (d: ReportData) => (d.filters?.length ? d.filters.join(' · ') : 'Whole hospital');
// Charts become small tables in both files, except where a table of the report already has the same numbers.
const summaries = (d: ReportData) => d.charts.filter((c) => c.print !== false && c.data.length > 0);
const chartColumns = (c: ChartSpec): ReportColumn[] => [
  { header: '', key: 'label' },
  ...c.series.map((s) => ({ header: s.label, key: s.key, fmt: c.fmt })),
  ...(c.series.length > 1 ? [{ header: 'Total', key: '__total', fmt: c.fmt }] : []),
];
const chartRows = (c: ChartSpec) =>
  c.data.map((r): Record<string, string | number | null> => ({ ...r, ...(c.series.length > 1 && { __total: c.series.reduce((t, s) => t + (Number(r[s.key]) || 0), 0) }) }));
const totalsRow = (s: ReportSheetData, first: string) =>
  ({ [first]: 'Total', ...Object.fromEntries((s.totals ?? []).map((k) => [k, s.rows.reduce((t, r) => t + (Number(r[k]) || 0), 0)])) }) as Record<string, string | number | null>;

// ---------- Excel ----------

// Indian grouping (12,34,567.00) for rupees and counts; Excel has no built-in format for it.
const INDIAN = (decimals: string) => `[>=10000000]##\\,##\\,##\\,##0${decimals};[>=100000]##\\,##\\,##0${decimals};#,##0${decimals}`;
const NUM_FMT: Partial<Record<ValueFmt, string>> = {
  date: 'dd mmm yyyy',
  datetime: 'dd mmm yyyy hh:mm',
  money: `[>=10000000]"₹ "##\\,##\\,##\\,##0.00;[>=100000]"₹ "##\\,##\\,##0.00;"₹ "#,##0.00`,
  hours: '#,##0.0',
  pct: '0.0%',
  int: INDIAN(''),
  years: '0.0',
};
const HEADER_ROW = 4; // title, details, blank, then the table
const GREY = { argb: 'FF5B6472' };
const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF0' } };
const thin = { style: 'thin' as const, color: { argb: 'FFB8C2C8' } };

// Sheet names: at most 31 characters, none of []:*?/\ and each one different.
function sheetName(wb: ExcelJS.Workbook, name: string) {
  const base = name.replace(/[[\]:*?/\\]/g, '-').slice(0, 31);
  let out = base;
  for (let i = 2; wb.getWorksheet(out); i++) out = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
  return out;
}

// A cell value Excel can sort and add up: real dates (hospital clock time), numbers as numbers.
function excelValue(v: unknown, fmt: ValueFmt | undefined): ExcelJS.CellValue {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && fmt === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return parseDate(v);
  if (typeof v === 'string' && fmt === 'datetime' && isInstant(v)) return wallClock(new Date(v));
  return v as ExcelJS.CellValue;
}
// A plain text column may still hold a date (an asset's summary: "Installed 2023-05-10"); it reads as one, as on screen.
const isPlainDate = (v: unknown, fmt: ValueFmt | undefined) => (!fmt || fmt === 'text') && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
function excelCell(v: unknown, fmt: ValueFmt | undefined): ExcelJS.CellValue {
  return isPlainDate(v, fmt) ? parseDate(v as string) : excelValue(v, fmt);
}

// Escapes text for a print header or footer, where & starts a code.
const hf = (s: string) => s.replace(/&/g, '&&');

function printSetup(ws: ExcelJS.Worksheet, data: ReportData, landscape: boolean, titleRows?: string) {
  ws.pageSetup = {
    ...ws.pageSetup,
    paperSize: 9, // A4
    orientation: landscape ? 'landscape' : 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.7, bottom: 0.6, header: 0.3, footer: 0.3 },
    ...(titleRows && { printTitlesRow: titleRows }),
  };
  ws.headerFooter = {
    oddHeader: `&L&"-,Bold"${hf(data.hospital)}&R${hf(data.title)}`,
    oddFooter: `&L${hf(period(data))}&RPage &P of &N`,
  };
}

function widthOf(col: ReportColumn, rows: Record<string, unknown>[]) {
  if (col.fmt === 'date') return 13;
  if (col.fmt === 'datetime') return 18;
  const longestWord = Math.max(...col.header.split(/\s+/).map((w) => w.length));
  const longestValue = Math.max(0, ...rows.slice(0, 300).map((r) => String(r[col.key] ?? '').length));
  return Math.min(60, Math.max(10, longestWord + 2, Math.min(longestValue + 2, col.width ?? 60), col.fmt && col.fmt !== 'text' ? 12 : 0));
}

// One table of the report: a short title block, the header row (frozen, filterable, repeated on every printed page),
// the rows, and totals that add up whatever the filter leaves showing.
function addDataSheet(wb: ExcelJS.Workbook, data: ReportData, s: ReportSheetData): ExcelJS.Worksheet {
  const cols = s.columns;
  const ws = wb.addWorksheet(sheetName(wb, s.name), { views: [{ state: 'frozen', ySplit: HEADER_ROW, xSplit: cols.length > 6 ? 1 : 0 }] });
  ws.getCell('A1').value = s.name === data.title ? data.title : `${data.title}: ${s.name}`;
  ws.getCell('A1').font = { bold: true, size: 13 };
  ws.getCell('A2').value = `${data.hospital} · ${period(data)} · ${covers(data)}`;
  ws.getCell('A2').font = { size: 9, color: GREY };

  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = widthOf(c, s.rows);
    const f = c.fmt && NUM_FMT[c.fmt];
    if (f) col.numFmt = f;
  });
  const head = ws.getRow(HEADER_ROW);
  head.values = cols.map((c) => c.header);
  head.font = { bold: true };
  head.height = 30;
  head.eachCell((cell) => {
    cell.fill = HEAD_FILL;
    cell.border = { bottom: thin };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });

  const wrap = cols.map((c, i) => !c.fmt && (ws.getColumn(i + 1).width ?? 0) >= 40);
  s.rows.forEach((r, n) => {
    const row = ws.getRow(HEADER_ROW + 1 + n);
    row.values = cols.map((c) => excelCell(r[c.key], c.fmt));
    cols.forEach((c, i) => {
      if (wrap[i]) row.getCell(i + 1).alignment = { vertical: 'top', wrapText: true };
      if (isPlainDate(r[c.key], c.fmt)) row.getCell(i + 1).numFmt = NUM_FMT.date!;
    });
  });
  const first = HEADER_ROW + 1;
  const last = HEADER_ROW + s.rows.length;
  if (!s.rows.length) {
    ws.getCell(`A${first}`).value = 'No records in this period.';
    ws.getCell(`A${first}`).font = { italic: true, color: GREY };
  } else {
    ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: HEADER_ROW, column: cols.length } };
    if (s.totals?.length) {
      const sums = totalsRow(s, cols[0].key);
      const row = ws.getRow(last + 1);
      row.getCell(1).value = 'Total';
      cols.forEach((c, i) => {
        if (!s.totals!.includes(c.key)) return;
        const letter = ws.getColumn(i + 1).letter;
        row.getCell(i + 1).value = { formula: `SUBTOTAL(109,${letter}${first}:${letter}${last})`, result: sums[c.key] as number };
      });
      row.font = { bold: true };
      row.eachCell({ includeEmpty: true }, (cell, i) => {
        if (i <= cols.length) cell.border = { top: thin };
      });
    }
  }
  printSetup(ws, data, cols.length > 7, `${HEADER_ROW}:${HEADER_ROW}`);
  return ws;
}

// The first sheet: what the report is, its key figures, short summaries, and what the other sheets hold.
function addOverview(wb: ExcelJS.Workbook, data: ReportData, contents: { name: string; rows: number }[]): ExcelJS.Worksheet {
  const ws = wb.addWorksheet('Overview', { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 38 }, { width: 20 }, { width: 20 }, { width: 20 }, { width: 40 }];
  let r = 1;
  const put = (values: ExcelJS.CellValue[], style: Partial<ExcelJS.Row> = {}) => {
    const row = ws.getRow(r++);
    row.values = values;
    Object.assign(row, style);
    return row;
  };
  put([data.hospital], { font: { bold: true, size: 14 } });
  put([DEPARTMENT], { font: { size: 10, color: GREY } });
  r++;
  put([data.title], { font: { bold: true, size: 16 } });
  r++;
  const detail = (label: string, value: string) => {
    const row = put([label, value]);
    row.getCell(1).font = { color: GREY };
    row.getCell(1).alignment = { vertical: 'top' };
    ws.mergeCells(row.number, 2, row.number, 5);
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    if (value.length > 90) row.height = 15 * Math.ceil(value.length / 90);
  };
  detail('Period', period(data));
  detail('Covers', covers(data));
  detail('Generated', `${stamp(data.generatedAt)} by ${data.generatedBy}`);
  if (data.note) detail('Note', data.note);
  r++;

  const heading = (text: string) => put([text], { font: { bold: true, size: 12 } });
  const header = (values: string[]) => {
    const row = put(values, { font: { bold: true } });
    values.forEach((_, i) => {
      row.getCell(i + 1).fill = HEAD_FILL;
      row.getCell(i + 1).border = { bottom: thin };
    });
  };
  if (data.kpis.length) {
    heading('Key figures');
    header(['Measure', 'Value', 'Note']);
    data.kpis.forEach((k: Kpi) => {
      const row = put([k.label, typeof k.value === 'number' ? k.value : (k.value ?? '—'), k.hint ?? '']);
      const f = k.fmt === 'hours' ? '#,##0.0 "h"' : k.fmt === 'years' ? '0.0 "y"' : NUM_FMT[k.fmt];
      if (f && typeof k.value === 'number') row.getCell(2).numFmt = f;
      row.getCell(2).alignment = { horizontal: 'right' };
      row.getCell(3).alignment = { indent: 1 };
      if (k.tone === 'bad' || k.tone === 'warn') row.getCell(3).font = { color: { argb: k.tone === 'bad' ? 'FFB4321F' : 'FF8A4F05' } };
    });
    r++;
  }
  for (const c of summaries(data)) {
    heading(c.subtitle ? `${c.title} (${c.subtitle})` : c.title);
    const cols = chartColumns(c);
    header(cols.map((x) => x.header));
    for (const d of chartRows(c)) {
      const row = put(cols.map((x) => (x.key === 'label' ? d.label : excelValue(d[x.key], x.fmt))));
      cols.forEach((x, i) => {
        const f = x.fmt && NUM_FMT[x.fmt];
        if (f && i > 0) row.getCell(i + 1).numFmt = f;
      });
    }
    r++;
  }
  if (contents.length) {
    heading('In this file');
    header(['Sheet', 'Rows']);
    for (const { name, rows } of contents) {
      const row = put([{ text: name, hyperlink: `#'${name.replace(/'/g, "''")}'!A1` }, rows]);
      row.getCell(1).font = { color: { argb: 'FF0E5C58' }, underline: true };
    }
  }
  printSetup(ws, data, false);
  return ws;
}

export function toWorkbook(data: ReportData): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = data.generatedBy;
  wb.created = new Date(data.generatedAt);
  wb.title = `${data.title} · ${data.hospital}`;
  const contents = data.sheets.map((sh) => ({ name: addDataSheet(wb, data, sh).name, rows: sh.rows.length }));
  // The overview lists the sheets by their final names, so it is made last and then put first.
  (addOverview(wb, data, contents) as ExcelJS.Worksheet & { orderNo: number }).orderNo = 0; // not in ExcelJS's types, but it orders the tabs
  return wb;
}

// ---------- PDF ----------

const INK = '#16212B';
const MUTED = '#5B6472';
const LINE = '#CBD3D9';
const HEAD_BG = '#E8EEF0';
const ZEBRA = '#F6F8F9';
const ACCENT = '#0E5C58';
const TONE = { bad: '#B4321F', warn: '#8A4F05', good: '#0E6B4F', neutral: MUTED } as const;

// Noto Sans (SIL Open Font License, assets/fonts) is embedded so ₹ prints; the PDF's built-in fonts have no rupee sign.
// Read once; the same path works from src (tsx) and dist (node). Gujarati and Hindi need their own Noto fonts.
const FONT_DIR = path.join(__dirname, '../../../assets/fonts');
const FONTS = { regular: readFileSync(path.join(FONT_DIR, 'NotoSans-Regular.ttf')), bold: readFileSync(path.join(FONT_DIR, 'NotoSans-Bold.ttf')) };
const num = (n: number, digits = 0) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
export function formatValue(v: unknown, fmt: ValueFmt | undefined, unit = false): string {
  if (v == null || v === '') return '-';
  if (typeof v === 'string') {
    if ((fmt === 'date' || !fmt || fmt === 'text') && /^\d{4}-\d{2}-\d{2}$/.test(v)) return prettyDay(v);
    if (fmt === 'datetime' && isInstant(v)) return stamp(v);
    return v; // the totals row says "Total" even in a date column
  }
  if (typeof v !== 'number') return String(v);
  switch (fmt) {
    case 'money':
      return `₹ ${num(v, 0)}`;
    case 'pct':
      return `${num(v * 100, 1)}%`;
    case 'hours':
      return unit ? `${num(v, 1)} h` : num(v, 1);
    case 'years':
      return unit ? `${num(v, 1)} y` : num(v, 1);
    default:
      return num(v, Number.isInteger(v) ? 0 : 1);
  }
}
const numeric = (c: ReportColumn) => !!c.fmt && c.fmt !== 'date' && c.fmt !== 'datetime' && c.fmt !== 'text';

export function toPdf(data: ReportData): Promise<Buffer> {
  // Wide registers print across the page; the rest read better upright.
  const landscape = data.sheets.some((s) => s.columns.filter((c) => c.pdf !== false).length > 7);
  const W = landscape ? 841.89 : 595.28;
  const H = landscape ? 595.28 : 841.89;
  const M = 34;
  const USABLE = W - M * 2;
  const TOP = M + 44; // below the letterhead
  const BOTTOM = H - M - 22; // above the footer

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: M, bufferPages: true, info: { Title: `${data.title} · ${data.hospital}`, Author: data.generatedBy } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Our own cursor: PDFKit moves its own whenever text is drawn.
    let y = TOP;
    const newPage = () => {
      doc.addPage();
      y = TOP;
    };
    const need = (h: number) => {
      if (y + h > BOTTOM) newPage();
    };
    doc.registerFont('Body', FONTS.regular);
    doc.registerFont('Body-Bold', FONTS.bold);
    const font = (size: number, bold = false) => doc.font(bold ? 'Body-Bold' : 'Body').fontSize(size);
    const lineH = (size: number, bold = false) => font(size, bold).currentLineHeight(false);
    type TextOpts = { w?: number; size?: number; bold?: boolean; color?: string; align?: 'left' | 'right' | 'center'; lines?: number };
    // Text that wraps within `w`, cut with an ellipsis after `lines` lines (one line unless asked).
    const text = (s: string, x: number, at: number, o: TextOpts = {}) => {
      const size = o.size ?? 8;
      font(size, o.bold).fillColor(o.color ?? INK).text(s, x, at, { width: o.w, height: (o.lines ?? 1) * lineH(size, o.bold) + 1, align: o.align, ellipsis: true, lineGap: 0 });
    };
    const heightOf = (s: string, w: number, size: number, bold = false, lines = 6) =>
      Math.min(font(size, bold).heightOfString(s || ' ', { width: w, lineGap: 0 }), lines * lineH(size, bold) + 1);
    const rule = (at: number, color = LINE, width = 0.5) => doc.moveTo(M, at).lineTo(M + USABLE, at).lineWidth(width).strokeColor(color).stroke();

    // ---- Report details: what, when, for whom ----
    const details: [string, string][] = [['Period', period(data)], ['Covers', covers(data)], ['Generated', stamp(data.generatedAt)], ['By', data.generatedBy]];
    const dw = USABLE / details.length;
    doc.rect(M, y, USABLE, 34).lineWidth(0.6).strokeColor(LINE).stroke();
    details.forEach(([label, value], i) => {
      const x = M + i * dw;
      if (i) doc.moveTo(x, y).lineTo(x, y + 34).lineWidth(0.6).strokeColor(LINE).stroke();
      text(label.toUpperCase(), x + 8, y + 6, { w: dw - 16, size: 6.5, color: MUTED });
      text(value, x + 8, y + 16, { w: dw - 16, size: 9, bold: true });
    });
    y += 46;

    // ---- Key figures: a ruled grid, label over value, the note under it ----
    if (data.kpis.length) {
      const perRow = Math.min(data.kpis.length, landscape ? 6 : 4);
      const cw = USABLE / perRow;
      const ch = 48;
      text('Key figures', M, y, { size: 10.5, bold: true, color: ACCENT });
      y += 16;
      for (let i = 0; i < data.kpis.length; i += perRow) {
        need(ch);
        data.kpis.slice(i, i + perRow).forEach((k, j) => {
          const x = M + j * cw;
          doc.rect(x, y, cw, ch).lineWidth(0.6).strokeColor(LINE).stroke();
          text(k.label, x + 7, y + 6, { w: cw - 14, size: 7, color: MUTED });
          text(formatValue(k.value, k.fmt, true), x + 7, y + 16, { w: cw - 14, size: 13, bold: true });
          if (k.hint) text(k.hint, x + 7, y + 35, { w: cw - 14, size: 6.5, color: TONE[k.tone ?? 'neutral'] });
        });
        y += ch;
      }
      y += 16;
    }

    // ---- A table: wrapped cells, header repeated on every page, zebra rows, totals ----
    const table = (title: string, cols: ReportColumn[], rows: Record<string, unknown>[], o: { x?: number; w?: number; size?: number; totals?: Record<string, unknown> | null; caption?: string } = {}) => {
      const x0 = o.x ?? M;
      const width = o.w ?? USABLE;
      const size = o.size ?? (cols.length > 11 ? 6.5 : cols.length > 8 ? 7 : 7.5);
      const pad = 3;
      // Widths from the content: dates and numbers keep their full width, long text gives way and wraps.
      const natural = cols.map((c) => {
        const head = Math.max(...c.header.split(/\s+/).map((wd) => font(size, true).widthOfString(wd)));
        const cells = rows.slice(0, 80).map((r) => font(size).widthOfString(formatValue(r[c.key], c.fmt)));
        return Math.min(numeric(c) || c.fmt === 'date' || c.fmt === 'datetime' ? 140 : 210, Math.max(head, ...cells, 16)) + pad * 2;
      });
      // A column never gets narrower than its longest word, so codes and IDs stay on one line.
      const longestWord = cols.map((c, i) =>
        Math.min(natural[i], Math.max(...rows.slice(0, 80).flatMap((r) => formatValue(r[c.key], c.fmt).split(/\s+/).map((wd) => font(size).widthOfString(wd))), 0) + pad * 2),
      );
      const widths = (() => {
        const total = natural.reduce((t, w) => t + w, 0);
        // A short table keeps a natural width instead of stretching across the page.
        if (total <= width) return natural.map((w) => (w / total) * (o.w ? width : Math.min(width, Math.max(total * 1.5, width * 0.5))));
        const w = [...natural];
        const fixed = cols.map((c) => numeric(c) || c.fmt === 'date' || c.fmt === 'datetime');
        const over = total - width;
        const give = w.map((x, i) => (fixed[i] ? 0 : Math.max(0, x - Math.max(60, longestWord[i]))));
        const room = give.reduce((t, g) => t + g, 0);
        if (room >= over) return w.map((x, i) => x - (give[i] / room) * over);
        return w.map((x) => (x / total) * width);
      })();
      const tableW = widths.reduce((t, x) => t + x, 0);
      const align = (c: ReportColumn) => (numeric(c) ? 'right' : 'left');
      const headH = Math.max(...cols.map((c, i) => heightOf(c.header, widths[i] - pad * 2, size, true, 3))) + pad * 2;
      const head = (continued: boolean) => {
        if (continued) {
          text(`${title} (continued)`, x0, y, { w: tableW, size: 7.5, color: MUTED });
          y += 12;
        }
        doc.rect(x0, y, tableW, headH).fill(HEAD_BG);
        let x = x0;
        cols.forEach((c, i) => {
          text(c.header, x + pad, y + pad, { w: widths[i] - pad * 2, size, bold: true, color: INK, align: align(c), lines: 3 });
          x += widths[i];
        });
        y += headH;
      };
      const heightOfRow = (cells: string[], bold: boolean) => Math.max(size + 2, ...cells.map((s, i) => heightOf(s, widths[i] - pad * 2, size, bold))) + pad * 2;
      // `keep`: room to leave below this row on the same page (the totals row stays with the last row).
      const line = (r: Record<string, unknown>, n: number, bold = false, keep = 0) => {
        const cells = cols.map((c) => formatValue(r[c.key], c.fmt));
        const h = heightOfRow(cells, bold);
        if (y + h + keep > BOTTOM) {
          newPage();
          head(true);
        }
        if (bold) doc.moveTo(x0, y).lineTo(x0 + tableW, y).lineWidth(0.8).strokeColor(INK).stroke();
        else if (n % 2 === 1) doc.rect(x0, y, tableW, h).fill(ZEBRA);
        let x = x0;
        cells.forEach((s, i) => {
          text(s, x + pad, y + pad, { w: widths[i] - pad * 2, size, bold, align: align(cols[i]), lines: 6 });
          x += widths[i];
        });
        y += h;
      };
      head(false);
      if (!rows.length) {
        text('No records in this period.', x0 + pad, y + 5, { w: width, size, color: MUTED });
        y += size + 12;
      }
      const totalsH = o.totals ? heightOfRow(cols.map((c) => formatValue(o.totals![c.key], c.fmt)), true) : 0;
      rows.forEach((r, n) => line(r, n, false, n === rows.length - 1 ? totalsH : 0));
      if (o.totals) line(o.totals, 0, true);
      doc.moveTo(x0, y).lineTo(x0 + tableW, y).lineWidth(0.6).strokeColor(LINE).stroke();
      if (o.caption) {
        text(o.caption, x0, y + 3, { w: width, size: 6.5, color: MUTED });
        y += 10;
      }
    };

    // ---- Summaries: the charts as small tables, side by side ----
    const minis = summaries(data);
    if (minis.length) {
      need(60);
      text('Summary', M, y, { size: 10.5, bold: true, color: ACCENT });
      y += 16;
      const perRow = landscape ? 3 : 2;
      const gap = 16;
      const mw = (USABLE - gap * (perRow - 1)) / perRow;
      for (let i = 0; i < minis.length; i += perRow) {
        const group = minis.slice(i, i + perRow).map((c) => {
          // A long time series prints its latest 24 periods; a ranking its top 12. The Excel file has every one.
          const all = chartRows(c);
          const series = c.kind !== 'bar';
          const rows = series ? all.slice(-24) : all.slice(0, 12);
          const caption = series && all.length > rows.length ? `Last ${rows.length} of ${all.length} shown; the Excel file has all` : c.subtitle;
          return { c, rows, caption };
        });
        const tallest = Math.max(...group.map((g) => 30 + (g.rows.length + 1) * 13 + (g.caption ? 10 : 0)));
        need(tallest);
        const top = y;
        let bottom = y;
        group.forEach((g, j) => {
          y = top;
          const x = M + j * (mw + gap);
          text(g.c.title, x, y, { w: mw, size: 8.5, bold: true });
          y += 14;
          table(g.c.title, chartColumns(g.c), g.rows, { x, w: mw, size: 7.5, caption: g.caption });
          bottom = Math.max(bottom, y);
        });
        y = bottom + 16;
      }
    }

    // ---- The report's tables, numbered ----
    data.sheets.forEach((s, i) => {
      const cols = s.columns.filter((c) => c.pdf !== false);
      const title = `${i + 1}. ${s.name}`;
      const th = heightOf(title, USABLE - 70, 10.5, true, 3);
      need(th + 60);
      text(title, M, y, { size: 10.5, bold: true, color: ACCENT, w: USABLE - 70, lines: 3 });
      text(`${s.rows.length} ${s.rows.length === 1 ? 'row' : 'rows'}`, M, y + 2, { w: USABLE, size: 7.5, color: MUTED, align: 'right' });
      y += th + 5;
      table(s.name, cols, s.rows, { totals: s.totals?.length && s.rows.length ? totalsRow(s, cols[0].key) : null });
      y += 18;
    });

    // ---- Notes and signatures ----
    if (data.note) {
      const h = heightOf(data.note, USABLE, 7.5, false, 10);
      need(h + 18);
      text('Notes', M, y, { size: 8, bold: true });
      text(data.note, M, y + 11, { w: USABLE, size: 7.5, color: MUTED, lines: 10 });
      y += h + 22;
    }
    need(64);
    y += 6;
    const signers = ['Prepared by', 'Checked by', 'HOD, Biomedical Engineering'];
    const sw = (USABLE - 24 * 2) / 3;
    signers.forEach((who, i) => {
      const x = M + i * (sw + 24);
      doc.moveTo(x, y + 26).lineTo(x + sw, y + 26).lineWidth(0.6).strokeColor(INK).stroke();
      text(who, x, y + 30, { w: sw, size: 7.5, bold: true });
      text('Name, signature and date', x, y + 41, { w: sw, size: 6.5, color: MUTED });
    });

    // ---- Letterhead and footer on every page, written last so the page count is known ----
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.page.margins.bottom = 0; // otherwise writing in the margin starts a new page
      text(data.hospital, M, M, { w: USABLE * 0.55, size: 12, bold: true });
      text(DEPARTMENT, M, M + 16, { w: USABLE * 0.55, size: 8, color: MUTED });
      text(data.title, M + USABLE * 0.4, M, { w: USABLE * 0.6, size: 12, bold: true, align: 'right', color: ACCENT });
      text(period(data), M + USABLE * 0.4, M + 16, { w: USABLE * 0.6, size: 8, color: MUTED, align: 'right' });
      rule(M + 31, ACCENT, 1.2);
      rule(H - M - 12);
      text(`Generated ${stamp(data.generatedAt)} by ${data.generatedBy} · BME Asset Management`, M, H - M - 6, { w: USABLE * 0.75, size: 6.5, color: MUTED });
      text(`Page ${i + 1} of ${range.count}`, M, H - M - 6, { w: USABLE, size: 6.5, color: MUTED, align: 'right' });
    }
    doc.end();
  });
}
