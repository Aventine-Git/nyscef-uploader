import { Document, DocumentType } from '../types.js';

export function formatDataTable(docs: Document[]): string {
    if (!docs.length) return '';
    let html = `
    <table style="border-collapse:collapse; width:100%; font-family:sans-serif;">
        <thead>
            <tr style="background:#f2f2f2;">
                <th style="border:1px solid #ccc; padding:8px;">#</th>
                <th style="border:1px solid #ccc; padding:8px;">Parcel ID</th>
                <th style="border:1px solid #ccc; padding:8px;">ScarID</th>
                <th style="border:1px solid #ccc; padding:8px;">County</th>
                <th style="border:1px solid #ccc; padding:8px;">${docs[0].type === DocumentType.STIPULATION ? 'Disposition' : docs[0].type === DocumentType.EVIDENCE ? 'Evidence Type' : 'Letter Type'}</th>
                <th style="border:1px solid #ccc; padding:8px;">Upload Status</th>
            </tr>
        </thead>
        <tbody>
    `;
    docs.forEach((doc, idx) => {
        html += `
            <tr>
                <td style="border:1px solid #ccc; padding:8px; text-align:center;">${idx + 1}</td>
                <td style="border:1px solid #ccc; padding:8px;">${doc.parcelID}</td>
                <td style="border:1px solid #ccc; padding:8px;">${doc.scarID}</td>
                <td style="border:1px solid #ccc; padding:8px;">${doc.county}</td>
                <td style="border:1px solid #ccc; padding:8px;">${doc.identifier}</td>
                <td style="border:1px solid #ccc; padding:8px;">${doc.wasSkipped ? 'SKIPPED (already uploaded)' : doc.hasBeenUploaded ? 'UPLOADED' : 'NOT UPLOADED'}</td>
            </tr>
        `;
    });
    html += `</tbody></table>`;
    return html;
}
