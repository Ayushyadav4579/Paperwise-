/**
 * Generate the Class XI Physics regression fixtures.
 *
 * The uploaded paper and official solutions were not present in the
 * repository, so these files reproduce the structure the user reported:
 * Section A 3 marks, Section B 6 marks, Section C 16 marks, total 25;
 * Q6 and Q7 are 8 marks each (2 + 3 + 3).
 *
 * The PDF has a real text layer and wraps long questions across lines; the
 * scan is a real image-only PDF. Run: bun run scripts/make-physics-fixtures.ts
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { mkdir, writeFile } from 'node:fs/promises';

const OUT = 'tests/fixtures/physics';
const FONT = 'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf';
const BOLD = 'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf';
GlobalFonts.registerFromPath(FONT, 'sans');
GlobalFonts.registerFromPath(BOLD, 'sans-bold');

const page1 = [
  'Class XI Physics — Unit Test',
  'Time: 1 hour 30 minutes            Maximum Marks: 25',
  '',
  'General Instructions:',
  '1. All questions are compulsory.',
  '2. Marks for each question are indicated against it.',
  '',
  'SECTION A',
  '',
  '1. Which physical quantity is a vector quantity? 1',
  '(a) speed   (b) velocity   (c) distance   (d) mass',
  '',
  '2. The slope of a velocity-time graph represents which physical quantity? 1',
  '(a) displacement   (b) velocity   (c) acceleration   (d) force',
  '',
  '3. A ball is thrown vertically upward with a speed of 20 m/s. Taking',
  'g = 10 m/s2, calculate its maximum height. 1',
  '',
  'SECTION B',
  '',
  "4. State Newton's second law of motion and derive the relation F = ma. 3",
  '',
  '5. Define the work done by a constant force and state its SI unit. 3',
];

const page2 = [
  'SECTION C',
  '',
  '6. A projectile is fired from the ground with a speed of 20 m/s at an',
  'angle of 30 degrees to the horizontal. Calculate:',
  '(a) the time of flight. 2',
  '(b) the maximum height reached. 3',
  '(c) the horizontal range. 3',
  '',
  '7. A block of mass 5 kg is pulled along a rough horizontal surface by a',
  'horizontal force of 25 N. The coefficient of kinetic friction is 0.3.',
  'Take g = 10 m/s2.',
  '(a) Draw the free-body diagram of the block. 2',
  '(b) Calculate the frictional force acting on the block. 3',
  '(c) Calculate the net acceleration of the block. 3',
];

async function digitalPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const lines of [page1, page2]) {
    const page = pdf.addPage([595, 842]);
    let y = 790;
    for (const line of lines) {
      if (line) {
        page.drawText(line, {
          x: 48,
          y,
          size: 11,
          font: /^(SECTION|[A-Z][a-z]+ XI)/.test(line) ? bold : font,
          color: rgb(0.07, 0.07, 0.07),
        });
      }
      y -= 22;
    }
  }
  await writeFile(`${OUT}/physics-paper.pdf`, await pdf.save());
}

async function scannedPdf() {
  const width = 1240;
  const height = 1754;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fdfdf9';
  ctx.fillRect(0, 0, width, height);
  let y = 120;
  for (const line of page1) {
    if (line) {
      ctx.fillStyle = '#111111';
      ctx.font = /^(SECTION|[A-Z][a-z]+ XI)/.test(line) ? 'bold 27px sans-bold' : '27px sans';
      ctx.fillText(line, 90, y);
    }
    y += 48;
  }
  // Mild scanner noise, still cleanly readable.
  const image = ctx.getImageData(0, 0, width, height);
  for (let index = 0; index < image.data.length; index += 4) {
    const noise = (Math.random() - 0.5) * 14;
    image.data[index] += noise;
    image.data[index + 1] += noise;
    image.data[index + 2] += noise;
  }
  ctx.putImageData(image, 0, 0);
  const jpeg = canvas.toBuffer('image/jpeg', 88);
  await writeFile(`${OUT}/physics-paper-scan-page1.jpg`, jpeg);

  const pdf = await PDFDocument.create();
  const embedded = await pdf.embedJpg(jpeg);
  const page = pdf.addPage([595, 842]);
  page.drawImage(embedded, { x: 0, y: 0, width: 595, height: 842 });
  await writeFile(`${OUT}/physics-paper-scan.pdf`, await pdf.save());
}

await mkdir(OUT, { recursive: true });
await digitalPdf();
await scannedPdf();
console.log(`physics fixtures written to ${OUT}`);
