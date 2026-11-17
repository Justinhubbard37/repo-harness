import { mock } from 'bun:test';
import { fileURLToPath } from 'node:url';

// Preload for a CLI subprocess only; a test file never imports it. A protected helper runs with the
// host gh at a fixed path and the account HOME. This preload gives that runtime the fixture gh and
// HOME that the subprocess environment names, so a test reaches neither the network nor a user file.
const gh = process.env.PROTECTED_HELPER_TEST_GH;
const home = process.env.PROTECTED_HELPER_TEST_HOME;
if (!gh || !home) throw new Error('protected helper preload needs PROTECTED_HELPER_TEST_GH and PROTECTED_HELPER_TEST_HOME');

const platformPath = fileURLToPath(new URL('../../src/effects/runtime/protected-helper-platform.ts', import.meta.url));
// Copy the exports before the mock: mock.module also rebinds the live namespace of the real module.
const real = { ...(await import(platformPath)) };
const resolvePlatform = real.resolveProtectedHelperPlatform;
mock.module(platformPath, () => ({
  ...real,
  resolveTrustedGhExecutable: () => gh,
  resolveProtectedHelperPlatform: (options: Record<string, unknown> = {}) => resolvePlatform({ ...options, accountHome: home }),
}));
