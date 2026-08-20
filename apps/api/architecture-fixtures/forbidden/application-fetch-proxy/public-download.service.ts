export async function proxyObject(url: string): Promise<Response> {
	return fetch(url);
}
