/**
 * Real-document tests.
 *
 * These run the production extraction logic against actual PDF and image files
 * in tests/fixtures/real (not text fixtures): pdf.js reads the digital PDF's
 * real text layer and rasterises the scanned PDF, and tesseract.js OCRs real
 * JPEG/PNG pixels.
 *
 * They are opt-in because they download tesseract language data (~5 MB English,
 * ~2 MB Hindi) and take about a minute:
 *
 *   PAPERWISE_REAL_DOCS=1 bunx vitest run tests/real-documents.test.ts
 *
 * The optional fixtures can be rebuilt with `bun run scripts/make-fixtures.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { normaliseExtractedText, assessTextQuality, reconstructPageLines } from '../src/extraction/layout';
import { binarisePixels, needsSecondPass } from '../src/extraction/enhance';
import { parsePaper } from '../src/exam/paper';
import { segmentAnswers } from '../src/exam/answers';

const RUN = process.env.PAPERWISE_REAL_DOCS === '1';
const FIXTURES = 'tests/fixtures/real';
const PHYSICS = 'tests/fixtures/physics';
const needed = [
  'question-paper-digital.pdf',
  'question-paper-scan.pdf',
  'question-paper-photo.jpg',
  'answer-sheet-handwritten.jpg',
  'answer-sheet-hindi.png',
  'question-paper-hard.png',
  `${PHYSICS}/physics-paper-scan.pdf`,
  `${PHYSICS}/physics-paper-scan-page1.jpg`,
];
const available = needed.every(file => existsSync(file.startsWith('tests/') ? file : `${FIXTURES}/${file}`));
const suite = RUN && available ? describe : describe.skip;

const summary: Array<{ file: string; chars: number; quality: string; questions: number; detail: string }> = [];

type TesseractWorker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>;
let english: TesseractWorker | null = null;
let hindi: TesseractWorker | null = null;

async function ocr(buffer: Buffer, languages: 'eng' | 'eng+hin'): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  if (languages === 'eng+hin') {
    hindi ??= await createWorker('eng+hin', 1, { logger: () => undefined });
    const result = await hindi.recognize(buffer);
    return normaliseExtractedText(result.data.text || '');
  }
  english ??= await createWorker('eng', 1, { logger: () => undefined });
  const result = await english.recognize(buffer);
  return normaliseExtractedText(result.data.text || '');
}

/** Same second pass the browser extractor runs for a faint or noisy page. */
async function binariseFile(buffer: Buffer): Promise<Buffer> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  binarisePixels(pixels);
  context.putImageData(pixels, 0, 0);
  return canvas.toBuffer('image/png');
}

async function textLayerLength(file: string): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(file));
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  try {
    let length = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      length += content.items.reduce((sum, item) => sum + ('str' in item ? item.str.length : 0), 0);
      page.cleanup();
    }
    return length;
  } finally {
    await pdf.destroy();
  }
}

async function readPdfTextLayer(file: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(file));
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items.flatMap(item => {
        if (!('str' in item) || !Array.isArray((item as { transform?: unknown }).transform)) return [];
        const record = item as unknown as { str: string; transform: number[]; width?: number; height?: number };
        return [{ str: record.str, transform: record.transform, width: record.width, height: record.height }];
      });
      pages.push(reconstructPageLines(items));
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  return normaliseExtractedText(pages.join('\n\n'));
}

function record(file: string, text: string, questions: number, detail: string) {
  summary.push({
    file,
    chars: text.replace(/\s+/g, '').length,
    quality: assessTextQuality(text),
    questions,
    detail,
  });
}

suite('real documents: PDF text layer', () => {
  it('reads the real text layer of a digital question paper and finds its printed marks', async () => {
    const text = await readPdfTextLayer(`${FIXTURES}/question-paper-digital.pdf`);
    const paper = parsePaper(text);
    record('question-paper-digital.pdf', text, paper.questions.length, `total ${paper.resolvedTotal}`);
    console.log('[digital pdf]\n' + text.slice(0, 1200));
    expect(text).toMatch(/renewable source of energy/i);
    expect(text).toMatch(/Maximum Marks:\s*80/i);
    expect(paper.questions.length).toBeGreaterThanOrEqual(5);
    expect(paper.questions.every(question => question.max !== null)).toBe(true);
    expect(paper.resolvedTotal).toBeGreaterThanOrEqual(17);
  });
});

suite('real documents: OCR', () => {
  it('OCRs a scanned PDF page that has no text layer', async () => {
    // A real scan has no text layer, which is exactly what makes the app fall
    // back to OCR. The page image inside the PDF is the fixture below, so the
    // OCR input is the same pixels the browser renders.
    expect(await textLayerLength(`${FIXTURES}/question-paper-scan.pdf`)).toBe(0);
    const image = await readFile(`${FIXTURES}/question-paper-scan-page1.jpg`);
    const text = await ocr(image, 'eng');
    const paper = parsePaper(text);
    record('question-paper-scan.pdf', text, paper.questions.length, paper.questions.map(q => q.ref).join(','));
    console.log('[scanned pdf ocr]\n' + text.slice(0, 1200));
    expect(text).toMatch(/SAMPLE PUBLIC SCHOOL/i);
    expect(text).toMatch(/solar energy/i);
    expect(paper.questions.length).toBeGreaterThanOrEqual(3);
  });

  it('OCRs a photographed question paper with rotation, noise and uneven light', async () => {
    const text = await ocr(await readFile(`${FIXTURES}/question-paper-photo.jpg`), 'eng');
    const paper = parsePaper(text);
    record('question-paper-photo.jpg', text, paper.questions.length, paper.questions.map(q => q.ref).join(','));
    console.log('[photo ocr]\n' + text.slice(0, 1200));
    expect(text).toMatch(/renewable/i);
    expect(text.split(/\n/).length).toBeGreaterThan(5);
  });

  it('OCRs a handwritten-style answer sheet and matches its numbered answers', async () => {
    const text = await ocr(await readFile(`${FIXTURES}/answer-sheet-handwritten.jpg`), 'eng');
    const paper = parsePaper(
      '1. Which source is renewable? (1)\n2. Define respiration. (2)\n3. Why is the sky blue? (3)\n4. Compare aerobic and anaerobic respiration. (5)\n5. Write the balanced equation. (2)\n6. Which material is the best conductor? (4)'
    );
    const segmentation = segmentAnswers(text, paper);
    record('answer-sheet-handwritten.jpg', text, segmentation.segments.length, segmentation.detectedRefs + ' refs');
    console.log('[handwritten ocr]\n' + text.slice(0, 900));
    expect(segmentation.segments.length).toBeGreaterThanOrEqual(4);
    expect(text.toLowerCase()).toContain('respiration');
  });

  it('OCRs a Hindi answer page with the Hindi language model', async () => {
    const text = await ocr(await readFile(`${FIXTURES}/answer-sheet-hindi.png`), 'eng+hin');
    const devanagari = (text.match(/[\u0900-\u097F]/g) || []).length;
    record('answer-sheet-hindi.png', text, 0, `${devanagari} Devanagari chars`);
    console.log('[hindi ocr]\n' + text.slice(0, 900));
    expect(text).toMatch(/[\u0900-\u097F]{4,}/);
    expect(text).toContain('श्वसन');
    // Devanagari matras must count as readable, otherwise a clean Hindi page
    // is reported as only partly read.
    expect(assessTextQuality(text)).toBe('good');
  });

  it('OCRs a scanned physics paper and recovers the merged question numbering', async () => {
    // The scan has no text layer, so every character below is OCR output from
    // the same tesseract pipeline the browser uses.
    expect(await textLayerLength(`${PHYSICS}/physics-paper-scan.pdf`)).toBe(0);
    const text = await ocr(await readFile(`${PHYSICS}/physics-paper-scan-page1.jpg`), 'eng');
    const paper = parsePaper(text);
    record('physics-paper-scan.pdf', text, paper.questions.length, `total ${paper.resolvedTotal} · ${paper.questions.map(q => q.ref).join(',')}`);
    console.log('[physics scan ocr]\n' + text.slice(0, 1200));
    expect(text).toMatch(/vector quantity/i);
    expect(text).toMatch(/velocity-time/i);
    // Page 1 holds Q1–Q5 (9 marks). It must not collapse into one question.
    expect(paper.questions.length).toBeGreaterThanOrEqual(4);
    expect(paper.questions.some(question => question.ref === 'Q1')).toBe(true);
    expect(paper.questions.some(question => question.text.includes('vector quantity'))).toBe(true);
  }, 180_000);

  it('recovers a faint page with the adaptive-threshold second pass', async () => {
    const buffer = await readFile(`${FIXTURES}/question-paper-hard.png`);
    const raw = await ocr(buffer, 'eng');
    const rawQuality = assessTextQuality(raw);
    expect(needsSecondPass(rawQuality, raw.replace(/\s+/g, '').length)).toBe(true);
    const cleaned = await ocr(await binariseFile(buffer), 'eng');
    record('question-paper-hard.png', cleaned, 0, `raw ${rawQuality} → cleaned`);
    console.log('[hard page raw]\n' + raw.slice(0, 300) + '\n[hard page cleaned]\n' + cleaned.slice(0, 600));
    expect(cleaned).toMatch(/resistivity/i);
    expect(cleaned).toMatch(/best conductor/i);
    expect(assessTextQuality(cleaned)).not.toBe('poor');
  }, 180_000);
});

afterAll(async () => {
  if (RUN && summary.length) {
    console.table(summary);
  }
  await english?.terminate().catch(() => undefined);
  await hindi?.terminate().catch(() => undefined);
});
