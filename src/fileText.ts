import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createWorker, type Worker as OcrWorker } from 'tesseract.js';
import {
  MAX_PDF_PAGES,
  MAX_TEXT_CHARS,
  assessTextQuality,
  joinPages,
  normaliseExtractedText,
  reconstructPageLines,
  validateUpload,
  type PdfTextItemLike,
  type TextQuality,
} from './extraction/layout';

GlobalWorkerOptions.workerSrc = pdfWorker;

type Status = (message: string) => void;

export type ExtractedPage = {
  page: number;
  text: string;
  source: 'text' | 'ocr' | 'none';
  quality: TextQuality;
};

export type ExtractedDocument = {
  file: string;
  text: string;
  pages: ExtractedPage[];
  warnings: string[];
};

const OCR_TARGET_WIDTH = 1800;
const OCR_MAX_SCALE = 2.2;
const IMAGE_MAX_DIMENSION = 2400;

type OcrHandle = { worker: OcrWorker; languages: string; hindiFailed: boolean };

function createOcrHandle(onStatus: Status, state: { hindiFailed: boolean }): () => Promise<OcrHandle> {
  let handle: Promise<OcrHandle> | null = null;
  const start = async (): Promise<OcrHandle> => {
    onStatus('Preparing offline English/Hindi OCR language data…');
    let languages = 'eng+hin';
    try {
      const worker = await createWorker(languages);
      return { worker, languages, hindiFailed: false };
    } catch {
      // Hindi traineddata is a large extra download and can be blocked on a
      // mobile connection. English OCR is still genuinely useful, so degrade
      // to it and tell the user rather than failing the whole upload.
      state.hindiFailed = true;
      languages = 'eng';
      onStatus('Hindi OCR data could not be loaded; using English OCR only.');
      const worker = await createWorker(languages);
      return { worker, languages, hindiFailed: true };
    }
  };
  return () => {
    if (!handle) handle = start();
    return handle;
  };
}

function canUseDom(): boolean {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

async function renderPageForOcr(page: {
  getViewport: (options: { scale: number }) => { width: number; height: number };
  render: (params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
}): Promise<HTMLCanvasElement> {
  if (!canUseDom()) throw new Error('OCR needs a browser.');
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(OCR_MAX_SCALE, OCR_TARGET_WIDTH / Math.max(1, base.width));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext('2d', { willReadFrequently: false });
  if (!context) throw new Error('This browser could not prepare the page for OCR.');
  // A white background avoids losing dark text when a scanned PDF has a
  // transparent page background.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

async function loadImageForOcr(file: File): Promise<HTMLCanvasElement> {
  if (!canUseDom()) throw new Error('OCR needs a browser.');
  const bitmap = await (async () => {
    if (typeof createImageBitmap === 'function') return createImageBitmap(file);
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('The image could not be opened. It may be corrupted or in an unsupported format.'));
      };
      image.src = url;
    });
  })();

  const width = 'width' in bitmap ? bitmap.width : 0;
  const height = 'height' in bitmap ? bitmap.height : 0;
  if (!width || !height) throw new Error('The image has no readable dimensions.');
  const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not prepare the image for OCR.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close();
  return canvas;
}

async function extractPdf(
  file: File,
  onStatus: Status,
  warnings: string[],
  state: { hindiFailed: boolean }
): Promise<{ pages: ExtractedPage[] }> {
  onStatus('Opening PDF and checking every page…');
  let pdf: Awaited<ReturnType<typeof getDocument>['promise']>;
  try {
    pdf = await getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/password/i.test(message)) {
      throw new Error('This PDF is password-protected. Save an unlocked copy and upload it again.');
    }
    throw new Error('This PDF could not be opened. It may be corrupted or not a real PDF file.');
  }

  const pages: ExtractedPage[] = [];
  const getOcr = createOcrHandle(onStatus, state);
  let ocr: OcrHandle | null = null;
  let truncated = false;

  try {
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new Error(
        `This PDF has ${pdf.numPages} pages; Paperwise can read up to ${MAX_PDF_PAGES} pages at a time. Split it into smaller files.`
      );
    }

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      onStatus(`Reading PDF page ${pageNumber} of ${pdf.numPages}…`);
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const items: PdfTextItemLike[] = content.items
          .filter(
            (item): item is typeof item & { str: string; transform: number[] } =>
              'str' in item && Array.isArray((item as { transform?: unknown }).transform)
          )
          .map(item => ({
            str: item.str,
            transform: item.transform,
            width: 'width' in item ? item.width : undefined,
            height: 'height' in item ? item.height : undefined,
            hasEOL: 'hasEOL' in item ? (item as { hasEOL?: boolean }).hasEOL : undefined,
          }));

        let text = reconstructPageLines(items);
        let source: ExtractedPage['source'] = 'text';
        let quality = assessTextQuality(text);

        // A scan can still expose a few text items (page numbers, watermarks).
        // Anything that does not look like real page content goes to OCR.
        if (quality !== 'good') {
          onStatus(`Running OCR on page ${pageNumber} of ${pdf.numPages}…`);
          const handle: OcrHandle = ocr ?? (await getOcr());
          ocr = handle;
          const canvas = await renderPageForOcr(page as unknown as Parameters<typeof renderPageForOcr>[0]);
          try {
            const result = await handle.worker.recognize(canvas);
            const ocrText = normaliseExtractedText(result.data.text || '');
            const ocrQuality = assessTextQuality(ocrText);
            if (ocrText && (ocrQuality !== 'poor' || quality === 'poor')) {
              // Prefer OCR when it clearly reads more of the page.
              if (ocrQuality !== 'poor' && ocrText.length >= text.trim().length) {
                text = ocrText;
                source = 'ocr';
                quality = ocrQuality;
              } else if (quality === 'poor') {
                text = ocrText;
                source = 'ocr';
                quality = ocrQuality;
              }
            }
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        }

        if (text.trim().length > MAX_TEXT_CHARS) {
          text = text.slice(0, MAX_TEXT_CHARS);
          truncated = true;
        }

        pages.push({
          page: pageNumber,
          text,
          source: text.trim() ? source : 'none',
          quality: text.trim() ? quality : 'poor',
        });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    if (ocr) await ocr.worker.terminate().catch(() => undefined);
    await pdf.destroy().catch(() => undefined);
  }

  const unreadable = pages.filter(page => !page.text.trim());
  for (const page of unreadable) {
    warnings.push(
      `Page ${page.page} of ${file.name} could not be read. Re-upload a sharper, well-lit photo of that page.`
    );
  }
  const partial = pages.filter(page => page.text.trim() && page.quality === 'partial');
  if (partial.length) {
    warnings.push(
      `Page${partial.length > 1 ? 's' : ''} ${partial.map(page => page.page).join(', ')} of ${file.name} read only partly. Check the extracted text or re-upload a clearer scan.`
    );
  }
  if (truncated) warnings.push(`${file.name} contains more text than Paperwise can process; the tail was skipped.`);
  if (state.hindiFailed) {
    warnings.push('Hindi OCR data was unavailable, so scanned Hindi text may be misread. Type ambiguous answers manually if needed.');
  }
  return { pages };
}

async function extractImage(
  file: File,
  onStatus: Status,
  warnings: string[],
  state: { hindiFailed: boolean }
): Promise<ExtractedPage[]> {
  onStatus(`Running offline English/Hindi OCR on ${file.name}…`);
  const getOcr = createOcrHandle(onStatus, state);
  const ocr = await getOcr();
  const canvas = await loadImageForOcr(file);
  try {
    const result = await ocr.worker.recognize(canvas);
    const text = normaliseExtractedText(result.data.text || '').slice(0, MAX_TEXT_CHARS);
    const quality = assessTextQuality(text);
    if (!text.trim()) {
      warnings.push(`No readable text was found in ${file.name}. Upload a sharper, well-lit photo.`);
      return [{ page: 1, text: '', source: 'none', quality: 'poor' }];
    }
    if (quality !== 'good') {
      warnings.push(`${file.name} was only partly readable. Check the extracted text before marking.`);
    }
    return [{ page: 1, text, source: 'ocr', quality }];
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    await ocr.worker.terminate().catch(() => undefined);
  }
}

/**
 * Read a question paper or answer sheet into structured pages.
 *
 * Text-based PDFs keep their original layout; scanned pages fall back to OCR.
 * Nothing here claims success for a page it could not read, and every problem
 * is reported with the page number so the student knows what to re-upload.
 */
export async function extractDocument(file: File, onStatus: Status): Promise<ExtractedDocument> {
  const invalid = validateUpload(file);
  if (invalid) throw new Error(invalid);

  const name = file.name.toLowerCase();
  const warnings: string[] = [];
  const state = { hindiFailed: false };

  if (file.type.startsWith('text/') || /\.(txt|md|csv)$/i.test(name)) {
    const text = normaliseExtractedText(await file.text()).slice(0, MAX_TEXT_CHARS);
    const quality = assessTextQuality(text);
    return {
      file: file.name,
      text,
      pages: [{ page: 1, text, source: 'text', quality }],
      warnings: quality === 'good' ? warnings : [...warnings, `${file.name} contains very little readable text.`],
    };
  }

  let pages: ExtractedPage[];
  if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) {
    pages = (await extractPdf(file, onStatus, warnings, state)).pages;
  } else {
    pages = await extractImage(file, onStatus, warnings, state);
  }

  if (!pages.some(page => page.text.trim())) {
    throw new Error(
      `Paperwise could not read any text from ${file.name}. Upload a clearer scan or a text-based PDF. No pages were silently skipped.`
    );
  }

  const text = joinPages(pages.map(page => ({ page: page.page, text: page.text })));
  return { file: file.name, text, pages, warnings };
}
