export interface RuntimeConfig {
  apiBaseUrl: string;
  googleClientId: string;
  visibilityControlsEnabled: boolean;
}

let runtimeConfig: RuntimeConfig | undefined;

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('공개 설정은 JSON 객체여야 합니다.');
  }
  const config = value as Record<string, unknown>;
  const keys = ['apiBaseUrl', 'googleClientId', 'visibilityControlsEnabled'];
  if (Object.keys(config).some(key => !keys.includes(key)) ||
      typeof config.apiBaseUrl !== 'string' ||
      typeof config.googleClientId !== 'string' || !config.googleClientId.trim() ||
      typeof config.visibilityControlsEnabled !== 'boolean') {
    throw new Error('공개 설정의 필수 항목과 자료형을 확인하십시오.');
  }
  const url = new URL(config.apiBaseUrl);
  if (url.protocol !== 'https:' || url.origin !== config.apiBaseUrl) {
    throw new Error('API URL은 경로가 없는 HTTPS origin이어야 합니다.');
  }
  return {
    apiBaseUrl: config.apiBaseUrl,
    googleClientId: config.googleClientId.trim(),
    visibilityControlsEnabled: config.visibilityControlsEnabled,
  };
}

export async function loadRuntimeConfig(fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher('/runtime-config.json', {
    cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('runtime-config.json을 읽을 수 없습니다.');
  }
  runtimeConfig = parseRuntimeConfig(await response.json());
}

export function getRuntimeConfig(): RuntimeConfig {
  if (!runtimeConfig) throw new Error('공개 설정이 로드되지 않았습니다.');
  return runtimeConfig;
}
