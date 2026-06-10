import { reportIncident, reportStatus } from './reporter.js';

export function withErrorReporting(handler: (event: any, context: any) => Promise<any>) {
    return async (event: any, context: any) => {
        function getErrorOriginFunctionName(error: any): string | undefined {
            if (!error?.stack) return undefined;
            const lines = error.stack.split('\n');
            for (const line of lines.slice(1)) {
                const match = line.match(/at (.+?) /);
                if (match && match[1] !== 'Object.<anonymous>') {
                    return match[1];
                }
            }
            return undefined;
        }
        try {
            const result = await handler(event, context);
            try {
                await reportStatus(context.functionName, 'healthy');
            } catch (statusError) {
                console.error('[withErrorReporting] Failed to report healthy status:', statusError);
            }
            return result;
        } catch (error: any) {
            console.error(`[withErrorReporting] Unhandled error in ${context.functionName}:`, error);

            // Errors with noReport=true are expected transient failures (e.g. Cloudflare blocks)
            // that are already tracked at the DB level and retried by the scheduler. Skip
            // incident reporting to avoid alert spam, but still return a 500 so the caller knows.
            if (error?.noReport === true) {
                try {
                    await reportStatus(context.functionName, 'error', error.message);
                } catch (statusError) {
                    console.error('[withErrorReporting] Failed to report error status:', statusError);
                }
                return {
                    statusCode: 500,
                    body: JSON.stringify({ error: error.message }),
                };
            }

            const component = getErrorOriginFunctionName(error) || context.functionName;
            // Determine severity based on error message content
            function getSeverityFromErrorMessage(msg: string): 'critical' | 'major' | 'minor' {
                const lower = msg.toLowerCase();
                if (lower.includes('out of memory') || lower.includes('fatal') || lower.includes('unhandled') || lower.includes('crash') || lower.includes('timeout')) {
                    return 'critical';
                }
                if (lower.includes('not found') || lower.includes('validation') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('failed')) {
                    return 'major';
                }
                return 'minor';
            }
            const severity = getSeverityFromErrorMessage(error.message || '');
            function getCloudWatchLogUrl(functionName: string, logStreamName: string): string {
                const region = process.env.AWS_REGION || 'us-east-1';
                const encode = (s: string) => encodeURIComponent(s).replace(/%/g, '$25');
                const logGroup = encode(`/aws/lambda/${functionName}`);
                const logStream = encode(logStreamName);
                return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${logGroup}/log-events/${logStream}`;
            }
            try {
                const logUrl = getCloudWatchLogUrl(context.functionName, context.logStreamName);
                await reportIncident(context.functionName, component, severity, `Log stream: ${logUrl}\n\nAn unhandled error occurred: ${error.message}`);
            } catch (notifyError) {
                console.error('[withErrorReporting] Failed to report incident:', notifyError);
            }
            try {
                await reportStatus(context.functionName, 'error', error.message);
            } catch (statusError) {
                console.error('[withErrorReporting] Failed to report error status:', statusError);
            }
            return {
                statusCode: 500,
                body: JSON.stringify({ error: error.message }),
            };
        }
    };
}
