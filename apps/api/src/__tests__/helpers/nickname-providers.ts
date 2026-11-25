import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import assert from 'node:assert/strict';

// This is a fixture for the provider wire protocol. Only this test can start it.
export function createProviderFixture() {
	let invalid = false;
	const requests: string[] = [];
	async function respond(request: IncomingMessage, response: ServerResponse) {
		const url = new URL(request.url!, 'http://localhost');
		let body: unknown;
		if (url.pathname === '/v1/models') body = { data: [{ id: 'fixture-8b' }] };
		else if (url.pathname === '/config') body = { engines: [], formats: ['json'] };
		else if (url.pathname === '/search') {
			requests.push(url.toString());
			body = {
				results: [
					{
						title: 'Synthetic test excerpt for ' + url.searchParams.get('q'),
						url: 'https://example.org/test-source',
						content: 'Synthetic source for the fixture.',
					},
				],
			};
		} else if (url.pathname === '/v1/chat/completions') {
			const parts: Buffer[] = [];
			for await (const part of request) parts.push(Buffer.from(part));
			const wire = Buffer.concat(parts).toString();
			requests.push(wire);
			const chat = JSON.parse(wire);
			const research = JSON.parse(chat.messages[1].content) as {
				case: { nickname: string };
				sources?: { id: string }[];
			};
			assert.deepEqual(Object.keys(research.case).sort(), ['nickname']);
			const toolCount = chat.messages.filter((m: { role: string }) => m.role === 'tool').length;
			const tool = toolCount
				? { name: 'web_open', arguments: '{"sourceId":"S1"}' }
				: {
						name: 'web_search',
						arguments: JSON.stringify({ query: research.case.nickname }),
					};
			const message = chat.tools
				? toolCount < 2
					? { content: null, tool_calls: [{ id: 't' + toolCount, type: 'function', function: tool }] }
					: { content: 'Done' }
				: {
						content: invalid
							? '{}'
							: JSON.stringify({
									schemaVersion: '2',
									nickname: research.case.nickname,
									interpretedTerm: null,
									reason: 'Synthetic evidence-based hypothesis',
									score: research.case.nickname.includes('모호') ? null : 62,
									confidence: 0.4,
									sourceIds: (research.sources ?? []).map((s) => s.id),
									abstained: research.case.nickname.includes('모호'),
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
		requests,
		setInvalid(value: boolean) {
			invalid = value;
		},
	};
}
