export function normalizeMarketplace(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    return value;
}
