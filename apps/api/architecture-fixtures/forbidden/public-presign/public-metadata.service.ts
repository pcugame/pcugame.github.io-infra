export async function serialize(deps: { presign(): Promise<string> }) {
	return { url: await deps.presign() };
}
