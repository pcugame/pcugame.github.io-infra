export async function issue(deps: {
	presign(): Promise<string>;
	logger: { info(context: object, message: string): void };
}): Promise<void> {
	const url = await deps.presign();
	deps.logger.info({ url }, 'issued');
	deps.logger.info({ capability: await deps.presign() }, 'issued-inline');
}
