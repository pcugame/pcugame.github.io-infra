// A project dialog owns presentation while its individual transfers keep running.
const owners = new Set<symbol>();
const listeners = new Set<() => void>();
export const subscribeUploadPresentation = (listener: () => void) => {
 listeners.add(listener);
 return () => { listeners.delete(listener); };
};
export const hasUploadDialog = () => owners.size > 0;
export function claimUploadPresentation() {
 const owner = Symbol();
 owners.add(owner);
 listeners.forEach(listener => listener());
 return () => { owners.delete(owner); listeners.forEach(listener => listener()); };
}
