export const awardInclude = { include: { award: { include: { asset: { include: { representations: true } } } } } } as const;
