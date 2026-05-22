const STUDENT_ID_LOCAL_PART = /^\d{6,20}$/;

export function extractStudentIdFromEmail(email: string): string | undefined {
	const localPart = email.split('@')[0]?.trim();
	if (!localPart || !STUDENT_ID_LOCAL_PART.test(localPart)) return undefined;
	return localPart;
}
