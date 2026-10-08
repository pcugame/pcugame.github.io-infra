import { Link } from 'react-router-dom';
import { ProjectSubmissionForm } from '../../components/project';

export default function AdminProjectNewPage() {
  return <><div className="submission-studio-entry"><Link to="/admin/projects/new/studio" className="btn btn--secondary btn--small">새 업로드 화면 사용하기 ↗</Link></div><ProjectSubmissionForm mode="admin" /></>;
}
