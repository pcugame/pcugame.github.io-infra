import { Link } from 'react-router-dom';
import type { PublicProjectCard } from '../../contracts';

interface Props {
  project: PublicProjectCard;
  year: number;
}

export function ProjectCard({ project, year }: Props) {
  return (
    <article className="project-card">
      <div className="project-card__image">
        {project.posterUrl ? (
          <img
            src={project.posterUrl}
            alt={`${project.title} 포스터`}
            loading="lazy"
          />
        ) : (
          <div className="project-card__placeholder">No Image</div>
        )}
      </div>
      <div className="project-card__body">
        <h3 className="project-card__title">{project.title}</h3>
        {project.summary && (
          <p className="project-card__summary">{project.summary}</p>
        )}
        <div className="project-card__members">
          {project.members.map((m, i) => (
            <span key={i} className="project-card__member">
              {m.name}
              <small>({m.studentId})</small>
            </span>
          ))}
        </div>
        <Link
          to={`/years/${year}/${project.slug}`}
          className="btn btn--primary btn--small"
        >
          자세히 보기
        </Link>
      </div>
    </article>
  );
}
