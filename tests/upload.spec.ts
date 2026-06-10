import { test } from '@playwright/test';
import { handler } from '../src/index.js';

test.describe('NYSCEF Upload', () => {
    test('Upload stipulation to NYSCEF', async () => {
        test.setTimeout(60000 * 3); // 3 minutes
        try {
            // get list of parcel ids using extracted ScarIDs and counties
            // [{"scarID": "ER60176/2025", "parcelID": "P3089-035-000-0001-003-001", "year": 2025, "evidenceTypes": ["unequal", "excessive"]}, {"scarID": "ER60180/2025", "parcelID": "P3089-035-000-0002-043-000", "year": 2025, "evidenceTypes": ["unequal"]}, {"scarID": "ER60182/2025", "parcelID": "P3089-045-016-0001-015-000", "year": 2025, "evidenceTypes": ["unequal", "excessive"]}, {"scarID": "ER60184/2025", "parcelID": "P3089-045-060-0001-004-000", "year": 2025, "evidenceTypes": ["unequal", "excessive"]}, {"scarID": "ER60189/2025", "parcelID": "P3089-046-000-0002-051-000-1503", "year": 2025, "evidenceTypes": ["unequal", "excessive"]}]
            const event3 = {
                documents: [
                    { scarID: '070697/2025', parcelID: 'R2401-071-030-0001-013-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070698/2025', parcelID: 'R2401-071-030-0001-014-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070703/2025', parcelID: 'R2401-071-078-0001-006-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070720/2025', parcelID: 'R2403-066-037-0001-034-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070729/2025', parcelID: 'R2405-074-084-0001-019-002-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070731/2025', parcelID: 'R2405-075-030-0001-019-000-0002', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070732/2025', parcelID: 'R2405-075-038-0002-007-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070736/2025', parcelID: 'R2405-075-054-0001-052-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070744/2025', parcelID: 'R2405-075-056-0001-001-000-5509', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070745/2025', parcelID: 'R2405-075-056-0001-001-000-5521', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070752/2025', parcelID: 'R2405-075-056-0001-001-000-8213', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070756/2025', parcelID: 'R2405-075-062-0001-001-003-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070759/2025', parcelID: 'R2489-063-019-0001-002-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070760/2025', parcelID: 'R2489-063-019-0001-012-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070761/2025', parcelID: 'R2489-063-019-0001-015-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070762/2025', parcelID: 'R2489-063-019-0001-017-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070763/2025', parcelID: 'R2489-063-019-0001-026-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070764/2025', parcelID: 'R2489-063-019-0001-027-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070770/2025', parcelID: 'R2489-064-018-0001-071-002-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070771/2025', parcelID: 'R2489-064-018-0001-078-001-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070772/2025', parcelID: 'R2489-064-018-0001-078-003-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070773/2025', parcelID: 'R2489-064-018-0001-078-007-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070775/2025', parcelID: 'R2489-064-018-0002-035-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070777/2025', parcelID: 'R2489-064-020-0001-024-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070778/2025', parcelID: 'R2489-064-020-0001-031-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070780/2025', parcelID: 'R2489-065-019-0001-010-001-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070781/2025', parcelID: 'R2489-065-019-0001-013-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070782/2025', parcelID: 'R2489-065-019-0001-017-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070786/2025', parcelID: 'R2489-065-020-0001-014-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070790/2025', parcelID: 'R2489-066-070-0002-020-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070798/2025', parcelID: 'R2489-068-012-0006-024-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070801/2025', parcelID: 'R2489-068-015-0001-015-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070803/2025', parcelID: 'R2489-068-015-0002-046-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070804/2025', parcelID: 'R2489-068-015-0002-068-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070809/2025', parcelID: 'R2489-068-016-0003-047-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070812/2025', parcelID: 'R2489-068-016-0005-057-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070813/2025', parcelID: 'R2489-068-019-0001-001-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070814/2025', parcelID: 'R2489-068-019-0003-039-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070824/2025', parcelID: 'R2489-069-008-0001-012-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070827/2025', parcelID: 'R2489-069-012-0001-007-008-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070832/2025', parcelID: 'R2489-069-014-0003-013-004-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070834/2025', parcelID: 'R2489-069-016-0003-001-004-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070839/2025', parcelID: 'R2489-069-017-0002-027-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070842/2025', parcelID: 'R2489-069-018-0001-043-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070843/2025', parcelID: 'R2489-069-018-0002-002-001-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070844/2025', parcelID: 'R2489-069-018-0002-029-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070847/2025', parcelID: 'R2489-069-018-0003-001-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070848/2025', parcelID: 'R2489-069-018-0003-011-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070849/2025', parcelID: 'R2489-069-018-0003-038-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070850/2025', parcelID: 'R2489-069-019-0001-052-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070851/2025', parcelID: 'R2489-070-006-0001-001-004-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070853/2025', parcelID: 'R2489-070-006-0001-050-001-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070854/2025', parcelID: 'R2489-070-006-0001-062-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070855/2025', parcelID: 'R2489-070-007-0001-018-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070858/2025', parcelID: 'R2489-070-009-0002-039-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070859/2025', parcelID: 'R2489-070-009-0003-002-001-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070863/2025', parcelID: 'R2489-070-009-0003-050-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070865/2025', parcelID: 'R2489-070-010-0001-074-008-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070866/2025', parcelID: 'R2489-070-011-0001-005-001-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070867/2025', parcelID: 'R2489-070-011-0001-005-004-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070869/2025', parcelID: 'R2489-070-011-0001-010-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070871/2025', parcelID: 'R2489-070-013-0001-023-007-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070873/2025', parcelID: 'R2489-070-014-0003-006-002-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070875/2025', parcelID: 'R2489-070-015-0001-024-001-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070877/2025', parcelID: 'R2489-070-015-0002-003-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070882/2025', parcelID: 'R2489-071-005-0001-032-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070887/2025', parcelID: 'R2489-071-009-0001-036-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070895/2025', parcelID: 'R2489-071-017-0001-019-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070896/2025', parcelID: 'R2489-071-017-0001-028-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070897/2025', parcelID: 'R2489-072-008-0001-036-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070908/2025', parcelID: 'R2489-073-005-0001-053-000-2208', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070914/2025', parcelID: 'R2489-074-012-0001-005-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070920/2025', parcelID: 'R2489-074-013-0003-077-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070931/2025', parcelID: 'R2489-074-018-0001-018-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070935/2025', parcelID: 'R2489-074-020-0003-042-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070936/2025', parcelID: 'R2489-075-005-0001-001-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070938/2025', parcelID: 'R2489-077-005-0002-023-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070939/2025', parcelID: 'R2489-077-005-0002-044-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070940/2025', parcelID: 'R2489-077-005-0002-054-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070941/2025', parcelID: 'R2489-077-006-0002-020-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070942/2025', parcelID: 'R2489-077-007-0002-003-003-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070943/2025', parcelID: 'R2489-077-008-0003-077-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070944/2025', parcelID: 'R2489-077-008-0005-033-001-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070945/2025', parcelID: 'R2489-077-009-0001-011-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070947/2025', parcelID: 'R2489-077-010-0003-033-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070950/2025', parcelID: 'R2489-077-012-0001-034-015-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070959/2025', parcelID: 'R2489-078-013-0001-003-003-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070962/2025', parcelID: 'R2489-078-017-0002-012-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070963/2025', parcelID: 'R2489-078-018-0001-020-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070968/2025', parcelID: 'R2489-078-018-0002-012-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                    { scarID: '070971/2025', parcelID: 'R2489-080-005-0001-035-000-0000', year: 2025, negotiatorID: 10, isVillage: false, evidenceTypes: ['unequal'] },
                ],
                testing: true,
                forceUpload: true,
            };

            const context = {
                logStreamName: 'test-log-stream',
                awsRequestId: 'test-request-id',
            };

            // upload to NYSCEF
            await handler({ body: JSON.stringify({ ...event3, testing: true, forceUpload: true }), requestContext: { httpMethod: 'POST' } }, context);
        } catch (error) {
            console.error('Test failed with error:', error);
            throw error;
        }
    });
});
