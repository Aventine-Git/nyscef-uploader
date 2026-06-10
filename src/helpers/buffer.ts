import { PDFDocument } from 'pdf-lib';
import { Readable } from 'stream';

export async function streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.on('error', (err) => { stream.destroy(); reject(err); });
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

export async function mergePDFBuffers(buffers: Buffer[]): Promise<Buffer> {
    const mergedPdf = await PDFDocument.create();
    for (const buffer of buffers) {
        const pdf = await PDFDocument.load(buffer);
        const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
    }
    const mergedBytes = await mergedPdf.save();
    return Buffer.from(mergedBytes);
}
