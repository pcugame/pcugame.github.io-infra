import type { PublicProjectCard } from '../../contracts';

interface Props {
  project: PublicProjectCard;
  year: number;
  onSelect?: (slug: string) => void;
}

export function ProjectCard({ project, onSelect }: Props) {
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
        <h3 className="archive-card__title">{project.title}</h3>
        {project.summary && (
          <p className="archive-card__summary">{project.summary}</p>
        )}
        <div className="archive-card__footer">
          <p className="archive-card__members">
            {project.members.map((m) => m.studentId ? `${m.studentId} - ${m.name}` : m.name).join(' · ')}
          </p>
        </div>
      </div>
    </button>
  );
}
