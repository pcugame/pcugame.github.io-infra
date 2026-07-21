import * as projectRepository from '../project/repository.js';
import { prisma } from '../../../lib/prisma.js';
import { createMemberRepository } from './repository.js';
import { createMemberService } from './service.js';

export const memberService = createMemberService({
	projectExists: async (projectId) => await projectRepository.findProjectById(projectId) !== null,
	repository: createMemberRepository(prisma),
});
