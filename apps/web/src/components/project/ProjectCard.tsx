import { Link } from 'react-router-dom';
import type { PublicProjectCard } from '../../contracts';

interface Props {
  project: PublicProjectCard;
  year: number;
}

export function ProjectCard({ project, year }: Props) {
  return (
    <Link
      to={`/years/${year}/${project.slug}`}
      className="archive-card"
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
            {project.members.map((m) => m.name).join(' · ')}
          </p>
        </div>
      </div>
    </Link>
  );
}
