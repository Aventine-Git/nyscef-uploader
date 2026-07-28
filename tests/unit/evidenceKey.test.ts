import { describe, it, expect } from 'vitest';

import { findEvidenceKey } from '../../src/helpers/evidenceKey.ts';

const k = (name: string) => ({ Key: `residential/evidence/2025/S0400-001/${name}` });

describe('findEvidenceKey — evidence type matching', () => {
    it('unequal → matches "sales" AND "fnma"', () => {
        const contents = [k('equity_comps.pdf'), k('sales_comps_fnma.pdf')];
        expect(findEvidenceKey(contents, 'unequal', false)).toContain('sales_comps_fnma.pdf');
    });

    it('unequal + village → matches "village"', () => {
        const contents = [k('sales_comps_fnma.pdf'), k('village_comps_fnma.pdf')];
        expect(findEvidenceKey(contents, 'unequal', true)).toContain('village_comps_fnma.pdf');
    });

    it('excessive → matches "equity"', () => {
        const contents = [k('sales_comps_fnma.pdf'), k('equity_comps.pdf')];
        expect(findEvidenceKey(contents, 'excessive', false)).toContain('equity_comps.pdf');
    });

    it('returns undefined when nothing matches', () => {
        expect(findEvidenceKey([k('loa_report.pdf')], 'excessive', false)).toBeUndefined();
    });

    it('tolerates an undefined listing', () => {
        expect(findEvidenceKey(undefined, 'unequal', false)).toBeUndefined();
    });
});

describe('findEvidenceKey — mapless (_nomaps) reports are never filed', () => {
    it('prefers the map-bearing report over its _nomaps sibling', () => {
        const contents = [k('equity_comps.pdf'), k('equity_comps_nomaps.pdf')];
        expect(findEvidenceKey(contents, 'excessive', false)).toContain('equity_comps.pdf');
    });

    // Guards against relying on '.' (0x2E) sorting before '_' (0x5F) in the S3 listing.
    it('skips _nomaps even when it is listed first', () => {
        const contents = [k('equity_comps_nomaps.pdf'), k('equity_comps.pdf')];
        expect(findEvidenceKey(contents, 'excessive', false)).toContain('equity_comps.pdf');
    });

    it('returns undefined rather than the _nomaps report when it is the only match', () => {
        expect(findEvidenceKey([k('equity_comps_nomaps.pdf')], 'excessive', false)).toBeUndefined();
    });

    it('skips a village _nomaps report', () => {
        const contents = [k('village_comps_nomaps.pdf'), k('village_comps_fnma.pdf')];
        expect(findEvidenceKey(contents, 'unequal', true)).toContain('village_comps_fnma.pdf');
    });
});
