import { describe, expect, it } from 'vitest';

import {
  inspectJavascriptModules,
} from '../scripts/ci/inspect-javascript-modules.mjs';

describe('JavaScript module inspection', () => {
  it('ignores import-like text in comments while finding real imports', async () => {
    const inspected = await inspectJavascriptModules(`
      /** @type {import("comment-only").Fixture} */
      import value from "static-module";
      const loaded = await import("dynamic-module");
    `);

    expect(inspected.specifiers).toEqual(['static-module', 'dynamic-module']);
    expect(inspected.dynamicImportPresent).toBe(true);
  });

  it('detects non-literal dynamic imports without treating static imports as dynamic', async () => {
    const staticOnly = await inspectJavascriptModules(
      'import { readFile } from "node:fs";',
    );
    const computed = await inspectJavascriptModules(
      'const moduleName = "node:fs"; await import(moduleName);',
    );

    expect(staticOnly.dynamicImportPresent).toBe(false);
    expect(computed.dynamicImportPresent).toBe(true);
  });

  it('finds reexports without treating import.meta as a module dependency', () => {
    const inspected = inspectJavascriptModules(`
      export * from "star-module";
      export { value } from "named-module";
      console.log(import.meta.url);
    `);

    expect(inspected.specifiers).toEqual(['star-module', 'named-module']);
    expect(inspected.dynamicImportPresent).toBe(false);
  });

  it('rejects malformed module source with the inspected filename', () => {
    expect(() => inspectJavascriptModules('await import(', 'unsafe-source.js'))
      .toThrow('Could not inspect unsafe-source.js:');
  });
});
