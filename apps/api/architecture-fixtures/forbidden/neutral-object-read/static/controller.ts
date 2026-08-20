type Reply = {
	send(body: Buffer): void;
};

export async function load(deps: {
	transport: { readRange(start: number, end: number): Promise<Buffer> };
}, reply: Reply): Promise<void> {
	// Receiver names are not authority: naming an injected object reader like a
	// local file adapter must not bypass the client-delivery boundary.
	const fileSystem = deps.transport;
	const { readRange: pull } = fileSystem;
	const chunks: Buffer[] = [];
	for (let offset = 0; offset < 4096; offset += 1024) {
		chunks.push(await pull(offset, offset + 1023));
	}
	reply.send(Buffer.concat(chunks));
}
