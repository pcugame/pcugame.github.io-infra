export function registerCompatibilityRoute(app: any, storage: any) {
	app.get('/api/assets/protected/:storageKey', async (request: any, reply: any) => {
		const location = await storage.presignGet('protected', request.params.storageKey);
		return reply.redirect(location);
	});
}
