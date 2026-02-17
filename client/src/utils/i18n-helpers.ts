/**
 * Convert snake_case to camelCase.
 * Used to map server action_type values (e.g. "break_start") to i18n keys (e.g. "breakStart").
 */
export const snakeToCamel = (s: string): string =>
  s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
