declare const app: {
	post(path: string, handler: (payload: NodeJS.ReadableStream) => Promise<void>): void;
};

app.post('/game-upload-sessions/:id/part-urls', async (_payload: NodeJS.ReadableStream) => {});
