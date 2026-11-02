import type { AwardRepository } from './ports.js';
import { createAwardController } from './controller.js';
import { createAwardService } from './service.js';
export function createAwardGraph(repository: AwardRepository | undefined, origin: string, bucket: string) {
 const unavailable = async (): Promise<never> => { throw new Error('Award persistence unavailable'); };
 return createAwardController(createAwardService(repository ?? { read: unavailable, mutate: unavailable }, origin, bucket));
}
