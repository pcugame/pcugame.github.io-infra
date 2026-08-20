declare const app: { get(path: string, handler: () => void): void };

app.get('/assets/:storageKey/download', () => {});
