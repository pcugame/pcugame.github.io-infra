import type { InlineAssetKind } from '@pcu/contracts';

/** Build the only generic client-file ingress contract: one small image asset. */
export function buildAssetFormData(kind: InlineAssetKind, file: File): FormData {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', file);
  return fd;
}

export function buildPosterReplaceFormData(poster: File): FormData {
  const fd = new FormData();
  fd.append('poster', poster);
  return fd;
}

export function buildExhibitionPosterFormData(poster: File): FormData {
  const fd = new FormData();
  fd.append('poster', poster);
  return fd;
}
