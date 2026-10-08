import { handleVoting } from './voting';
import { MOCK_USERS, MockHttpError, UNHANDLED, type MockContext, type MockRequestOptions, type MockUserSelection } from './context';
import { allowMethod, bodyObject } from './common';
import { handleProjects } from './projects';
import { handleUploads, advanceUploadJobs } from './uploads';
import { handleChanges, advanceChangeJobs } from './changes';
import { handleWebgl } from './webgl';
import { handleAccess } from './access';
import { handleManagement, advanceExportJobs } from './management';

export async function dispatchMockRequest(ctx: MockContext, pathname: string, method: string, options: MockRequestOptions, path: string): Promise<unknown> {
  advanceUploadJobs(ctx); advanceChangeJobs(ctx); advanceExportJobs(ctx);
  if (pathname === '/api/public/upload-config') { allowMethod(method, 'GET'); return { materialMaxCount: 5, materialMaxBytes: 50 * 1024 * 1024 }; }
  if (pathname === '/api/me') { allowMethod(method, 'GET'); return ctx.user ? { authenticated: true, user: ctx.user } : { authenticated: false }; }
  if (pathname === '/api/auth/logout') { allowMethod(method, 'POST'); ctx.state.authUser = 'anonymous'; return { message: 'logged out' }; }
  if (pathname === '/api/auth/google' || pathname === '/api/dev/auth/login') {
    allowMethod(method, 'POST'); const body = bodyObject(options);
    let selection: MockUserSelection = 'owner';
    if (pathname === '/api/auth/google') { if (typeof body.credential !== 'string' || !body.credential) throw new MockHttpError(401, 'UNAUTHORIZED', 'Invalid Google token'); }
    else {
      if (!['USER', 'OPERATOR', 'ADMIN'].includes(String(body.role))) throw new MockHttpError(400, 'VALIDATION_ERROR', 'Invalid role');
      selection = body.role === 'USER' ? 'owner' : body.role as MockUserSelection;
    }
    ctx.state.authUser = selection; delete ctx.state.authExpiresAt; return { user: MOCK_USERS[selection as Exclude<MockUserSelection,'anonymous'>] };
  }
  if (pathname === '/api/dev/auth/login-error') {
    allowMethod(method, 'POST'); const scenario = bodyObject(options).scenario;
    const errors: Record<string, [number, string, string]> = {
      'domain-not-allowed': [403, 'EMAIL_DOMAIN_NOT_ALLOWED', 'Email domain not allowed'],
      'google-api-unavailable': [401, 'GOOGLE_API_UNAVAILABLE', 'Google authentication service is unavailable'],
      'invalid-google-token': [401, 'UNAUTHORIZED', 'Invalid Google token'],
      'missing-google-payload': [401, 'UNAUTHORIZED', 'Invalid token payload'],
      'api-server-error': [500, 'INTERNAL_ERROR', 'Simulated API server error'],
    };
    const error = errors[String(scenario)] ?? [400, 'VALIDATION_ERROR', 'Unknown login failure'];
    throw new MockHttpError(...error);
  }
  for (const handler of [handleVoting, handleUploads, handleProjects, handleChanges, handleWebgl, handleAccess, handleManagement]) {
    const result = await handler(ctx, pathname, method, options, path);
    if (result !== UNHANDLED) return result;
  }
  console.warn(`[Mock] Unhandled: ${method} ${pathname}`);
  return UNHANDLED;
}
/** Legacy test entry point; uses the same HTTP transport and ApiError boundary. */
export async function handleMockRequest<T>(path: string, options: MockRequestOptions = {}): Promise<T> {
  const { mockFetch } = await import('./transport');
  const response = await mockFetch(path, options);
  if (!response.ok) { const { ApiError } = await import('../client'); throw new ApiError(response.status, response.statusText, await response.json()); }
  if (response.status === 204) return undefined as T;
  return (await response.json() as { data: T }).data;
}
