import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export type ControlCommand = 'status' | 'quiesce' | 'resume';
export type ControlScope = 'all' | 'http' | 'maintenance';
export const controlSocket = '/tmp/pcu-runtime-control.sock';

/** No TCP listener, request body, shell execution, or public Fastify route. */
export async function listenControl(
	handle: (command: ControlCommand, scope: ControlScope) => unknown | Promise<unknown>,
	path = controlSocket,
) {
	const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
		const match = /^\/(status|quiesce|resume)\/(all|http|maintenance)$/.exec(req.url ?? '');
		if (req.method !== 'POST' || !match) { res.writeHead(400).end(); return; }
		try {
			const value = await handle(match[1] as ControlCommand, match[2] as ControlScope);
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(value));
		} catch {
			res.writeHead(500).end('{"error":"control failed"}');
		}
	};
	const server = createServer((req, res) => { void handleRequest(req, res); });
	server.requestTimeout = 5_000;
	server.headersTimeout = 5_000;
	// Never remove a socket owned by a possibly live process.
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(path, () => { server.off('error', reject); resolve(); });
	});
	try {
		await chmod(path, 0o600);
	} catch (error) {
		await new Promise<void>(resolve => server.close(() => resolve()));
		throw error;
	}
	return async () => {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		await unlink(path).catch(() => undefined);
	};
}

export function sendControl(command: ControlCommand, scope: ControlScope = 'all', path = controlSocket): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const req = request({ socketPath: path, path: `/${command}/${scope}`, method: 'POST' }, res => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', chunk => { body += chunk; });
			res.on('end', () => {
				try {
					if (res.statusCode !== 200) throw new Error('Runtime control rejected command');
					resolve(JSON.parse(body));
				} catch (error) { reject(error); }
			});
			res.on('error', reject);
		});
		req.setTimeout(5_000, () => req.destroy(new Error('Runtime control timed out')));
		req.on('error', reject);
		req.end();
	});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const command = process.argv[2];
	const scope = process.argv[3] ?? 'all';
	if (!['status', 'quiesce', 'resume'].includes(command ?? '') || !['all', 'http', 'maintenance'].includes(scope)) {
		console.error('Expected status|quiesce|resume [all|http|maintenance]');
		process.exitCode = 1;
	} else {
		void sendControl(command as ControlCommand, scope as ControlScope).then(
			value => console.log(JSON.stringify(value)),
			error => { console.error(error); process.exitCode = 1; },
		);
	}
}
