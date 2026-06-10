import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsManager = new SecretsManagerClient({ region: 'us-east-1' });

export async function getSecret<T = Record<string, string>>(secretId: string): Promise<T> {
    const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!result.SecretString) throw new Error(`Secret '${secretId}' has no SecretString value (may be a binary secret)`);
    return JSON.parse(result.SecretString) as T;
}

export async function updateSecret<T = Record<string, string>>(secretId: string, value: T): Promise<void> {
    await secretsManager.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: JSON.stringify(value) }));
}
