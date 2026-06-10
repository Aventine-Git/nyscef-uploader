import { test } from '@playwright/test';
import { invokeLambda } from '@shared/lambda.js';

test.describe('NYSCEF Upload - Remote Invoke', () => {
    test('Invoke nyscef-uploader lambda in test mode', async () => {
        test.setTimeout(60000 * 5); // 5 minutes

        const payload = {
            documents: [
                { scarID: '94188/2025', parcelID: 'W5001-004-001-00376-000-0000', year: 2025, negotiatorID: 16, isVillage: false, evidenceTypes: ['unequal', 'excessive'] },
                { scarID: '94225/2025', parcelID: 'W5001-016-003-0001A-000-0001', year: 2025, negotiatorID: 16, isVillage: false, evidenceTypes: ['unequal', 'excessive'] },
                { scarID: '94238/2025', parcelID: 'W5001-018-002-00043-000-0000', year: 2025, negotiatorID: 16, isVillage: false, evidenceTypes: ['unequal', 'excessive'] },
                { scarID: '94261/2025', parcelID: 'W5001-023-002-00018-000-0000', year: 2025, negotiatorID: 16, isVillage: false, evidenceTypes: ['unequal', 'excessive'] },
            ],
            testing: true,
        };

        const result = await invokeLambda('nyscef-uploader', payload);
        console.log('Lambda result:', result);
    });
});
