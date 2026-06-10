import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({ region: 'us-east-1' });

export async function invokeLambda(functionName: string, data: any) {
    const payload = JSON.stringify(data);

    console.log('Invoking Lambda function:', functionName);
    // console.log('Payload:', payload);

    const command = new InvokeCommand({
        FunctionName: functionName,
        Payload: Buffer.from(payload),
        InvocationType: 'RequestResponse',
    });
    const response = await lambda.send(command);

    // Parse the response payload
    const result = response.Payload ? JSON.parse(Buffer.from(response.Payload).toString()) : null;
    console.log('Lambda response:', result);

    // Unhandled exception inside the invoked function
    if (response.FunctionError) {
        const msg = result?.errorMessage ?? response.FunctionError;
        throw new Error(`Lambda '${functionName}' function error: ${msg}`);
    }

    // Application-level HTTP error (e.g. { statusCode: 400, body: '{"error":"..."}' })
    if (result?.statusCode >= 400) {
        let detail: string;
        try {
            const body = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
            detail = body?.error ?? body?.message ?? JSON.stringify(body);
        } catch {
            detail = String(result.body ?? result.statusCode);
        }
        throw new Error(`Lambda '${functionName}' returned ${result.statusCode}: ${detail}`);
    }

    return result;
}

