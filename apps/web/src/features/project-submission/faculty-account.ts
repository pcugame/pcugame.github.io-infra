/** UI defaults only: this pattern must never grant permissions. */
export function isFacultyAccount(email: string | undefined): boolean {
	return typeof email === 'string' && /^a[0-9]{5}@pcu\.ac\.kr$/i.test(email);
}
