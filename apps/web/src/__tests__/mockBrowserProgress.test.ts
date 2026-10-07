/* @vitest-environment jsdom */
import { afterEach, expect, it } from 'vitest';
import { clearMockBrowserProgress } from '../lib/api/mock/browser-progress';
afterEach(()=>sessionStorage.clear());
it('clears stale submission and upload pointers after reset while retaining unrelated preferences',()=>{
 sessionStorage.setItem('pcu.pending-project-submission:me','old project');
 sessionStorage.setItem('pcu.pending-project-submission:me:3','old owner project');
 sessionStorage.setItem('pcu.direct-asset-upload:1:GAME','old session');
 for(const kind of ['image','poster','video','document','attachment'])sessionStorage.setItem(`pcu.direct-${kind}-upload:PROJECT:1`,'old media session');
 sessionStorage.setItem('editor.preference','keep');
 clearMockBrowserProgress(sessionStorage);
 expect(sessionStorage.length).toBe(1);expect(sessionStorage.getItem('editor.preference')).toBe('keep');
});
