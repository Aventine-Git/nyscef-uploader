import { getSecret } from '../shared_helpers/secrets.js';

export interface NyscefCredentials {
    username: string;
    password: string;
    // Our account's display name exactly as NYSCEF renders it in the document table's "Filed By"
    // cell, e.g. 'Burns, James'. Used to tell our exhibits from the opposing party's when picking
    // the next exhibit label. Optional: absent means we cannot attribute rows and fall back to the
    // default label mode. The row's filerId is re-encrypted per docket, so it cannot be used here.
    filerName?: string;
}

let cachedCredentials: NyscefCredentials | null = null;

export async function getNyscefCredentials(): Promise<NyscefCredentials> {
    if (cachedCredentials) return cachedCredentials;
    cachedCredentials = await getSecret<NyscefCredentials>('nyscef/credentials');
    return cachedCredentials;
}

// Our "Filed By" display name, or '' if not configured. The secret is cached, so this is free
// after login has run.
export async function getNyscefFilerName(): Promise<string> {
    const { filerName } = await getNyscefCredentials();
    return filerName?.trim() ?? '';
}
