import type { FastifyPluginAsync } from 'fastify';
import type { AppLogger, AuthSessionStore, Clock, GoogleTokenVerifier, IdGenerator } from '../../application/ports.js';
import type { Env } from '../../config/env.js';
import { createDevAuthController } from '../dev-auth/controller.js';
import { createAuthController } from './controller.js';
import { createAuthService, type AuthRepository } from './service.js';

export interface AuthProductionRepository extends AuthRepository, AuthSessionStore {
	purgeExpired(before: Date): Promise<number>;
}

export interface AuthProductionGraph {
	repository: AuthProductionRepository;
	service: ReturnType<typeof createAuthService>;
	authController: FastifyPluginAsync;
	devAuthController: FastifyPluginAsync;
}

/** Compose one auth vertical slice entirely from one BackendContext's inputs. */
export function createAuthProductionGraph(deps: {
	config: Env;
	repository: AuthProductionRepository;
	googleTokens: GoogleTokenVerifier;
	clock: Clock;
	ids: IdGenerator;
	logger: AppLogger;
}): AuthProductionGraph {
	const repository = deps.repository;
	const service = createAuthService({
		repository,
		googleTokens: deps.googleTokens,
		clock: deps.clock,
		ids: deps.ids,
		sessionAbsoluteMs: deps.config.SESSION_ABSOLUTE_MS,
		googleClientIds: deps.config.GOOGLE_CLIENT_IDS,
		allowedGoogleHostedDomain: deps.config.ALLOWED_GOOGLE_HD,
		logger: deps.logger,
	});
	return {
		repository,
		service,
		authController: createAuthController({
			config: deps.config,
			clock: deps.clock,
			service,
		}),
		devAuthController: createDevAuthController({
			config: deps.config,
			clock: deps.clock,
			service,
		}),
	};
}
