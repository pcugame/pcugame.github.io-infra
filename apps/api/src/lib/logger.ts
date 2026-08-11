import pino from 'pino';
import type { AppLogger } from '../application/ports.js';

export interface LoggerConfig {
	LOG_LEVEL: string;
	NODE_ENV: string;
}

/** Create an isolated root logger for a BackendContext from explicit config. */
export function createRootLogger(config: LoggerConfig): AppLogger {
	return pino({
		level: config.LOG_LEVEL,
		...(config.NODE_ENV === 'development'
			? { transport: { target: 'pino-pretty', options: { colorize: true } } }
			: {}),
	});
}
