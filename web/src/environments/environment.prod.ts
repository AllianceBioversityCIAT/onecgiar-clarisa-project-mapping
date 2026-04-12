export const environment = {
  production: true,
  apiUrl: '/api',
  // Nginx proxies /api/* to the backend, which no longer has a global prefix.
  // Requests like /api/auth/login are rewritten to /auth/login by nginx.
};
