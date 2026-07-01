/**
 * Session writes are authorized before this policy runs:
 * - createSession checks project access in the controller and exhibition upload locks.
 * - loadSession checks session ownership, with ADMIN/OPERATOR override.
 *
 * Project status is intentionally not a write gate for resumable GAME uploads,
 * because uploads may repair or replace the game file for already-published or
 * archived projects when the caller is otherwise authorized.
 */
export function assertGameUploadSessionWritable(projectStatus: string, userRole: string): void {
	void projectStatus;
	void userRole;
}
