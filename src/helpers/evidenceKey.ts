/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Pick the evidence PDF to file for a given evidence type from an S3 prefix listing.
 *
 * The comp generator writes a mapless variant alongside the map-bearing report
 * (e.g. `equity_comps_nomaps.pdf` next to `equity_comps.pdf`). NYSCEF filings always use the
 * map-bearing one, so `_nomaps` files are dropped before matching — relying on `.` (0x2E)
 * sorting before `_` (0x5F) in the listing would make this order-dependent.
 */
export function findEvidenceKey(
    contents: { Key?: string }[] | undefined,
    kind: 'unequal' | 'excessive',
    isVillage: boolean
): string | undefined {
    const candidates = (contents ?? []).filter((item: any) => !item.Key?.includes('_nomaps'));
    if (kind === 'excessive') {
        return candidates.find((item: any) => item.Key?.includes('equity'))?.Key;
    }
    return isVillage
        ? candidates.find((item: any) => item.Key?.includes('village'))?.Key
        : candidates.find((item: any) => item.Key?.includes('sales') && item.Key?.includes('fnma'))?.Key;
}
