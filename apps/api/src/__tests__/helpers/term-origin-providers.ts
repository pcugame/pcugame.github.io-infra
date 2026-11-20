import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { LabCase } from '@pcu/contracts';

// This is a fixture for the provider wire protocol. Only this test can start it.
export function createProviderFixture() {
	let invalid = false;
	async function respond(request: IncomingMessage, response: ServerResponse) {
		const url = new URL(request.url!, 'http://localhost');
		let body: unknown;
		if (url.pathname === '/v1/models') body = { data: [{ id: 'fixture-8b' }] };
		else if (url.pathname === '/config') body = { engines: [], formats: ['json'] };
		else if (url.pathname === '/search')
			body = {
				results: [
					{
						title: 'Synthetic test excerpt',
						url: 'https://example.org/test-source',
						content: 'Synthetic source for the fixture.',
					},
				],
			};
		else if (url.pathname === '/v1/chat/completions') {
			const parts: Buffer[] = [];
			for await (const part of request) parts.push(Buffer.from(part));
			const chat = JSON.parse(Buffer.concat(parts).toString());
			const research = JSON.parse(chat.messages[1].content) as { case: LabCase; sources?: { id: string }[] };
			const toolCount = chat.messages.filter((m: { role: string }) => m.role === 'tool').length;
			const tool = toolCount
				? { name: 'web_open', arguments: '{"sourceId":"S1"}' }
				: { name: 'web_search', arguments: JSON.stringify({ query: research.case.term }) };
			const message = chat.tools
				? toolCount < 2
					? { content: null, tool_calls: [{ id: 't' + toolCount, type: 'function', function: tool }] }
					: { content: 'Done' }
				: {
						content: invalid
							? '{}'
							: JSON.stringify({
									schemaVersion: '1',
									caseId: research.case.id,
									term: research.case.term,
									language: research.case.language,
									originSummary: 'Fixture, origin unknown',
									earliestAttestation: null,
									controversySummary: 'Fixture context',
									controversyScore: null,
									controversyReason: 'Insufficient evidence',
									originConfidence: 0.1,
									sourceIds: (research.sources ?? []).map((s) => s.id),
									uncertainties: ['Synthetic inference'],
									abstained: true,
								}),
					};
			body = { choices: [{ message }] };
		} else {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
	}
	const server = createServer((req, reply) => {
		void respond(req, reply).catch(() => reply.writeHead(500).end());
	});
	return {
		server,
		setInvalid(value: boolean) {
			invalid = value;
		},
	};
}
