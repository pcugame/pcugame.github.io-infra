// Release probes never submit a case or consume a generation slot.
import { execFileSync } from 'node:child_process';
import { readLabConfig } from './modules/benchmark-worker/config.js';
import { parseGenerateHealth, readGenerateHealth } from './modules/benchmark-worker/status.js';

try {
	if (process.argv[2] === '--ssh') {
		const model = process.env.LAB_MODEL;
		if (!model) throw new Error('Expected model ID is missing');
		const response = execFileSync('/usr/bin/ssh', [
			'-F', '/etc/ssh/pcu-lab.conf', '-T', '-W', '127.0.0.1:8088', 'gameserver-model',
		], {
			input: 'GET /health HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n',
			timeout: 10000, maxBuffer: 16384, encoding: 'utf8',
		});
		const end = response.indexOf('\r\n\r\n');
		if (end < 0 || !/^HTTP\/1\.[01] 200 /.test(response)) throw new Error('Unexpected HTTP response');
		parseGenerateHealth(model, JSON.parse(response.slice(end + 4)));
	} else {
		const config = readLabConfig();
		if (!config.enabled || config.provider !== 'transformers-generate') throw new Error('Missing 4B configuration');
		await readGenerateHealth(config, AbortSignal.timeout(5000));
	}
	console.log('Private 4B model identity and generation limits verified');
} catch {
	console.error('Private model health check failed');
	process.exitCode = 1;
}
