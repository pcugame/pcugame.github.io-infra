import { awardTone } from '../../../components/project/awardTone';
import type { Award } from '@pcu/contracts';
import { AwardIcon } from '../../../components/project/AwardIcon';

export function AwardImage({ award }: { award: Award }) {
  return <span className="award-badge" data-award-tone={awardTone(award)}><AwardIcon award={award} /><span>{award.name}</span></span>;
}
