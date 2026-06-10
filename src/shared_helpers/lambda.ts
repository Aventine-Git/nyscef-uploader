import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({ region: 'us-east-1' });

export async function invokeLambda(functionName: string, data: any) {
    const payload = JSON.stringify(data);

    console.log('Invoking Lambda function:', functionName);
    console.log('Payload:', payload);

    const command = new InvokeCommand({
        FunctionName: functionName,
        Payload: Buffer.from(payload),
        InvocationType: 'RequestResponse',
    });
    const response = await lambda.send(command);

    // Parse the response payload
    const result = response.Payload ? JSON.parse(Buffer.from(response.Payload).toString()) : null;
    console.log('Lambda response:', result);

    return result;
}

export async function invokeLambdaAsync(functionName: string, data: any) {
    const payload = JSON.stringify(data);
    console.log('Invoking Lambda function asynchronously:', functionName);

    const command = new InvokeCommand({
        FunctionName: functionName,
        Payload: Buffer.from(payload),
        InvocationType: 'Event', // Asynchronous invocation
    });
    const response = await lambda.send(command);
    console.log('Asynchronous Lambda invocation response:', response);

    return response;
}
