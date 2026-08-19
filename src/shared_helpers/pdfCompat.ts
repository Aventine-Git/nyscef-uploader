// PDF compatibility shims for documents that get filed with NYSCEF.
//
// NYSCEF's document checker refuses PDFs written in pdf-lib's default shape, and the failure is
// silent from our side: the court rejects the filing, and until post-submit verification existed
// we recorded it as uploaded anyway. Two independent things about pdf-lib output trip it, and both
// have to be corrected on the way out.
//
//  1. Structure. `save()` defaults to `useObjectStreams: true`, which emits cross-reference streams
//     (/XRef) and object streams (/ObjStm) and writes no classic `xref` table. Both are PDF 1.5+
//     constructs that an older parser cannot follow at all.
//  2. Declared version. pdf-lib hardcodes `%PDF-1.7` in its writer — `PDFWriter.serializeToBuffer`
//     calls `PDFHeader.forVersion(1, 7)` literally, and the `context.header` populated on load is
//     ignored on save. There is no option or API to change it, so it is corrected in the bytes.
//
// This is the same transformation as the manual "print to PDF and re-upload" workaround, applied
// automatically. Route every court-bound buffer through `saveForNyscef` rather than calling
// `save()` directly.

// Structural type rather than an import: it spares _SHARED a pdf-lib dependency it would otherwise
// only need for this signature, and pdf-lib's PDFDocument satisfies it as-is.
export interface SavablePdf {
    save(options: { useObjectStreams: boolean }): Promise<Uint8Array>;
}

// PDF 1.4 (Acrobat 5, 2001) is the conservative target: universally supported, and new enough to
// declare transparency, which 1.3 does not. Nothing we emit after dropping object streams needs
// anything past it.
const TARGET_MINOR_VERSION = 4;

const HEADER_PREFIX = '%PDF-1.';
const ASCII_ZERO = 0x30;

/**
 * Save a pdf-lib document in the shape NYSCEF accepts: classic xref table, `%PDF-1.4` header.
 */
export async function saveForNyscef(pdfDoc: SavablePdf): Promise<Buffer> {
    const bytes = await pdfDoc.save({ useObjectStreams: false });
    return Buffer.from(withLegacyHeader(bytes));
}

/**
 * Rewrite a `%PDF-1.N` header down to `%PDF-1.4`, in place and same-length.
 *
 * The length must not change: a PDF's xref table stores absolute byte offsets for every object, so
 * inserting or removing a single byte here would invalidate all of them and corrupt the file.
 * Overwriting the one version digit keeps every offset exactly where the xref says it is.
 *
 * Returns the input untouched if it does not start with a recognizable header, or if it already
 * declares 1.4 or lower — this only ever downgrades, never upgrades.
 */
export function withLegacyHeader(bytes: Uint8Array): Uint8Array {
    if (bytes.length < HEADER_PREFIX.length + 1) return bytes;

    for (let i = 0; i < HEADER_PREFIX.length; i++) {
        if (bytes[i] !== HEADER_PREFIX.charCodeAt(i)) return bytes;
    }

    const minorVersion = bytes[HEADER_PREFIX.length] - ASCII_ZERO;
    if (minorVersion < 0 || minorVersion > 9) return bytes; // not a digit — leave it alone
    if (minorVersion <= TARGET_MINOR_VERSION) return bytes;

    const out = bytes.slice();
    out[HEADER_PREFIX.length] = ASCII_ZERO + TARGET_MINOR_VERSION;
    return out;
}
