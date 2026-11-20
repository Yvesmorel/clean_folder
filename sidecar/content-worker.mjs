import { parentPort, workerData } from 'node:worker_threads';
import { getDocumentProxy } from 'unpdf';
import { unzipSync, strFromU8 } from 'fflate';

const sample = (text) => text.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
  .replace(/\s+/gu, ' ').trim().split(' ').slice(0, 80).join(' ').slice(0, 600);
async function extract() {
  const data = new Uint8Array(workerData.data);
  if (workerData.extension === '.docx') {
    const entries = unzipSync(data, { filter: (entry) => entry.name === 'word/document.xml' && entry.originalSize <= 2_000_000 });
    if (!entries['word/document.xml']) throw new Error('The Word document is unreadable or too large.');
    const xml = strFromU8(entries['word/document.xml']);
    const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)].map((match) => match[1]).join(' ')
      .replace(/&(?:amp|lt|gt|quot|apos);/g, (value) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[value])
      .replace(/&#(x[\da-f]+|\d+);/gi, (_, value) => {
        const code = value[0] === 'x' ? parseInt(value.slice(1), 16) : Number(value);
        return code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
      });
    return sample(text);
  }
  const pdf = await getDocumentProxy(data, { isEvalSupported: false, useSystemFonts: false });
  try {
    let text = '';
    for (let number = 1; number <= Math.min(2, pdf.numPages); number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      text += ' ' + content.items.filter((item) => typeof item.str === 'string').map((item) => item.str).join(' ');
      page.cleanup();
      if (sample(text).split(' ').length >= 80) break;
    }
    return sample(text);
  } finally { await pdf.loadingTask.destroy(); }
}
extract().then((text) => parentPort.postMessage({ text }))
  .catch(() => parentPort.postMessage({ error: 'Excerpt unavailable: the document is protected, empty or unreadable.' }));
