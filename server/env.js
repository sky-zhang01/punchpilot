import { loadEnvFile } from 'node:process';

// Import this before modules that capture environment settings at evaluation time.
try {
  loadEnvFile();
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
