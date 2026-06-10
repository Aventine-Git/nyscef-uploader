import { putS3 } from '@shared/s3.js';
import { Document, DocumentType } from '../types.js';
import { executeSQLQuery } from '@shared/sql.js';

export async function handleWithdrawals(docs: Document[], testing: boolean = false) {
    for (const doc of docs) {
        if (doc.type !== DocumentType.STIPULATION) continue;
        if (doc.identifier !== 'W') continue;
        if (!doc.hasBeenUploaded) continue;
        if (testing) {
            console.log(`[TESTING MODE] Skipping withdrawal processing for ParcelID: ${doc.parcelID}`);
            continue;
        }
        try {
            const s3Url = await uploadWithdrawalS3(doc);
            console.log(`Uploaded withdrawal PDF for ParcelID: ${doc.parcelID} to S3: ${s3Url}`);
            const rowsUpdated = await updateWithdrawalStatus(doc);
            console.log(`Updated withdrawal status in database for ParcelID: ${doc.parcelID}, Rows affected: ${rowsUpdated}`);
        } catch (error) {
            console.error(`Error processing withdrawal for ParcelID: ${doc.parcelID}:`, error);
        }
    }
}

async function uploadWithdrawalS3(stip: Document): Promise<string> {
    const bucket = 'aventineweb1563ddc3658141f79e6f28d3c7492b3c152755-portal';
    const key = `public/${stip.parcelID}scardispo${stip.year}.pdf`;
    const res = await putS3(bucket, key, Buffer.from(stip.docBuffer), `${stip.parcelID}scardispo${stip.year}.pdf`, 'application/pdf');
    if (!res) {
        throw new Error(`Failed to upload withdrawal PDF for ParcelID: ${stip.parcelID}`);
    }
    return `https://${bucket}.s3.us-east-1.amazonaws.com/${key}`;
}

async function updateWithdrawalStatus(stip: Document): Promise<number> {
    const datecol = stip.isVillage ? 'VillageSCARDeterminationDate' : 'SCARDeterminationDate';
    const idcol = stip.isVillage ? 'VillageSCARIndexNumber' : 'SCARIndexNumber';
    const query = `UPDATE Courtfiles SET ${datecol} = NOW() WHERE ParcelID = ? and ${idcol} = ?`;
    const params = [stip.parcelID, stip.scarID];
    const result = await executeSQLQuery(query, params);
    if (result.affectedRows === 0) {
        console.warn(`No rows were updated in Courtfiles table for ParcelID: ${stip.parcelID}, ScarID: ${stip.scarID}`);
    }
    return result.affectedRows;
}
