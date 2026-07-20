import { getS3 } from '../shared_helpers/s3.js';
import { Readable } from 'stream';
import { streamToBuffer } from '../helpers/buffer.js';
import { Document, DocumentType, parseExhibitLabelMode } from '../types.js';
import { QueueItem } from '../queue/queueClient.js';

export async function prepareFromQueueItem(item: QueueItem): Promise<Document> {
    const s3Object = await getS3(item.S3Bucket, item.S3Key);
    const buffer = await streamToBuffer(s3Object.Body as Readable);

    return {
        type: item.DocumentType,
        scarID: item.ScarID,
        parcelID: item.ParcelID,
        year: item.Year,
        municode: item.CountyCode,
        county: item.County,
        negotiatorID: item.NegotiatorID,
        isVillage: item.IsVillage,
        docBuffer: buffer,
        identifier: item.Identifier,
        description: item.Description ?? null,
        s3Key: item.S3Key,
        exhibitLabelMode: parseExhibitLabelMode(item.ExhibitLabelMode, `queue item ${item.ID} (ParcelID ${item.ParcelID})`),
        hasBeenUploaded: false,
        wasSkipped: false,
        forceUpload: item.ForceUpload,
    } satisfies Document;
}
