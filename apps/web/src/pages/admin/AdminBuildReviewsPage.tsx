import { BuildReviewPanel } from '../../features/admin/build-reviews/BuildReviewPanel';
export default function AdminBuildReviewsPage() {
	return (
		<div className="admin-project-edit-page">
			<h1>게임·웹 빌드 검토</h1>
			<BuildReviewPanel />
		</div>
	);
}
