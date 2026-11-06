import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
export const DB_PATH = path.resolve(process.env.PUNCHPILOT_DB_PATH || path.join(root, 'data', 'punchpilot.db'));
export const KEYSTORE_DIR = path.resolve(process.env.PUNCHPILOT_KEYSTORE_DIR || path.join(root, 'keystore'));
export const LOG_DIR = path.resolve(process.env.PUNCHPILOT_LOG_DIR || path.join(path.dirname(DB_PATH), 'logs'));
export const SCREENSHOTS_DIR = path.resolve(process.env.SCREENSHOTS_DIR || path.join(root, 'screenshots'));
export const LEGACY_SECRET_FILE = path.resolve(process.env.PUNCHPILOT_LEGACY_APP_SECRET_FILE || path.join(path.dirname(DB_PATH), '.app-secret'));
export const INITIAL_ADMIN_PASSWORD_FILE = path.join(KEYSTORE_DIR, 'initial-admin-password');
