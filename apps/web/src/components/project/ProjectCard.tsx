import { useLayoutEffect, useRef, useState } from 'react';
import type { PublicProjectCard } from '../../contracts';

interface Props {
  project: PublicProjectCard;
  year: number;
  onSelect?: (slug: string) => void;
}

export function ProjectCard({ project, onSelect }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [isMultiLine, setIsMultiLine] = useState(false);
  // Prevents re-entering the measurement loop once we've decided to stay large
  // after confirming the small font also fits in 1 line.
  const decided = useRef(false);

  useLayoutEffect(() => {
    setIsMultiLine(false);
    decided.current = false;
  }, [project.title]);

  useLayoutEffect(() => {
    if (decided.current) return;
    const el = titleRef.current;
    if (!el) return;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
    const wraps = el.scrollHeight > Math.ceil(lineHeight) + 2;

    if (!isMultiLine) {
      // Phase 1: measuring at large font — does it wrap?
      if (wraps) setIsMultiLine(true);
    } else {
      // Phase 2: measuring at small font — does it still need 2 lines?
      // If not, go back to large (text will be clipped to 1 line by the wrapper).
      if (!wraps) {
        decided.current = true;
        setIsMultiLine(false);
      }
    }
  }, [isMultiLine, project.title]);

  return (
    <button
      type="button"
      className="archive-card"
      onClick={() => onSelect?.(project.slug)}
    >
      <div className="archive-card__image">
        {project.posterUrl ? (
          <img
            src={project.posterUrl}
            alt={`${project.title} 포스터`}
            loading="lazy"
          />
        ) : (
          <div className="archive-card__placeholder" aria-hidden="true">
            <span>{project.title.charAt(0)}</span>
          </div>
        )}
      </div>
      <div className="archive-card__body">
        <div className="archive-card__title-wrap">
          <h3
            ref={titleRef}
            className={`archive-card__title${isMultiLine ? ' archive-card__title--multiline' : ''}`}
          >
            {project.title}
          </h3>
        </div>
        {project.summary && (
          <p className="archive-card__summary">{project.summary}</p>
        )}
        <div className="archive-card__footer">
          <div className="archive-card__members">
            {project.members.map((m) => (
              <span key={m.studentId ?? m.name} className="archive-card__member-pill">
                {m.studentId ? `${m.studentId} ${m.name}` : m.name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </button>
  );
}
