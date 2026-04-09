import { registerAs } from '@nestjs/config';

/**
 * CLARISA API configuration sourced from environment variables.
 *
 * CLARISA (CGIAR Level Agricultural Results Interoperable System Architecture)
 * provides reference data such as centers, programs (initiatives), countries,
 * and action areas used throughout the PRMS application.
 */
export default registerAs('clarisa', () => ({
  url: process.env.CLARISA_URL,
  username: process.env.CLARISA_USERNAME,
  password: process.env.CLARISA_PASSWORD,
}));
