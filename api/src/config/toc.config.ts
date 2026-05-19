import { registerAs } from '@nestjs/config';

/**
 * TOC (Theory of Change) API configuration sourced from environment
 * variables.
 *
 * The TOC API (https://toc.mel.cgiar.org) exposes per-program graphs
 * of work packages (AOWs), outputs, intermediate outcomes (OUTCOME),
 * and 2030 portfolio outcomes (EOI). The endpoint is public and
 * requires no auth header — only a base URL.
 */
export default registerAs('toc', () => ({
  url: process.env.TOC_API_URL ?? 'https://toc.mel.cgiar.org',
}));
