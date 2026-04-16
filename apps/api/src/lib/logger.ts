import pino from 'pino';
import { env } from '../config/env.js';

let _logger: pino.Logger | undefined;

export function logger(): pino.Logger {
	if (!_logger) {
		const e = env();
		_logger = pino({
			level: e.LOG_LEVEL,
			...(e.NODE_ENV === 'development'
				? { transport: { target: 'pino-pretty', options: { colorize: true } } }
				: {}),
		});
	}
	return _logger;
}
