import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Upstream's separate Jest/node suites are source evidence, not HXA tests.
    // Dedicated zylos-*.test.ts suites exercise the actual patched Task runtime.
    exclude: [...configDefaults.exclude, 'vendor/**'],
    testTimeout: 15000,
    hookTimeout: 10000,
  },
});
