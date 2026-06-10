import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ListObjectsV2CommandInput } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
    region: 'us-east-1',
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(operation: () => Promise<T>, maxRetries: number = 5, baseDelayMs: number = 1000): Promise<T> {
    let lastError: Error | unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error: any) {
            lastError = error;
            const isRetryable = error?.Code === 'SlowDown' || error?.name === 'SlowDown' || error?.$metadata?.httpStatusCode === 503;

            if (!isRetryable || attempt === maxRetries) {
                throw error;
            }

            const delayMs = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
            console.log(`S3 rate limited, retrying in ${Math.round(delayMs)}ms (attempt ${attempt + 1}/${maxRetries})`);
            await sleep(delayMs);
        }
    }
    throw lastError;
}

export async function getS3(bucket: string, key: string) {
    const getObjectParams = {
        Bucket: bucket,
        Key: key,
    };
    try {
        const res = await s3.send(new GetObjectCommand(getObjectParams));
        return res;
    } catch (error) {
        //console.error('Error fetching from S3:', error);
        throw error;
    }
}

export async function putS3(bucket: string, key: string, body: Buffer | Uint8Array | Blob | string, contentDisposition: string, type: string = 'application/octet-stream') {
    const putObjectParams = {
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentDisposition: contentDisposition,
        ContentType: type,
    };
    try {
        const res = await withRetry(() => s3.send(new PutObjectCommand(putObjectParams)));
        return res;
    } catch (error) {
        console.error('Error uploading to S3:', error);
        throw error;
    }
}

export async function listS3(bucket: string, prefix: string) {
    const listObjectParams: ListObjectsV2CommandInput = {
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1000,
    };
    let isTruncated = true;
    let continuationToken: string | undefined = undefined;
    let allContents: any[] = [];

    try {
        while (isTruncated) {
            const params = { ...listObjectParams };
            if (continuationToken) {
                params['ContinuationToken'] = continuationToken;
            }
            const res = await s3.send(new ListObjectsV2Command(params));
            if (res.Contents) {
                allContents = allContents.concat(res.Contents);
            }
            isTruncated = !!res.IsTruncated;
            continuationToken = res.NextContinuationToken;
        }
        return { Contents: allContents };
    } catch (error) {
        console.error('Error listing S3 objects:', error);
        throw error;
    }
}

export async function getPresignedS3(bucket: string, key: string, expiresIn: number = 3600): Promise<string> {
    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    });
    try {
        const url = await getSignedUrl(s3, command, { expiresIn });
        return url;
    } catch (error) {
        console.error('Error generating presigned URL:', error);
        throw error;
    }
}
