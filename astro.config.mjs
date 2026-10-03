import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

const domains = (process.env.IAUTHOR_DOMAINS ?? 'localhost')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((hostname) => ({ hostname }));

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: { allowedDomains: domains },
});