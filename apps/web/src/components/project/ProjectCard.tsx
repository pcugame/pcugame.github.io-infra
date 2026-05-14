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

  // Reset to base (large) state whenever the title changes so measurement
  // always happens at the large font-size, not the already-shrunk one.
  useLayoutEffect(() => {
    setIsMultiLine(false);
  }, [project.title]);

  // After confirming base state, measure whether text wraps.
  useLayoutEffect(() => {
    if (isMultiLine) return;
    const el = titleRef.current;
    if (!el) return;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
    if (el.scrollHeight > Math.ceil(lineHeight) + 2) {
      setIsMultiLine(true);
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
        <h3
          ref={titleRef}
          className={`archive-card__title${isMultiLine ? ' archive-card__title--multiline' : ''}`}
        >
          {project.title}
        </h3>
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
