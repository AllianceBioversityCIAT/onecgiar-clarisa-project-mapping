import { registerAs } from '@nestjs/config';

/**
 * Authentication configuration sourced from environment variables.
 *
 * Combines AWS Cognito OAuth2 settings with the local JWT signing secret.
 * Cognito handles external authentication; the local JWT secret is used
 * to sign short-lived access tokens issued by the API.
 */
export default registerAs('auth', () => ({
  cognitoApi: process.env.COGNITO_API,
  cognitoClientId: process.env.COGNITO_CLIENT_ID,
  cognitoClientSecret: process.env.COGNITO_CLIENT_SECRET,
  cognitoRedirectUri: process.env.COGNITO_REDIRECT_URI,
  jwtSecret: process.env.JWT_SECRET || 'fallback-secret',
}));
