/**
 * Runs before every e2e test file (via jest-e2e.json `setupFiles`).
 *
 * We force NODE_ENV=development so the dev-login / dev-token endpoints
 * are reachable. These endpoints are the only way integration tests can
 * issue a JWT without going through the Cognito OAuth flow.
 */
process.env.NODE_ENV = 'development';
