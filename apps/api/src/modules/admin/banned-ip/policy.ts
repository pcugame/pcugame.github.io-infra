export function isBanActive(record: { source: string; disabledAt: Date | null }, autoEnabled: boolean): boolean {
 return record.disabledAt === null && (record.source !== 'AUTO' || autoEnabled);
}
