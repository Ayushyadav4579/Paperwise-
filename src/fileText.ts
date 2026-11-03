import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createWorker } from 'tesseract.js';

GlobalWorkerOptions.workerSrc = pdfWorker;

type Status = (message: string) => void;

export async function extractTextFromFile(file: File, onStatus: Status): Promise<string> {
  const name = file.name.toLowerCase();
  if (file.type.startsWith('text/') || /\.(txt|md|csv)$/i.test(name)) {
    return (await file.text()).trim();
  }

  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  const getOcrWorker = async () => {
    if (!worker) {
      onStatus('Preparing English and Hindi offline OCR language data…');
      worker = await createWorker('eng+hin');
    }
    return worker;
  };

  let pdf: Awaited<ReturnType<typeof getDocument>['promise']> | null = null;
  try {
    if (file.type === 'application/pdf' || name.endsWith('.pdf')) {
      onStatus('Opening PDF and checking all pages…');
      pdf = await getDocument({ data: await file.arrayBuffer() }).promise;
      const pageTexts: string[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        onStatus('Reading PDF page ' + pageNumber + ' of ' + pdf.numPages + '…');
        const page = await pdf.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          const directText = content.items
            .map(item => ('str' in item ? item.str : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (directText.length > 35) {
            pageTexts.push(directText);
            continue;
          }

          onStatus('Running English/Hindi OCR on scanned PDF page ' + pageNumber + ' of ' + pdf.numPages + '…');
          const baseViewport = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(1.5, 1400 / baseViewport.width) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          try {
            const context = canvas.getContext('2d');
            if (!context) {
              pageTexts.push('');
              continue;
            }
            await page.render({ canvasContext: context, viewport }).promise;
            const result = await (await getOcrWorker()).recognize(canvas);
            pageTexts.push(result.data.text.trim());
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        } finally {
          page.cleanup();
        }
      }
      return pageTexts.filter(Boolean).join('\n\n').trim();
    }

    if (file.type.startsWith('image/')) {
      onStatus('Running English/Hindi offline OCR on ' + file.name + '…');
      const result = await (await getOcrWorker()).recognize(file);
      return result.data.text.trim();
    }
    throw new Error('Unsupported file type. Use a photo, PDF, TXT, Markdown, or CSV file.');
  } finally {
    if (worker) await worker.terminate();
    if (pdf) await pdf.destroy();
  }
}