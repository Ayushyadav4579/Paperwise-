/**
 * Generate the mathematical regression fixtures.
 *
 * The digital PDF has a real text layer where exponents are separate, raised
 * glyph runs (exactly how a maths PDF encodes `10²`), a numeric table, and a
 * question that continues on page 2. The scan is a real image-only PDF with a
 * plain-text rendering of the same paper.
 *
 * The fixtures are synthetic: they reproduce extraction structures, not the
 * user's original paper (which was not available in the repository).
 *
 * Run: bun run scripts/make-math-fixtures.ts
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { mkdir, writeFile } from 'node:fs/promises';

const OUT = 'tests/fixtures/math';
const FONT_PATH = 'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf';
GlobalFonts.registerFromPath(FONT_PATH, 'sans');
GlobalFonts.registerFromPath('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf', 'sans-bold');

type Segment = { text: string; script?: 'sup' | 'sub' };

const page1: Segment[][] = [
  [{ text: 'Class XI Mathematics — Unit Test' }],
  [{ text: 'Time: 90 minutes          Maximum Marks: 25' }],
  [{ text: 'SECTION A' }],
  [{ text: '1. Evaluate 2' }, { text: '3', script: 'sup' }, { text: ' + 1. 2' }],
  [{ text: '2. Solve 3x/4 + 2.5 = 7. 2' }],
  [{ text: '3. A force F = (3i + 4j) N acts on 2 kg. Find the acceleration. 3' }],
  [{ text: '4. The count is 6.02 x 10' }, { text: '23', script: 'sup' }, { text: '. Write it in standard form. 3' }],
  [{ text: 'x 1 2 3' }],
  [{ text: 'y 2 5 10' }],
  [{ text: '5. A projectile is fired with u = 20 m/s' }, { text: '2', script: 'sup' }, { text: ' and g = 9.8 m/s' }, { text: '2', script: 'sup' }],
  [{ text: 'at an angle of 30 degrees to the horizontal.' }],
];

const page2: Segment[][] = [
  [{ text: '... Find the horizontal range of the projectile. 2' }],
  [{ text: 'SECTION B' }],
  [{ text: '6. (a) Differentiate x' }, { text: '3', script: 'sup' }, { text: ' + 2x. 2' }],
  [{ text: '(b) Find the value of the derivative at x = 2. 3' }],
  [{ text: '7. (a) Solve 2x' }, { text: '2', script: 'sup' }, { text: ' - 5x + 2 = 0. 2' }],
  [{ text: '(b) Find the discriminant b' }, { text: '2', script: 'sup' }, { text: ' - 4ac. 3' }],
  [{ text: '(c) Hence find the roots of the equation. 3' }],
];

const scanPage1 = [
  'Class XI Mathematics - Unit Test',
  'Time: 90 minutes          Maximum Marks: 25',
  'SECTION A',
  '1. Evaluate 2^3 + 1. 2',
  '2. Solve 3x/4 + 2.5 = 7. 2',
  '3. A force F = (3i + 4j) N acts on 2 kg. Find the acceleration. 3',
  '4. The count is 6.02 x 10^23. Write it in standard form. 3',
  'x 1 2 3',
  'y 2 5 10',
  '5. A projectile is fired with u = 20 m/s and g = 9.8 m/s^2',
  'at an angle of 30 degrees to the horizontal.',
];

function drawRich(
  page: ReturnType<PDFDocument['addPage']>,
  segments: Segment[],
  x: number,
  y: number,
  font: Awaited<ReturnType<PDFDocument['embedFont']>>,
  size = 11
) {
  let cursor = x;
  for (const segment of segments) {
    const script = segment.script;
    const scriptSize = script ? 7 : size;
    const offset = script === 'sup' ? 3.2 : script === 'sub' ? -2.4 : 0;
    page.drawText(segment.text, {
      x: cursor,
      y: y + offset,
      size: scriptSize,
      font,
      color: rgb(0.07, 0.07, 0.07),
    });
    cursor += font.widthOfTextAtSize(segment.text, scriptSize);
  }
}

async function digitalPdf() {
  const pdf = await PDFDocument.create();
  // Standard fonts keep the fixture dependency-free; exponents are encoded by
  // position (separate raised text runs), which is what this fixture exercises.
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  for (const lines of [page1, page2]) {
    const page = pdf.addPage([595, 842]);
    let y = 790;
    for (const segments of lines) {
      const isHeading = /^(SECTION|[A-Z][a-z]+ XI)/.test(segments[0].text);
      if (isHeading) {
        page.drawText(segments.map(segment => segment.text).join(''), { x: 48, y, size: 11, font: bold });
      } else {
        drawRich(page, segments, 48, y, font);
      }
      y -= 22;
    }
  }
  await writeFile(`${OUT}/math-paper.pdf`, await pdf.save());
}

async function scannedPdf() {
  const width = 1240;
  const height = 1754;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fdfdf9';
  ctx.fillRect(0, 0, width, height);
  let y = 130;
  for (const line of scanPage1) {
    ctx.fillStyle = '#111111';
    ctx.font = /^(SECTION|[A-Z][a-z]+ XI)/.test(line) ? 'bold 27px sans-bold' : '27px sans';
    ctx.fillText(line, 90, y);
    y += 52;
  }
  const image = ctx.getImageData(0, 0, width, height);
  for (let index = 0; index < image.data.length; index += 4) {
    const noise = (Math.random() - 0.5) * 12;
    image.data[index] += noise;
    image.data[index + 1] += noise;
    image.data[index + 2] += noise;
  }
  ctx.putImageData(image, 0, 0);
  const jpeg = canvas.toBuffer('image/jpeg', 88);
  await writeFile(`${OUT}/math-paper-scan-page1.jpg`, jpeg);

  const pdf = await PDFDocument.create();
  const embedded = await pdf.embedJpg(jpeg);
  const page = pdf.addPage([595, 842]);
  page.drawImage(embedded, { x: 0, y: 0, width: 595, height: 842 });
  await writeFile(`${OUT}/math-paper-scan.pdf`, await pdf.save());
}

await mkdir(OUT, { recursive: true });
await digitalPdf();
await scannedPdf();
console.log(`math fixtures written to ${OUT}`);
