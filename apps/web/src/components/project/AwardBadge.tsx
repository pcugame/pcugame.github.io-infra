import { awardStyle, awardTone, orderedAwards } from './awardTone';
import type { Award } from '@pcu/contracts';
import { AwardIcon } from './AwardIcon';

export function AwardBadge({ award }: { award: Award }) {
  return (
    <span className="project-award" data-award-tone={awardTone(award)} style={awardStyle(award)}>
      <AwardIcon award={award} className="project-award__icon" />
      <span>{award.name}</span>
    </span>
  );
}

export function ProjectAwards({ awards }: { awards?: Award[] }) {
  if (!awards?.length) return null;
  return (
    <div className="project-awards" role="group" aria-label="수상 내역">
      {orderedAwards(awards).map(award => <AwardBadge key={award.id} award={award} />)}
    </div>
  );
}
