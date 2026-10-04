import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// [::1] covers the local dev server, which binds IPv6 — without it Astro's
// origin check 403s every non-GET request to http://[::1]:4321
const domains = (process.env.IAUTHOR_DOMAINS ?? 'localhost,[::1]')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((hostname) => ({ hostname }));

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: { allowedDomains: domains },
});