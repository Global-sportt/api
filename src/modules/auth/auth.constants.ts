export const REFRESH_COOKIE = 'reservas_refresh';
export const CSRF_COOKIE = 'reservas_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const REFRESH_TOKEN_PREFIX = 'v1';

/** Cookie httpOnly que ata el `state` OAuth al navegador que inició el flujo. */
export const OAUTH_STATE_COOKIE = 'reservas_oauth_state';
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type ClientType = 'web' | 'mobile';
