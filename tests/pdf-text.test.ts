import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { pdfText } from '../src/domain/pdf-text.ts';

/** A small PDF assembled by hand: numbered objects, an xref table and a trailer. Streams are latin1 strings or Buffers. */
function pdf(objects: (string | { dict: string; data: Buffer | string })[], trailer = '') {
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'; const offsets: number[] = [];
  objects.forEach((item, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    if (typeof item === 'string') out += `${index + 1} 0 obj\n${item}\nendobj\n`;
    else { const data = Buffer.isBuffer(item.data) ? item.data.toString('latin1') : item.data; out += `${index + 1} 0 obj\n<< ${item.dict} /Length ${Buffer.byteLength(data, 'latin1')} >>\nstream\n${data}\nendstream\nendobj\n`; }
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const TO_UNICODE = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0001> <3042> <0002> <3044> endbfchar
1 beginbfrange <0003> <0004> <3046> endbfrange
1 beginbfrange <0010> <0011> [<6F22> <5B57>] endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`;

test('text from a plain page keeps its lines and spaces', () => {
  const file = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    { dict: '', data: 'BT /F1 12 Tf 72 712 Td (Hello \\(Niwa\\)) Tj 0 -14 Td [(Second) -300 (line)] TJ ET' },
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']);
  assert.deepEqual(pdfText(file), { ok: true, text: 'Hello (Niwa)\nSecond line', pages: 1 });
});

test('Japanese text in compressed streams is read through ToUnicode, including fonts packed in an object stream', () => {
  const content = deflateSync(Buffer.from('BT /F1 10 Tf 1 0 0 1 50 700 Tm <00010002> Tj 1 0 0 1 50 680 Tm [<0003> -120 <0004>] TJ T* <00100011> Tj ET', 'latin1'));
  const packed = '<< /Type /Font /Subtype /Type0 /BaseFont /Gothic /Encoding /Identity-H /ToUnicode 6 0 R >>';
  const objstm = deflateSync(Buffer.from(`9 0 ${packed}`, 'latin1'));
  const file = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 /Resources << /Font << /F1 9 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /Contents [4 0 R] >>', { dict: '/Filter /FlateDecode', data: content },
    { dict: `/Type /ObjStm /N 1 /First ${'9 0 '.length} /Filter /FlateDecode`, data: objstm }, { dict: '/Filter /FlateDecode', data: deflateSync(Buffer.from(TO_UNICODE, 'latin1')) },
    '<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>', { dict: '', data: 'BT /F1 10 Tf <0001> Tj ET' }]);
  assert.deepEqual(pdfText(file), { ok: true, text: 'あい\nうぇ\n漢字\n\nあ', pages: 2 });
});

test('pages without a text layer, encrypted files and other files give no text rather than wrong text', () => {
  const scanned = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    { dict: '', data: 'q 612 0 0 792 0 0 cm /Im0 Do Q' }]);
  assert.deepEqual(pdfText(scanned), { ok: false, reason: 'no_text' });
  const encrypted = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>', '<< /Filter /Standard /V 2 >>'], '/Encrypt 3 0 R ');
  assert.deepEqual(pdfText(encrypted), { ok: false, reason: 'encrypted' });
  assert.deepEqual(pdfText(Buffer.from('not a pdf')), { ok: false, reason: 'not_pdf' });
  assert.equal(pdfText(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 9 0 R >> endobj')).ok, false);
  // A Type0 font without ToUnicode cannot be decoded and is left out.
  const unmapped = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    { dict: '', data: 'BT /F1 12 Tf <00010002> Tj ET' }, '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H >>']);
  assert.deepEqual(pdfText(unmapped), { ok: false, reason: 'no_text' });
});

test('a stream that inflates far beyond its size is cut off instead of filling memory', () => {
  const bomb = deflateSync(Buffer.alloc(64 * 1024 * 1024, 0x20));
  const file = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    { dict: '/Filter /FlateDecode', data: bomb }]);
  const started = Date.now();
  assert.equal(pdfText(file).ok, false);
  assert.ok(Date.now() - started < 10_000);
});
