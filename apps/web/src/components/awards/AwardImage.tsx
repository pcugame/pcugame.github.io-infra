import type { Award } from '@pcu/contracts';
import { AwardIcon } from '../project/AwardIcon';

export function AwardImage({ award }: { award: Award }) {
  return <span className="award-badge"><AwardIcon award={award} /><span>{award.name}</span></span>;
}
