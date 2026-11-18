import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { checkPdf, checkXlsx, readZipDirectory, sanitiseFileName, sniff } from './file-sniffer';
import { ClamdClient, parseReply } from './clamav';
import { HardenedUploadPipeline, type FileRecords, type ScanStatus } from './upload-pipeline.service';
import { UPLOAD_POLICIES } from './upload-pipeline';
import type { AppConfig } from '../common/config';
import type { FileStore } from '../common/contracts/file-store';
import { AppError } from '../common/app-error';

// The standard, harmless EICAR anti-virus test string.
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

// ---------- helpers to build test files ----------

function pdf(body: string, trailer = ''): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${body} >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n${trailer}`, 'latin1');
}

function pdfWithCompressedStream(content: string): Buffer {
  const data = deflateSync(Buffer.from(content, 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.5\n1 0 obj\n<< /Type /ObjStm /Filter /FlateDecode /Length ' + data.length + ' >>\nstream\n', 'latin1'),
    data,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
}

/** Minimal stored (uncompressed) ZIP writer. */
function zip(files: Array<{ name: string; data: Buffer; fakeUncompressed?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.fakeUncompressed ?? f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt32LE(f.data.length, 20);
    ch.writeUInt32LE(f.fakeUncompressed ?? f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const xlsxFiles = () => [
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
];

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function pngHeaderBomb(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(1000))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'secret-home-location', Artist: 'Kofi' } })
    .toBuffer();
}

// ---------- sniffing ----------

describe('file sniffing', () => {
  it('detects allowed types from magic bytes, not names', async () => {
    expect(sniff(await jpegWithExif()).type).toBe('image/jpeg');
    expect(sniff(await sharp({ create: { width: 2, height: 2, channels: 4, background: '#fff' } }).png().toBuffer()).type).toBe('image/png');
    expect(sniff(pdf('')).type).toBe('application/pdf');
    expect(sniff(zip(xlsxFiles())).type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(sniff(Buffer.from('name,class\nAma Owusu,P3\n')).type).toBe('text/csv');
  });

  it.each([
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['svg with xml prolog', '<?xml version="1.0"?><svg/>'],
    ['html', '<!DOCTYPE html><html><body>hi</body></html>'],
    ['html after BOM and spaces', '﻿   <html>'],
    ['csv-looking html', 'name,class\n<script>alert(1)</script>'],
  ])('rejects markup: %s', (_n, content) => {
    expect(sniff(Buffer.from(content)).type).toBeNull();
  });

  it('rejects plain zip, binaries, empty files', () => {
    expect(sniff(zip([{ name: 'a.txt', data: Buffer.from('x') }])).type).toBeNull();
    expect(sniff(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03])).type).toBeNull(); // MZ executable
    expect(sniff(Buffer.alloc(0)).type).toBeNull();
  });
});

describe('PDF checks', () => {
  it('accepts a plain PDF', () => {
    expect(checkPdf(pdf(''))).toBeNull();
  });
  it.each(['/OpenAction << /S /JavaScript /JS (app.alert(1)) >>', '/AA << /O << /S /Launch /F (cmd.exe) >> >>', '/Names << /EmbeddedFiles 3 0 R >>', '/AcroForm << /XFA 4 0 R >>', '/OpenAction << /S /J#61vaScript >>'])(
    'rejects active content: %s',
    (body) => {
      expect(checkPdf(pdf(body))).toMatch(/not allowed/);
    },
  );
  it('finds JavaScript hidden inside a compressed object stream', () => {
    expect(checkPdf(pdfWithCompressedStream('<< /S /JavaScript /JS (x) >>'))).toMatch(/javascript/);
  });
  it('rejects polyglots: data appended after %%EOF, header not at start', () => {
    expect(checkPdf(pdf('', zip(xlsxFiles()).toString('latin1')))).toMatch(/appended/);
    expect(checkPdf(Buffer.concat([Buffer.from('GIF89a'), pdf('')]))).toMatch(/header/);
  });
});

describe('XLSX checks', () => {
  it('accepts a normal workbook and reads its directory', () => {
    expect(readZipDirectory(zip(xlsxFiles()))?.map((e) => e.name)).toEqual(['[Content_Types].xml', 'xl/workbook.xml']);
    expect(checkXlsx(zip(xlsxFiles()))).toBeNull();
  });
  it('rejects zip bombs, macros and path traversal', () => {
    expect(checkXlsx(zip([...xlsxFiles(), { name: 'xl/sheet.xml', data: Buffer.alloc(10_000), fakeUncompressed: 500 * 1024 * 1024 }]))).toMatch(/ratio|too large/);
    expect(checkXlsx(zip([...xlsxFiles(), { name: 'xl/vbaProject.bin', data: Buffer.from('x') }]))).toMatch(/macro/);
    expect(checkXlsx(zip([...xlsxFiles(), { name: '../../etc/passwd', data: Buffer.from('x') }]))).toMatch(/unsafe path/);
  });
});

describe('file names', () => {
  it('strips traversal, control and bidi characters', () => {
    expect(sanitiseFileName('../../etc/passwd')).toBe('__.._etc_passwd');
    expect(sanitiseFileName('report‮fdp.exe')).toBe('report_fdp.exe');
    expect(sanitiseFileName('a\u0000b.pdf')).toBe('a_b.pdf');
    expect(sanitiseFileName('x'.repeat(500))).toHaveLength(200);
  });
});

// ---------- mocked clamd ----------

let clamd: Server;
let clamPort: number;
const received: Buffer[] = [];

function startMockClamd(): Promise<void> {
  clamd = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const cmd = 'zINSTREAM\0';
      if (buf.length < cmd.length) return;
      let off = cmd.length;
      const parts: Buffer[] = [];
      while (off + 4 <= buf.length) {
        const len = buf.readUInt32BE(off);
        if (len === 0) {
          const data = Buffer.concat(parts);
          received.push(data);
          sock.end(data.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (off + 4 + len > buf.length) return;
        parts.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
    });
  });
  return new Promise((r) => clamd.listen(0, '127.0.0.1', () => {
    clamPort = (clamd.address() as AddressInfo).port;
    r();
  }));
}

beforeAll(startMockClamd);
afterAll(() => new Promise<void>((r) => clamd.close(() => r())));

describe('ClamdClient', () => {
  it('speaks INSTREAM and reports clean / infected', async () => {
    const c = new ClamdClient('127.0.0.1', clamPort, 5000, 16);
    expect(await c.scan(Buffer.from('hello world, a clean file'))).toEqual({ status: 'clean' });
    expect(received.at(-1)?.toString()).toBe('hello world, a clean file');
    expect(await c.scan(Buffer.from(EICAR))).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' });
  });
  it('reports errors when clamd is unreachable', async () => {
    const v = await new ClamdClient('127.0.0.1', 1, 2000).scan(Buffer.from('x'));
    expect(v.status).toBe('error');
  });
  it('parses replies', () => {
    expect(parseReply('stream: OK\0')).toEqual({ status: 'clean' });
    expect(parseReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({ status: 'infected', signature: 'Win.Test.EICAR_HDB-1' });
    expect(parseReply('INSTREAM size limit exceeded. ERROR\0').status).toBe('error');
    expect(parseReply('').status).toBe('error');
  });
});

// ---------- pipeline ----------

class MemoryStore implements FileStore {
  objects = new Map<string, Buffer>();
  quarantined = new Set<string>();
  async put(key: string, data: Buffer): Promise<void> {
    this.objects.set(key, data);
  }
  async get(key: string): Promise<Readable> {
    return Readable.from([this.objects.get(key)!]);
  }
  async stat(key: string) {
    const o = this.objects.get(key);
    return o ? { sizeBytes: o.length } : null;
  }
  async quarantine(key: string): Promise<void> {
    this.quarantined.add(key);
  }
}

class MemoryRecords implements FileRecords {
  rows = new Map<string, { storageKey: string; scanStatus: ScanStatus; originalName: string; mimeType: string }>();
  async insert(row: Parameters<FileRecords['insert']>[0]): Promise<string> {
    const id = `f${this.rows.size + 1}`;
    this.rows.set(id, row);
    return id;
  }
  async setScanStatus(id: string, status: ScanStatus): Promise<void> {
    this.rows.get(id)!.scanStatus = status;
  }
  async listPending() {
    return [...this.rows].filter(([, r]) => r.scanStatus === 'pending').map(([id, r]) => ({ id, storageKey: r.storageKey }));
  }
}

function pipeline(opts: { clam: boolean; port?: number }) {
  const store = new MemoryStore();
  const records = new MemoryRecords();
  const cfg = { SMS_CLAMAV_ENABLED: opts.clam, SMS_CLAMAV_HOST: '127.0.0.1' } as AppConfig;
  const moduleRef = { get: () => store } as never;
  const scanner = opts.clam ? new ClamdClient('127.0.0.1', opts.port ?? clamPort, 3000) : undefined;
  return { p: new HardenedUploadPipeline(cfg, moduleRef, records, scanner), store, records };
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  try {
    await promise;
    expect.unreachable('expected an AppError');
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect({ status: (e as AppError).status, code: (e as AppError).code }).toEqual({ status, code });
  }
}

describe('HardenedUploadPipeline', () => {
  it('re-encodes images, strips EXIF, stores under a random key and records the file', async () => {
    const { p, store, records } = pipeline({ clam: false });
    const input = await jpegWithExif();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const r = await p.accept({ originalName: '../photo.jpg', buffer: input }, UPLOAD_POLICIES.passportPhoto, 'user-1');
    expect(r).toMatchObject({ mimeType: 'image/jpeg', scanStatus: 'clean', fileId: 'f1' });
    const [key, stored] = [...store.objects][0]!;
    expect(key).toMatch(/^\d{4}-\d{2}\/[0-9a-f-]{36}$/);
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
    expect(stored.toString('latin1')).not.toContain('secret-home-location');
    expect(records.rows.get('f1')!.originalName).toBe('__photo.jpg');
  });

  it('removes a payload appended to a JPEG (polyglot) by re-encoding', async () => {
    const { p, store } = pipeline({ clam: false });
    const poly = Buffer.concat([await jpegWithExif(), Buffer.from('<script>alert(1)</script><?php system($_GET[1]); ?>')]);
    await p.accept({ originalName: 'x.jpg', buffer: poly }, UPLOAD_POLICIES.studentDocument, 'u');
    expect([...store.objects.values()][0]!.toString('latin1')).not.toContain('<script>');
  });

  it('downsizes large images to the policy limits', async () => {
    const { p, store } = pipeline({ clam: false });
    const big = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#0a0' } }).png().toBuffer();
    await p.accept({ originalName: 'logo.png', buffer: big }, UPLOAD_POLICIES.logo, 'u');
    const meta = await sharp([...store.objects.values()][0]!).metadata();
    expect(meta.width).toBe(800);
    expect(meta.format).toBe('png');
  });

  it('rejects oversized files with 413', async () => {
    const { p } = pipeline({ clam: false });
    await expectAppError(p.accept({ originalName: 'a.pdf', buffer: Buffer.alloc(1024 * 1024 + 1) }, UPLOAD_POLICIES.logo, 'u'), 413, 'FILE_TOO_LARGE');
  });

  it('rejects SVG renamed to .png, types outside the policy, and PDFs with JavaScript (415)', async () => {
    const { p, store } = pipeline({ clam: false });
    await expectAppError(p.accept({ originalName: 'x.png', buffer: Buffer.from('<svg onload="alert(1)"/>'), declaredMimeType: 'image/png' }, UPLOAD_POLICIES.passportPhoto, 'u'), 415, 'FILE_TYPE_NOT_ALLOWED');
    await expectAppError(p.accept({ originalName: 'x.pdf', buffer: pdf('') }, UPLOAD_POLICIES.passportPhoto, 'u'), 415, 'FILE_TYPE_NOT_ALLOWED');
    await expectAppError(p.accept({ originalName: 'x.pdf', buffer: pdf('/OpenAction << /S /JavaScript /JS (x) >>') }, UPLOAD_POLICIES.studentDocument, 'u'), 415, 'FILE_TYPE_NOT_ALLOWED');
    await expectAppError(p.accept({ originalName: 'x.jpg', buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('garbage')]) }, UPLOAD_POLICIES.studentDocument, 'u'), 415, 'FILE_TYPE_NOT_ALLOWED');
    expect(store.objects.size).toBe(0);
  });

  it('rejects decompression-bomb images without decoding them', async () => {
    const { p } = pipeline({ clam: false });
    // Valid PNG header claiming 50 000 x 50 000 pixels (2.5 gigapixels) with a tiny body.
    const bomb = pngHeaderBomb(50_000, 50_000);
    expect(bomb.length).toBeLessThan(UPLOAD_POLICIES.studentDocument.maxBytes);
    await expectAppError(p.accept({ originalName: 'b.png', buffer: bomb }, UPLOAD_POLICIES.studentDocument, 'u'), 415, 'FILE_TYPE_NOT_ALLOWED');
  });

  it('accepts CSV and XLSX imports, rejects zip bombs', async () => {
    const { p } = pipeline({ clam: false });
    expect((await p.accept({ originalName: 'a.csv', buffer: Buffer.from('a,b\n1,2\n') }, UPLOAD_POLICIES.importFile, 'u')).mimeType).toBe('text/csv');
    expect((await p.accept({ originalName: 'a.xlsx', buffer: zip(xlsxFiles()) }, UPLOAD_POLICIES.importFile, 'u')).scanStatus).toBe('clean');
    await expectAppError(p.accept({ originalName: 'b.xlsx', buffer: zip([...xlsxFiles(), { name: 'xl/s.xml', data: Buffer.alloc(5000), fakeUncompressed: 300 * 1024 * 1024 }]) }, UPLOAD_POLICIES.importFile, 'u'), 415, 'FILE_TYPE_NOT_ALLOWED');
  });

  it('with ClamAV enabled: EICAR is rejected and nothing is stored; clean files pass', async () => {
    const { p, store } = pipeline({ clam: true });
    await expectAppError(p.accept({ originalName: 'eicar.csv', buffer: Buffer.from(EICAR) }, UPLOAD_POLICIES.importFile, 'u'), 422, 'FILE_INFECTED');
    // EICAR appended to a PDF trailer is caught by the polyglot check before the scanner; inside a PDF comment it is caught by clamd
    const eicarPdf = Buffer.from(`%PDF-1.4\n% ${EICAR}\n1 0 obj << >> endobj\n%%EOF\n`, 'latin1');
    await expectAppError(p.accept({ originalName: 'e.pdf', buffer: eicarPdf }, UPLOAD_POLICIES.studentDocument, 'u'), 422, 'FILE_INFECTED');
    expect(store.objects.size).toBe(0);
    const ok = await p.accept({ originalName: 'ok.pdf', buffer: pdf('') }, UPLOAD_POLICIES.studentDocument, 'u');
    expect(ok.scanStatus).toBe('clean');
  });

  it('with ClamAV enabled but unreachable: file kept as pending, re-scanned later', async () => {
    const { p, records } = pipeline({ clam: true, port: 1 });
    const r = await p.accept({ originalName: 'ok.pdf', buffer: pdf('') }, UPLOAD_POLICIES.studentDocument, 'u');
    expect(r.scanStatus).toBe('pending');
    expect(await p.rescanPending()).toBe(0); // still unreachable
    // swap to a working scanner
    (p as unknown as { scanner: ClamdClient }).scanner = new ClamdClient('127.0.0.1', clamPort, 3000);
    expect(await p.rescanPending()).toBe(1);
    expect(records.rows.get(r.fileId)!.scanStatus).toBe('clean');
  });
});
