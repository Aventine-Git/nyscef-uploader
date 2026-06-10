import { Page } from 'playwright-core';
import { putS3 } from '@shared/s3.js';

export async function tryScreenshot(page: Page): Promise<Buffer | undefined> {
    try {
        const buffer = await page.screenshot({ fullPage: true });
        console.log('Screenshot taken for error reporting.', buffer);
        return Buffer.from(buffer);
    } catch (error) {
        console.warn('Failed to take screenshot:', error);
        return undefined;
    }
}

export async function uploadScreenshotToS3(screenshot: Buffer): Promise<string> {
    const key = `screenshots/screenshot-${Date.now()}.png`;
    const res = await putS3('notifier-reports', key, screenshot, 'screenshot.png', 'image/png');
    if (!res) {
        throw new Error('Failed to upload screenshot to S3');
    }
    return `https://notifier-reports.s3.us-east-1.amazonaws.com/${key}`;
}
