#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  inspectJavascriptModules,
} from '/app/scripts/ci/inspect-javascript-modules.mjs';

const appRoot = '/app';
const serverRoot = path.join(appRoot, 'server');
const packageManifest = JSON.parse(readSource(path.join(appRoot, 'package.json')));

function filesBelow(root, predicate = () => true) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && predicate(absolute)) files.push(absolute);
    }
  }
  return files;
}

function perlModulePresent(relativePath) {
  return ['/usr/share/perl', '/usr/share/perl5'].some((root) => {
    try {
      return fs.globSync(path.join(root, '**', relativePath)).length > 0;
    } catch {
      return false;
    }
  });
}

function executable(pathname) {
  try {
    return (fs.statSync(pathname).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function executableWithPrefix(prefix) {
  return ['/usr/local/bin', '/usr/bin', '/bin'].some((directory) => {
    try {
      return fs.readdirSync(directory)
        .filter((name) => name.startsWith(prefix))
        .some((name) => executable(path.join(directory, name)));
    } catch {
      return false;
    }
  });
}

function readSource(pathname) {
  return fs.readFileSync(pathname, 'utf8');
}

const sourceFiles = filesBelow(serverRoot, (file) => file.endsWith('.js'));
const applicationSource = sourceFiles.map(readSource).join('\n');
const serviceSource = sourceFiles
  .filter((file) => file !== path.join(serverRoot, 'reset-password.js'))
  .map(readSource)
  .join('\n');
const runtimeSource = readSource(path.join(serverRoot, 'automation', 'runtime.js'));
const punchBotSource = readSource(path.join(serverRoot, 'automation', 'punch-bot.js'));
const publicApiSource = readSource(path.join(serverRoot, 'automation', 'public-api.js'));
const apiConfigSource = readSource(path.join(serverRoot, 'routes', 'api-config.js'));
const applicationModules = sourceFiles.map((file) =>
  inspectJavascriptModules(readSource(file), file));
const serviceModules = sourceFiles
  .filter((file) => file !== path.join(serverRoot, 'reset-password.js'))
  .map((file) => inspectJavascriptModules(readSource(file), file));
const applicationSpecifiers = new Set(
  applicationModules.flatMap((inspection) => inspection.specifiers),
);
const serviceSpecifiers = new Set(
  serviceModules.flatMap((inspection) => inspection.specifiers),
);

const runtimeModule = await import(pathToFileURL(
  path.join(serverRoot, 'automation', 'runtime.js'),
));
const webLoginModule = await import(pathToFileURL(
  path.join(serverRoot, 'automation', 'web-login.js'),
));

async function navigationDecision(handler, {
  navigation = true,
  parentFrame = null,
  url = 'https://example.invalid/resource',
} = {}) {
  let decision = null;
  await handler({
    request: () => ({
      frame: () => ({ parentFrame: () => parentFrame }),
      isNavigationRequest: () => navigation,
      url: () => url,
    }),
    abort: async (reason) => { decision = `abort:${reason}`; },
    continue: async () => { decision = 'continue'; },
  });
  return decision;
}

let navigationHandler = null;
await webLoginModule.installFreeeWebNavigationGuard({
  route: async (pattern, handler) => {
    if (pattern === '**/*') navigationHandler = handler;
  },
});
const blockedUntrustedTopLevel = navigationHandler &&
  await navigationDecision(navigationHandler) === 'abort:blockedbyclient';
const allowedTrustedTopLevel = navigationHandler &&
  await navigationDecision(navigationHandler, {
    url: 'https://p.secure.freee.co.jp/',
  }) === 'continue';
const blockedUntrustedSubresource = navigationHandler &&
  await navigationDecision(navigationHandler, { navigation: false })
    === 'abort:blockedbyclient';
const blockedUntrustedSubframe = navigationHandler &&
  await navigationDecision(navigationHandler, { parentFrame: {} })
    === 'abort:blockedbyclient';

async function verifiesRuntimeContextNavigationGuard() {
  let handler = null;
  const context = {
    close: async () => {},
    route: async (pattern, candidate) => {
      if (pattern === '**/*') handler = candidate;
    },
  };
  const browser = {
    close: async () => {},
    isConnected: () => true,
    newContext: async () => context,
    on: () => {},
  };
  const runtime = new runtimeModule.AutomationRuntime({
    launch: async () => browser,
    closeTimeoutMs: 100,
  });
  try {
    if (await runtime.openContext({ useStoredSession: false }) !== context) {
      return false;
    }
    return typeof handler === 'function';
  } finally {
    await runtime.closeContext(context);
    await runtime.close();
  }
}

async function verifiesBrowserDisconnectRecovery() {
  const listeners = new Map();
  const first = {
    close: async () => {},
    isConnected: () => true,
    on: (event, listener) => listeners.set(event, listener),
  };
  const second = {
    close: async () => {},
    isConnected: () => true,
    on: () => {},
  };
  let launchCount = 0;
  const runtime = new runtimeModule.AutomationRuntime({
    launch: async () => (++launchCount === 1 ? first : second),
    closeTimeoutMs: 100,
  });
  try {
    if (await runtime.getBrowser() !== first) return false;
    listeners.get('disconnected')?.();
    return await runtime.getBrowser() === second && launchCount === 2;
  } finally {
    await runtime.close();
  }
}

let blockedUntrustedOrigin = false;
try {
  webLoginModule.assertAllowedFreeeWebUrl('https://example.invalid/login');
} catch (error) {
  blockedUntrustedOrigin = error?.code === 'WEB_NAVIGATION_ORIGIN_BLOCKED';
}
let blockedLoginOriginForMutation = false;
try {
  webLoginModule.assertAllowedFreeeWebUrl(
    'https://accounts.secure.freee.co.jp/sessions/new',
    { applicationOnly: true },
  );
} catch (error) {
  blockedLoginOriginForMutation = error?.code === 'WEB_NAVIGATION_ORIGIN_BLOCKED';
}

const status = readSource('/proc/self/status');
const effectiveCapabilities = /^CapEff:\s*([0-9a-f]+)$/im.exec(status)?.[1] || '';
const runtimeBits = ['x64', 'arm64'].includes(process.arch) ? 64 : 0;
const platform = process.arch === 'x64'
  ? 'linux/amd64'
  : process.arch === 'arm64'
    ? 'linux/arm64'
    : `linux/${process.arch}`;
const blockDeviceCount = fs.readdirSync('/dev', { withFileTypes: true })
  .filter((entry) => entry.isBlockDevice())
  .length;
const requireProcessApiPattern =
  /\brequire\s*\(\s*['"](?:node:)?child_process['"]\s*\)/;
const requireInteractiveParserPattern =
  /\brequire\s*\(\s*['"](?:node:)?(?:readline(?:\/promises)?|tty|repl)['"]\s*\)/;
const requireArchiveApiPattern =
  /\brequire\s*\(\s*['"](?:node:)?(?:zlib|tar|tar-stream|archiver|unzipper|extract-zip)['"]\s*\)/;
const dynamicModuleLoaderPattern =
  /\b(?:createRequire|process\.binding)\b|\bBun\.spawn\b|\bDeno\.Command\b/;
const stdinApiPattern = /\bprocess\.stdin\b/;
const systemGzipPattern = /\bgzip\b/i;
const importsModule = (specifiers, names) => [...specifiers].some((specifier) => {
  const normalized = specifier.replace(/^node:/, '');
  return names.some((name) => normalized === name || normalized.startsWith(`${name}/`));
});
const directDependencies = new Set(Object.keys(packageManifest.dependencies || {}));
const genericProcessDependencies = new Set([
  'cross-spawn',
  'execa',
  'node-pty',
  'shelljs',
  'zx',
]);
const archiveDependencies = new Set([
  'adm-zip',
  'archiver',
  'extract-zip',
  'tar',
  'tar-stream',
  'unzipper',
]);
const fixedBrowserLauncher =
  runtimeSource.includes('import { chromium } from "playwright";') &&
  runtimeSource.includes('launch = (options) => chromium.launch(options)') &&
  runtimeSource.includes('args: ["--disable-gpu", "--disable-software-rasterizer"]') &&
  runtimeSource.includes('export const automationRuntime = new AutomationRuntime();') &&
  (applicationSource.match(/new AutomationRuntime\s*\(/g) || []).length === 1;
const runtimeContextNavigationGuard =
  await verifiesRuntimeContextNavigationGuard();
const fixedFreeeTopLevelNavigation =
  webLoginModule.isAllowedFreeeWebUrl('https://p.secure.freee.co.jp/') &&
  webLoginModule.isAllowedFreeeWebUrl(
    'https://accounts.secure.freee.co.jp/sessions/new',
  ) &&
  !webLoginModule.isAllowedFreeeWebUrl(
    'https://p.secure.freee.co.jp.example.invalid/',
  ) &&
  blockedUntrustedOrigin &&
  blockedLoginOriginForMutation &&
  blockedUntrustedTopLevel &&
  allowedTrustedTopLevel &&
  runtimeContextNavigationGuard &&
  punchBotSource.includes('applicationOnly: true');
const browserDisconnectRecovery = await verifiesBrowserDisconnectRecovery();

const evidence = {
  schema_version: 1,
  platform,
  facts: {
    runtime_bits: runtimeBits,
    perl_interpreter_executable_present: executableWithPrefix('perl'),
    system_dbus_socket_present: fs.existsSync('/run/dbus/system_bus_socket'),
    archive_tar_module_present: perlModulePresent('Archive/Tar.pm'),
    io_compress_module_present: perlModulePresent('IO/Compress.pm'),
    cups_daemon_executable: executable('/usr/sbin/cupsd'),
    runtime_uid: process.getuid?.() ?? -1,
    effective_capabilities: effectiveCapabilities,
    block_device_count: blockDeviceCount,
    browser_gpu_disabled: runtimeSource.includes('"--disable-gpu"'),
    software_rasterizer_disabled: runtimeSource.includes(
      '"--disable-software-rasterizer"',
    ),
    runtime_stdin_is_tty: process.stdin.isTTY === true,
    application_process_api_present:
      importsModule(applicationSpecifiers, ['child_process']) ||
      requireProcessApiPattern.test(applicationSource),
    application_interactive_parser_api_present:
      importsModule(serviceSpecifiers, ['readline', 'tty', 'repl']) ||
      requireInteractiveParserPattern.test(serviceSource),
    application_stdin_api_present: stdinApiPattern.test(serviceSource),
    application_archive_api_present:
      importsModule(applicationSpecifiers, [
        'zlib',
        'tar',
        'tar-stream',
        'archiver',
        'unzipper',
        'extract-zip',
      ]) || requireArchiveApiPattern.test(applicationSource),
    application_dynamic_module_loader_present:
      applicationModules.some((inspection) => inspection.dynamicImportPresent) ||
      importsModule(applicationSpecifiers, ['module']) ||
      dynamicModuleLoaderPattern.test(applicationSource),
    application_generic_process_dependency_present:
      [...genericProcessDependencies].some((name) => directDependencies.has(name)),
    application_archive_dependency_present:
      [...archiveDependencies].some((name) => directDependencies.has(name)),
    application_system_gzip_reference_present:
      systemGzipPattern.test(applicationSource),
    runtime_browser_launcher_fixed: fixedBrowserLauncher,
    fixed_freee_top_level_navigation: fixedFreeeTopLevelNavigation,
    navigation_subresources_origin_filtered:
      blockedUntrustedSubresource && blockedUntrustedSubframe,
    browser_disconnect_recovery: browserDisconnectRecovery,
    operation_timeout_ms: runtimeModule.AUTOMATION_OPERATION_TIMEOUT_MS,
    web_operations_use_deadline:
      publicApiSource.includes('return await withDeadline(async (signal)') &&
      publicApiSource.includes('}, AUTOMATION_OPERATION_TIMEOUT_MS, {') &&
      publicApiSource.includes('await bot.init(signal);') &&
      apiConfigSource.includes('return await withDeadline(async (signal)') &&
      apiConfigSource.includes('}, AUTOMATION_OPERATION_TIMEOUT_MS, {') &&
      apiConfigSource.includes('useStoredSession: false,\n          signal,'),
  },
};

process.stdout.write(`${JSON.stringify(evidence)}\n`);
