import { getRuntimeConfig } from './runtime-config';

// Container builds require a validated public file before application import.
// Development and GitHub Pages keep their existing Vite build-time settings.
const runtime = import.meta.env.VITE_RUNTIME_CONFIG === 'true' ? getRuntimeConfig() : undefined;

export const env = {
  VISIBILITY_CONTROLS_ENABLED: runtime?.visibilityControlsEnabled ?? (import.meta.env.VITE_VISIBILITY_CONTROLS_ENABLED === 'true'),
  API_BASE_URL: runtime?.apiBaseUrl ?? (import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000'),
  GOOGLE_CLIENT_ID: runtime?.googleClientId ?? (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''),
  BASE_PATH: import.meta.env.BASE_URL ?? '/',
} as const;
