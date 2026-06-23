import fetch from 'node-fetch';
import { Document } from '../types.js';

export function findFirstValidCountyCode(docs: Document[]): string | null {
    for (const doc of docs) {
        if (doc.municode !== undefined && doc.municode !== null && doc.municode.trim() !== '') {
            return doc.municode;
        }
    }
    return null;
}

export async function getCountyCodeMap(): Promise<Record<string, string>> {
    // get json map from https://api.aventineproperties.com/counties
    const countyCodeMapRes = await fetch('https://api.aventineproperties.com/counties');
    if (!countyCodeMapRes.ok) {
        throw new Error(`Failed to fetch county code map: ${countyCodeMapRes.status} ${countyCodeMapRes.statusText}`);
    }
    const countyCodeMap = (await countyCodeMapRes.json()) as Record<string, string>;
    console.log('✅ [COUNTY] Fetched county code map', countyCodeMap);
    return countyCodeMap;
}
