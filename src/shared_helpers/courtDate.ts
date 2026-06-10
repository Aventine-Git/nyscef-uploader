export async function getCourtDate(parcelID: string, year: number): Promise<Date | null> {
    const url = `https://utils.aventine.ai/court-cases/search?page=1&page_size=20&query=${parcelID}&case_year=${year}`;
    const apiKey = process.env.CALENDAR_API_KEY!;

    try {
        const response = await fetch(url, {
            mode: 'cors',
            headers: {
                'x-api-key': apiKey,
            },
        });
        if (!response.ok) {
            console.error(`❌ Failed to fetch court date for ${parcelID} (${year}) — HTTP ${response.status}`);
            return null;
        }
        const data = await response.json();
        const courtDate = data.data[0];
        const cases = courtDate.cases || [];
        if (cases.length === 0) {
            console.warn(`⚠️ No court cases found for ${parcelID} (${year})`);
            return null;
        }
        const adjDate = cases.find((c: any) => c.ParcelID === parcelID)?.adjournment;
        const date = adjDate ? new Date(adjDate) : new Date(courtDate.CourtDate);
        return date;
    } catch (error) {
        console.error(`❌ Error fetching court date for ${parcelID} (${year}):`, error);
        return null;
    }
}
