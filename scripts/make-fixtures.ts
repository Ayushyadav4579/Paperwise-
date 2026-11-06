/**
 * Generate real document files used by scripts/ocr-check.ts.
 *
 * These are actual PDF and image files, not text fixtures: OCR and PDF text
 * extraction run against the bytes. They are generated (rather than committed
 * as opaque binaries) so the content is auditable.
 *
 * Requires the optional fonts in /tmp/fonts (see scripts/ocr-check.ts header).
 * Run: bun run scripts/make-fixtures.ts
 */
import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OUT = 'tests/fixtures/real';
const W = 1240;
const H = 1754;

const FONT_DIR = process.env.PAPERWISE_FONT_DIR ?? '/tmp/fonts';
const fonts = {
  sans: `${FONT_DIR}/NotoSans-Regular.ttf`,
  hindi: `${FONT_DIR}/NotoSansDevanagari-Regular.ttf`,
  hand: `${FONT_DIR}/Caveat.ttf`,
};
for (const [name, path] of Object.entries(fonts)) {
  if (existsSync(path)) GlobalFonts.registerFromPath(path, name);
}

type Line = { text: string; size?: number; weight?: 'bold' | 'normal'; gap?: number };

function drawLines(ctx: SKRSContext2D, lines: Line[], options: { start?: number; left?: number; width?: number; color?: string; font?: string; lineHeight?: number } = {}) {
  let y = options.start ?? 110;
  const left = options.left ?? 90;
  const width = options.width ?? W - 180;
  const color = options.color ?? '#111111';
  const family = options.font ?? 'sans';
  for (const line of lines) {
    const size = line.size ?? 26;
    ctx.fillStyle = color;
    ctx.font = `${line.weight === 'bold' ? 'bold ' : ''}${size}px ${family}`;
    if (line.text === '') {
      y += size;
      continue;
    }
    // Simple word wrap so long question text stays inside the page.
    const words = line.text.split(' ');
    let current = '';
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (ctx.measureText(next).width > width && current) {
        ctx.fillText(current, left, y);
        y += Math.round(size * (options.lineHeight ?? 1.5));
        current = word;
      } else {
        current = next;
      }
    }
    if (current) {
      ctx.fillText(current, left, y);
      y += Math.round(size * (options.lineHeight ?? 1.5)) + (line.gap ?? 0);
    }
  }
  return y;
}

const paperPage1: Line[] = [
  { text: 'SAMPLE PUBLIC SCHOOL', size: 30, weight: 'bold' },
  { text: 'Half-Yearly Examination 2025-26', size: 24 },
  { text: 'Class X — Science (086)', size: 24 },
  { text: 'Time allowed: 3 hours    Maximum Marks: 80', size: 24, gap: 18 },
  { text: 'General Instructions:', size: 24, weight: 'bold' },
  { text: '1. All questions are compulsory.', size: 22 },
  { text: '2. Marks for each question are indicated against it.', size: 22, gap: 24 },
  { text: 'SECTION A', size: 26, weight: 'bold', gap: 10 },
  { text: '1. Which of the following is a renewable source of energy?    (1)', size: 26 },
  { text: '(a) coal   (b) natural gas   (c) solar energy   (d) petrol', size: 24, gap: 10 },
  { text: '2. Define respiration. Name the two types of respiration.    (2)', size: 26 },
  { text: '3. Explain why the sky appears blue during the day.    (3)', size: 26 },
  { text: '4. State three differences between aerobic and anaerobic respiration.    (5)', size: 26 },
  { text: 'OR', size: 24, gap: 6 },
  { text: '4. Describe the process of photosynthesis with a labelled diagram.    (5)', size: 26 },
];

const paperPage2: Line[] = [
  { text: 'SECTION B', size: 26, weight: 'bold', gap: 10 },
  { text: '5. Write the balanced chemical equation for the reaction of', size: 26 },
  { text: 'iron with dilute hydrochloric acid.    (2)', size: 26 },
  { text: '6. The following table shows the resistivity of four materials.', size: 26 },
  { text: 'Which material is the best conductor? Give a reason.    (4)', size: 26, gap: 8 },
];

function paperBackground(ctx: SKRSContext2D, tint = '#ffffff') {
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, W, H);
}

function addPaperNoise(ctx: SKRSContext2D, strength = 0.035) {
  const image = ctx.getImageData(0, 0, W, H);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const noise = (Math.random() - 0.5) * 255 * strength;
    data[index] += noise;
    data[index + 1] += noise;
    data[index + 2] += noise;
  }
  ctx.putImageData(image, 0, 0);
}

function drawTable(ctx: SKRSContext2D, x: number, y: number) {
  const rows = [
    ['Material', 'Resistivity (ohm m)'],
    ['Copper', '1.62 x 10^-8'],
    ['Silver', '1.60 x 10^-8'],
    ['Glass', '10^10 to 10^14'],
    ['Rubber', '10^13 to 10^16'],
  ];
  const widths = [300, 400];
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 2;
  rows.forEach((row, rowIndex) => {
    let cellX = x;
    row.forEach((cell, cellIndex) => {
      ctx.strokeRect(cellX, y + rowIndex * 52, widths[cellIndex], 52);
      ctx.fillStyle = '#111111';
      ctx.font = `${rowIndex === 0 ? 'bold ' : ''}23px sans`;
      ctx.fillText(cell, cellX + 12, y + rowIndex * 52 + 34);
      cellX += widths[cellIndex];
    });
  });
}

function drawEquation(ctx: SKRSContext2D, x: number, y: number) {
  ctx.fillStyle = '#111111';
  ctx.font = '28px sans';
  ctx.fillText('Fe + 2HCl  ->  FeCl2 + H2', x, y);
}

function drawDiagram(ctx: SKRSContext2D, x: number, y: number) {
  ctx.strokeStyle = '#333333';
  ctx.fillStyle = '#e8efe6';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(x + 90, y + 50, 80, 45, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + 170, y + 50);
  ctx.lineTo(x + 320, y + 20);
  ctx.moveTo(x + 170, y + 50);
  ctx.lineTo(x + 320, y + 80);
  ctx.stroke();
}

function toJpeg(canvas: ReturnType<typeof createCanvas>, quality = 80): Buffer {
  return canvas.toBuffer('image/jpeg', quality);
}

async function makePdfFromText(lines: Line[], file: string) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages: Line[][] = [lines];
  const chunks: Line[][] = [];
  let current: Line[] = [];
  let used = 0;
  for (const line of lines) {
    used += (line.size ?? 26) * 1.5 + (line.gap ?? 0);
    if (used > H - 200) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(line);
  }
  if (current.length) chunks.push(current);
  void pages;
  for (const chunk of chunks) {
    const page = pdf.addPage([595, 842]);
    let y = 800;
    for (const line of chunk) {
      const size = ((line.size ?? 26) / 2) * 0.95;
      y -= size * 1.5 + ((line.gap ?? 0) / 2);
      if (y < 40) break;
      const text = line.text.normalize('NFKD').replace(/[^\x20-\x7E]/g, '');
      if (!text) continue;
      page.drawText(text, {
        x: 45,
        y,
        size,
        font: line.weight === 'bold' ? bold : font,
        color: rgb(0.06, 0.06, 0.06),
      });
    }
  }
  await writeFile(`${OUT}/${file}`, await pdf.save());
}

async function makeImagePdf(jpeg: Buffer, file: string) {
  const pdf = await PDFDocument.create();
  const image = await pdf.embedJpg(jpeg);
  const page = pdf.addPage([595, 842]);
  page.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
  await writeFile(`${OUT}/${file}`, await pdf.save());
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // 1. Digital question paper with a real text layer, across two pages.
  await makePdfFromText([...paperPage1, ...paperPage2], 'question-paper-digital.pdf');

  // 2. Clean printed scan, then wrapped in an image-only PDF (a real scan).
  const scan = createCanvas(W, H);
  const scanCtx = scan.getContext('2d');
  paperBackground(scanCtx);
  drawLines(scanCtx, paperPage1);
  const scanJpeg = toJpeg(scan, 88);
  await writeFile(`${OUT}/question-paper-scan-page1.jpg`, scanJpeg);
  await makeImagePdf(scanJpeg, 'question-paper-scan.pdf');

  // 3. Phone photograph: slight rotation, uneven light, JPEG noise.
  const photo = createCanvas(W, H);
  const photoCtx = photo.getContext('2d');
  paperBackground(photoCtx, '#efece4');
  photoCtx.save();
  photoCtx.translate(W / 2, H / 2);
  photoCtx.rotate((2.4 * Math.PI) / 180);
  photoCtx.translate(-W / 2, -H / 2);
  drawLines(photoCtx, paperPage1);
  photoCtx.restore();
  addPaperNoise(photoCtx, 0.09);
  const gradient = photoCtx.createLinearGradient(0, 0, W, H);
  gradient.addColorStop(0, 'rgba(0,0,0,0.10)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.05)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.16)');
  photoCtx.fillStyle = gradient;
  photoCtx.fillRect(0, 0, W, H);
  await writeFile(`${OUT}/question-paper-photo.jpg`, toJpeg(photo, 70));

  // 4. Handwritten-style answer sheet with numbered answers in blue ink.
  const hand = createCanvas(W, H);
  const handCtx = hand.getContext('2d');
  paperBackground(handCtx, '#fbfaf4');
  handCtx.strokeStyle = '#cfd8dd';
  handCtx.lineWidth = 1;
  for (let y = 120; y < H; y += 62) {
    handCtx.beginPath();
    handCtx.moveTo(60, y);
    handCtx.lineTo(W - 60, y);
    handCtx.stroke();
  }
  // A "question number" column, like a real ruled answer booklet.
  handCtx.fillStyle = '#2b3350';
  const handLines: Line[] = [
    { text: 'Q1. (c) solar energy', size: 40 },
    { text: 'Q2. Respiration is the breakdown of food to release energy.', size: 38 },
    { text: 'Aerobic respiration needs oxygen, anaerobic does not.', size: 38, gap: 6 },
    { text: 'Q3. Sunlight scatters in the atmosphere. Blue light has a', size: 38 },
    { text: 'shorter wavelength so it scatters more than red light.', size: 38 },
    { text: 'This is called Rayleigh scattering.', size: 38, gap: 6 },
    { text: 'Q4. Aerobic: with oxygen, more energy, in mitochondria.', size: 38 },
    { text: 'Anaerobic: without oxygen, less energy, in cytoplasm.', size: 38 },
    { text: 'Also lactic acid forms in muscles.', size: 38, gap: 6 },
    { text: 'Q5. Fe + 2HCl -> FeCl2 + H2', size: 38 },
    { text: 'Q6. Silver is the best conductor because its resistivity', size: 38 },
    { text: 'is the lowest, 1.60 x 10^-8 ohm m.', size: 38 },
  ];
  drawLines(handCtx, handLines, { start: 150, left: 90, color: '#26325c', font: 'hand', lineHeight: 1.62, width: W - 200 });

  // Ink unevenness and a slight page tilt, as in a phone photo of a booklet.
  const handImage = handCtx.getImageData(0, 0, W, H);
  for (let index = 0; index < handImage.data.length; index += 4) {
    const noise = Math.random() * 22;
    handImage.data[index] -= noise;
    handImage.data[index + 1] -= noise;
    handImage.data[index + 2] -= noise;
  }
  handCtx.putImageData(handImage, 0, 0);
  await writeFile(`${OUT}/answer-sheet-handwritten.jpg`, toJpeg(hand, 76));

  // 5. Hindi answer page.
  const hindi = createCanvas(W, H);
  const hindiCtx = hindi.getContext('2d');
  paperBackground(hindiCtx, '#fdfdf8');
  const hindiLines: Line[] = [
    { text: 'प्रश्न 1. नवीकरणीय ऊर्जा का स्रोत सौर ऊर्जा है।', size: 34 },
    { text: 'प्रश्न 2. श्वसन वह प्रक्रिया है जिसमें भोजन टूटकर ऊर्जा देता है।', size: 34 },
    { text: 'वायवीय श्वसन में ऑक्सीजन की आवश्यकता होती है।', size: 34 },
    { text: 'अवायवीय श्वसन में ऑक्सीजन की आवश्यकता नहीं होती।', size: 34 },
    { text: 'प्रश्न 3. आकाश नीला दिखाई देता है क्योंकि नीला प्रकाश', size: 34 },
    { text: 'अधिक प्रकीर्णित होता है।', size: 34 },
  ];
  drawLines(hindiCtx, hindiLines, { start: 140, left: 80, font: 'hindi', lineHeight: 1.9, width: W - 160 });
  await writeFile(`${OUT}/answer-sheet-hindi.png`, hindi.toBuffer('image/png'));

  // 6. Hard page: faint pencil, table, equation, diagram.
  const hard = createCanvas(W, H);
  const hardCtx = hard.getContext('2d');
  paperBackground(hardCtx, '#f4f2ec');
  hardCtx.fillStyle = 'rgba(90,90,95,0.42)';
  hardCtx.font = '24px sans';
  hardCtx.fillText('Q6. The table below gives resistivity values.', 90, 120);
  hardCtx.fillText('Which material is the best conductor?', 90, 160);
  drawTable(hardCtx, 90, 210);
  drawEquation(hardCtx, 90, 560);
  drawDiagram(hardCtx, 90, 640);
  hardCtx.font = '22px sans';
  hardCtx.fillText('(a) Copper  (b) Silver  (c) Glass  (d) Rubber', 90, 800);
  addPaperNoise(hardCtx, 0.05);
  await writeFile(`${OUT}/question-paper-hard.png`, hard.toBuffer('image/png'));

  console.log(`fixtures written to ${OUT}`);
}

await main();
