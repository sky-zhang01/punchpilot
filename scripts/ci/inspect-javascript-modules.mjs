import { init, parse } from 'es-module-lexer';

await init;

export function inspectJavascriptModules(source, filename = 'JavaScript source') {
  let imports;
  try {
    [imports] = parse(source, filename);
  } catch (error) {
    throw new Error(`Could not inspect ${filename}: ${error.message}`);
  }

  return {
    specifiers: imports
      .map((entry) => entry.specifier)
      .filter((specifier) => typeof specifier === 'string'),
    dynamicImportPresent: imports.some((entry) => entry.type === 'dynamic'),
  };
}
