// Minimal .xlsx writer (no dependencies). Builds a real Office Open XML workbook inside an uncompressed ZIP.
// sheets: [{ name, columns: [{ label, width? , money? }], rows: [[cell, ...]], bold?: Set<rowIndex> }]
// A cell is a string, a number, null, or { v, bold?, money? }.

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const colName = i => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
export const safeSheetName = (n, used = new Set()) => {
  let base = String(n || "Sheet").replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet", out = base, k = 2;
  while (used.has(out.toLowerCase())) out = base.slice(0, 28) + " " + k++;
  used.add(out.toLowerCase()); return out;
};

// styles: 0 normal, 1 bold, 2 money (#,##0.00), 3 bold money
function cellXml(ref, cell, colMoney) {
  const o = cell !== null && typeof cell === "object" ? cell : { v: cell };
  if (o.v === null || o.v === undefined || o.v === "") return o.bold ? `<c r="${ref}" s="1"/>` : "";
  const isNum = typeof o.v === "number" && Number.isFinite(o.v);
  const money = isNum && (o.money ?? colMoney);
  const s = (o.bold ? 1 : 0) + (money ? 2 : 0);
  const sAttr = s ? ` s="${s}"` : "";
  return isNum ? `<c r="${ref}"${sAttr}><v>${o.v}</v></c>` : `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(o.v)}</t></is></c>`;
}
function sheetXml(sh) {
  const cols = sh.columns || [];
  const widths = cols.map((c, i) => c.width || Math.min(60, Math.max(10, String(c.label || "").length + 2, ...sh.rows.slice(0, 200).map(r => { const v = r[i]; const x = v && typeof v === "object" ? v.v : v; return x === null || x === undefined ? 0 : String(typeof x === "number" ? x.toFixed(2) : x).length + 2; }))));
  const head = `<row r="1">${cols.map((c, i) => cellXml(colName(i) + 1, { v: c.label, bold: true }, false)).join("")}</row>`;
  const body = sh.rows.map((r, ri) => `<row r="${ri + 2}">${r.map((v, ci) => cellXml(colName(ci) + (ri + 2), sh.bold && sh.bold.has(ri) && (v === null || typeof v !== "object") ? { v, bold: true } : v, cols[ci] && cols[ci].money)).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${head}${body}</sheetData></worksheet>`;
}
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

export function workbookFiles(sheets) {
  const used = new Set(), names = sheets.map(s => safeSheetName(s.name, used));
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": STYLES
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s); });
  return files;
}

/** Store-only ZIP. files: { path: string }. Returns Uint8Array. */
export function zipStore(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const u16 = n => [n & 0xff, (n >>> 8) & 0xff], u32 = n => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [path, text] of Object.entries(files)) {
    const name = enc.encode(path), data = enc.encode(text), crc = crc32(data);
    const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
    parts.push(local, name, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
    offset += local.length + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0), count = Object.keys(files).length;
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(count), ...u16(count), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, end], out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
export const buildXlsx = sheets => zipStore(workbookFiles(sheets));
export function downloadXlsx(filename, sheets) {
  const blob = new Blob([buildXlsx(sheets)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = filename.endsWith(".xlsx") ? filename : filename + ".xlsx"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
