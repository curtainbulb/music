import { tableToAlbums } from './formats.js';

/**
 * .xlsx import via SheetJS (the "xlsx" / "Community Edition" library), the one vendored dependency this
 * app adds beyond the browser platform. Chosen because it is the de-facto standard for reading Excel
 * files in the browser with no server round-trip, ships an ESM build so it can be dynamically imported
 * like the rest of this codebase, and has no transitive dependencies of its own.
 *
 * UNTESTED: this module is written against SheetJS's documented API from memory; there is no network
 * access in this sandbox to fetch the library or run it. Before .xlsx import will work you must:
 *   1. Download the pinned release and vendor it at vendor/xlsx-0.20.3.mjs:
 *        https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs
 *      (adjust the version in that URL and in VENDOR_URL below if 0.20.3 is no longer current; always
 *      pin an exact version, never a floating "latest" tag).
 *   2. Compute its SRI hash once it's on disk and add it to the <script>/import you serve it from if your
 *      deployment supports import maps with integrity, e.g.:
 *        openssl dgst -sha384 -binary vendor/xlsx-0.20.3.mjs | openssl base64 -A
 *   3. Confirm VENDOR_URL below matches where you placed the file.
 * Until then, parseXlsxFile() rejects with a clear "vendor file missing" error instead of silently
 * failing or fabricating results — the import dialog surfaces that message to the user.
 *
 * Replaceability: this wrapper is ~30 lines. If you'd rather not vendor a ~1MB library for one format,
 * delete this file, the VENDOR_URL constant usage in js/ui/extras.js, and the ".xlsx"/".xls" entries in
 * the import file picker's accept list; every other format keeps working unchanged.
 */
export const VENDOR_URL = '../../vendor/xlsx-0.20.3.mjs';
export const VENDOR_VERSION = '0.20.3';

let xlsxMod = null;
async function loadLib() {
  if (xlsxMod) return xlsxMod;
  try {
    xlsxMod = await import(/* webpackIgnore: true */ VENDOR_URL);
  } catch (e) {
    throw new Error(`.xlsx support needs the vendored SheetJS build at vendor/xlsx-${VENDOR_VERSION}.mjs (not present). See js/parser/xlsx.js for the exact URL to fetch and vendor it, then reload.`);
  }
  return xlsxMod;
}

/**
 * Reads the first non-empty sheet of an .xlsx/.xls File/Blob and returns the same shape as
 * parseTable()/importText(): {format:'xlsx', albums, skipped, headers, mapping}.
 */
export async function parseXlsxFile(file, { mapping } = {}) {
  const XLSX = await loadLib();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheetName = wb.SheetNames.find((n) => wb.Sheets[n] && wb.Sheets[n]['!ref']) ?? wb.SheetNames[0];
  if (!sheetName) throw new Error('workbook has no sheets');
  const sheet = wb.Sheets[sheetName];
  // header:1 -> array of arrays (first row is headers), raw:false -> dates/numbers come back as display strings
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
  const table = rows.filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim())).map((r) => r.map((c) => (c == null ? '' : c)));
  const out = tableToAlbums(table, mapping);
  return { format: 'xlsx', sheet: sheetName, sheets: wb.SheetNames, ...out };
}
