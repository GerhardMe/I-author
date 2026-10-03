// Import this module FIRST (before any module that reads config.ts)
// to point the config at a throwaway temp works dir.
const dir = `/tmp/opencode/ia-works-test-${process.pid}`;
process.env.IAUTHOR_WORKS_DIR = dir;
process.env.IAUTHOR_SECRETS_FILE = '/tmp/opencode/ia-test-secrets.json';
export const TEST_WORKS_DIR = dir;