import type { PublicProjectCard } from '../../contracts';

interface Props {
  project: PublicProjectCard;
  year: number;
  onSelect?: (slug: string) => void;
}

export function ProjectCard({ project, onSelect }: Props) {
  const isLongTitle = project.title.length > 22;

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
            className={`archive-card__title${isLongTitle ? ' archive-card__title--multiline' : ''}`}
          >
            {project.title}
          </h3>
        </div>
        {project.summary && (
          <p className="archive-card__summary">{project.summary}</p>
        )}
        <div className="archive-card__footer">
          <div className="archive-card__members">
            {project.members.slice(0, 2).map((m) => (
              <span key={m.studentId ?? m.name} className="archive-card__member-pill">
                {m.studentId ? `${m.studentId} ${m.name}` : m.name}
              </span>
            ))}
            {project.members.length > 2 && (
              <span className="archive-card__member-pill archive-card__member-pill--more">
                +{project.members.length - 2}
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}
