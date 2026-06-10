export async function retry(fn: () => Promise<unknown>, humanError: string, maxRetries = 3, delayMs: number = 1000): Promise<unknown> {
    let error: any;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            if (err?.noRetry === true) throw err;
            error = err;
            if (attempt < maxRetries) {
                console.warn(`Attempt ${attempt} failed. Retrying in ${delayMs}ms...`, err);
                await new Promise((res) => global.setTimeout(res, delayMs));
            } else {
                console.warn(`Attempt ${attempt} failed (final attempt).`, err);
            }
        }
    }
    console.error(error);
    if (error != null && typeof error === 'object') {
        error.Message = humanError;
    }
    throw error;
}
