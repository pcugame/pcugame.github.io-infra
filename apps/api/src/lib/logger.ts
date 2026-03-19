import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env().LOG_LEVEL,
  ...(env().NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});
