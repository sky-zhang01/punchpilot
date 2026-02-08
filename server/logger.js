import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '..', 'data', 'logs');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB per file
const MAX_LOG_FILES = 10; // keep last 10 rotated files

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Simple file-based logger with rotation.
 * Logs to both console and file.
 * Format: [YYYY-MM-DD HH:mm:ss.SSS] [LEVEL] [module] message
 */
class Logger {
  constructor() {
    this.currentLogPath = path.join(LOG_DIR, 'punchpilot.log');
    this._stream = null;
    this._ensureStream();
  }

  _ensureStream() {
    if (!this._stream || this._stream.destroyed) {
      this._stream = fs.createWriteStream(this.currentLogPath, { flags: 'a' });
      this._stream.on('error', (err) => {
        console.error('[Logger] Write stream error:', err.message);
        this._stream = null;
      });
    }
  }

  _rotateIfNeeded() {
    try {
      if (!fs.existsSync(this.currentLogPath)) return;
      const stats = fs.statSync(this.currentLogPath);
      if (stats.size < MAX_LOG_SIZE) return;

      // Close current stream
      if (this._stream) {
        this._stream.end();
        this._stream = null;
      }

      // Rotate: rename current to timestamped backup
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedPath = path.join(LOG_DIR, `punchpilot-${ts}.log`);
      fs.renameSync(this.currentLogPath, rotatedPath);

      // Cleanup old rotated files
      const files = fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith('punchpilot-') && f.endsWith('.log'))
        .sort()
        .reverse();
      for (let i = MAX_LOG_FILES; i < files.length; i++) {
        fs.unlinkSync(path.join(LOG_DIR, files[i]));
      }

      // Create new stream
      this._ensureStream();
    } catch (err) {
      console.error('[Logger] Rotation error:', err.message);
    }
  }

  _timestamp() {
    return new Date().toISOString().replace('T', ' ').replace('Z', '');
  }

  _write(level, module, message, extra) {
    const ts = this._timestamp();
    const prefix = `[${ts}] [${level}] [${module}]`;
    const line = extra ? `${prefix} ${message} ${JSON.stringify(extra)}` : `${prefix} ${message}`;

    // Console output
    switch (level) {
      case 'ERROR':
        console.error(line);
        break;
      case 'WARN':
        console.warn(line);
        break;
      default:
        console.log(line);
    }

    // File output
    try {
      this._rotateIfNeeded();
      this._ensureStream();
      if (this._stream) {
        this._stream.write(line + '\n');
      }
    } catch (err) {
      // Silently fail file write — console already logged
    }
  }

  /**
   * Create a child logger with a fixed module name
   */
  child(module) {
    return {
      info: (msg, extra) => this._write('INFO', module, msg, extra),
      warn: (msg, extra) => this._write('WARN', module, msg, extra),
      error: (msg, extra) => this._write('ERROR', module, msg, extra),
      debug: (msg, extra) => this._write('DEBUG', module, msg, extra),
    };
  }

  info(msg, extra) { this._write('INFO', 'App', msg, extra); }
  warn(msg, extra) { this._write('WARN', 'App', msg, extra); }
  error(msg, extra) { this._write('ERROR', 'App', msg, extra); }
  debug(msg, extra) { this._write('DEBUG', 'App', msg, extra); }
}

// Singleton
const logger = new Logger();
export default logger;
