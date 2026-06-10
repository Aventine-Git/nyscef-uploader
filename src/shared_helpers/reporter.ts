import fetch from 'node-fetch';

export async function reportStatus(lambda: string, status: 'error' | 'healthy', message?: string) {
    const endpoint = 'https://nyscef.aventine.ai/automation/status';
    const statusMessage = {
        source: 'Lambdas',
        scraper_name: lambda,
        status: status,
        message: message || 'No Message Provided',
    };
    console.log(JSON.stringify(statusMessage));
    const result = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(statusMessage),
    });
    if (!result.ok) {
        throw new Error(`Failed to report status: ${result.statusText}`);
    }
    console.log(`Status reported successfully for ${lambda}`);
}

export async function reportIncident(lambda: string, component: string, severity: 'critical' | 'major' | 'minor', message: string) {
    const endpoint = 'https://nyscef.aventine.ai/automation/incidents';
    const incidentMessage = {
        title: `${lambda} - ${component} has encountered an issue`,
        source: lambda,
        component: component,
        severity: severity,
        message: message,
    };
    console.log(JSON.stringify(incidentMessage));
    const result = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(incidentMessage),
    });
    if (!result.ok) {
        throw new Error(`Failed to report incident: ${result.statusText}`);
    }
    console.log(`Incident reported successfully for ${lambda} - ${component}`);
}
