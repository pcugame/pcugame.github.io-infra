import { adminProjectApi } from './admin';
import { userProjectApi } from './me';

export type ProjectSubmissionMode = 'admin' | 'user';

export function getProjectSubmitApi(mode: ProjectSubmissionMode) {
  return mode === 'admin' ? adminProjectApi : userProjectApi;
}
