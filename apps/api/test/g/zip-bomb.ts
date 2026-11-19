// Owner: Agent G. Builds "xlsx" zip bombs for the CP5-03 tests without ever holding the inflated data in memory.
import { createDeflateRaw, crc32, deflateRawSync } from 'node:zlib';

interface Part { name: string; method: 0 | 8; data: Buffer; crc: number; size: number }

function stored(name: string, text: string): Part {
  const b = Buffer.from(text, 'utf8');
  return { name, method: 8, data: deflateRawSync(b), crc: crc32(b), size: b.length };
}

/** Streams `totalBytes` of repetitive sheet XML through deflate, 1 MB at a time. */
async function bombPart(name: string, totalBytes: number): Promise<Part> {
  const chunk = Buffer.alloc(1024 * 1024, '<row r="1"><c r="A1" t="inlineStr"><is><t>Kwame Mensah</t></is></c></row>');
  const z = createDeflateRaw({ level: 9 });
  const out: Buffer[] = [];
  z.on('data', (d: Buffer) => out.push(d));
  const done = new Promise<void>((resolve, reject) => { z.on('end', resolve); z.on('error', reject); });
  let crc = 0;
  for (let written = 0; written < totalBytes; written += chunk.length) {
    crc = crc32(chunk, crc);
    if (!z.write(chunk)) await new Promise((r) => z.once('drain', r));
  }
  z.end();
  await done;
  return { name, method: 8, data: Buffer.concat(out), crc, size: Math.ceil(totalBytes / chunk.length) * chunk.length };
}

function zip(parts: Part[], declaredSize: (p: Part) => number): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const p of parts) {
    const name = Buffer.from(p.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(p.method, 8);
    lh.writeUInt32LE(p.crc >>> 0, 14); lh.writeUInt32LE(p.data.length, 18); lh.writeUInt32LE(declaredSize(p), 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(p.method, 10);
    ch.writeUInt32LE(p.crc >>> 0, 16); ch.writeUInt32LE(p.data.length, 20); ch.writeUInt32LE(declaredSize(p), 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, p.data);
    centrals.push(ch, name);
    offset += 30 + name.length + p.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(parts.length, 8); eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/**
 * A workbook whose sheet XML inflates to `inflatedMb` MB.
 * honest: the zip directory tells the truth about the size. lying: it claims each part is 2 KB.
 */
export async function xlsxBomb(inflatedMb: number, mode: 'honest' | 'lying'): Promise<Buffer> {
  const parts = [
    stored('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    stored('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    stored('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Pupils" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    stored('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    await bombPart('xl/worksheets/sheet1.xml', inflatedMb * 1024 * 1024),
  ];
  return zip(parts, (p) => (mode === 'lying' ? Math.min(p.size, 2048) : p.size));
}
