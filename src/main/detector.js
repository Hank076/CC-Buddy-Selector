const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const CLAUDE_CONFIG_FILE = '.claude.json';
const CLAUDE_BACKUP_SUFFIX = '.buddy-bak';
const CLAUDE_PACKAGE_SEGMENTS = ['@anthropic-ai', 'claude-code'];
const CLAUDE_ENTRY_CANDIDATES = ['cli.js', 'index.js', path.join('dist', 'cli.js')];
const WINDOWS_PATH_PREFIX_TOKEN = '%~dp0';
const COMMAND_TIMEOUT_MS = 5000;

const { DEFAULT_SALT } = require('../renderer/constants');

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function getFirstCommandPath(command) {
  try {
    const output = execSync(command, { encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads ~/.claude.json and returns the user's account UUID.
 */
function detectUserId() {
  try {
    const claudeJson = path.join(os.homedir(), CLAUDE_CONFIG_FILE);
    const data = readJsonFile(claudeJson);
    return data.oauthAccount?.accountUuid ?? data.userID ?? null;
  } catch {
    return null;
  }
}

/**
 * Finds the actual Claude Code binary/bundle path.
 * On Windows, `claude` is a .cmd wrapper; we need to resolve to the real JS bundle.
 * Returns the path string or null if not found.
 */
function detectClaudePath() {
  const commandByPlatform = process.platform === 'win32' ? 'where claude' : 'which claude';
  const commandPath = getFirstCommandPath(commandByPlatform);

  if (process.platform === 'win32') {
    return resolveWindowsClaudePath(commandPath);
  }

  // macOS / Linux: resolve symlinks
  if (commandPath) {
    try {
      const resolved = fs.realpathSync(commandPath);
      return resolved;
    } catch {
      return commandPath;
    }
  }

  return null;
}

/**
 * On Windows, `claude` is typically a .cmd shim. We need to find the actual
 * bundled JS file inside the @anthropic-ai/claude-code package.
 */
function resolveWindowsClaudePath(cmdPath) {
  const normalizedCommandPath = typeof cmdPath === 'string' ? cmdPath.trim() : '';
  if (!normalizedCommandPath) return null;

  // Strategy 1: parse the .cmd file to find the actual script
  if (normalizedCommandPath.toLowerCase().endsWith('.cmd')) {
    try {
      const content = fs.readFileSync(normalizedCommandPath, 'utf-8');
      // .cmd shims typically contain something like:
      // @node  "%~dp0\node_modules\@anthropic-ai\claude-code\cli.js" %*
      const quotedMatch = content.match(/node(?:\.exe)?\s+"([^"]+)"/i);
      const unquotedMatch = content.match(/node(?:\.exe)?\s+([^\r\n\s]+)/i);
      const scriptToken = quotedMatch?.[1] || unquotedMatch?.[1];

      if (scriptToken) {
        const shimDirectory = path.dirname(normalizedCommandPath);
        const scriptPath = scriptToken
          .replace(new RegExp(WINDOWS_PATH_PREFIX_TOKEN, 'gi'), `${shimDirectory}${path.sep}`)
          .replace(/\\/g, path.sep);
        const normalizedScriptPath = path.normalize(scriptPath);
        if (fs.existsSync(normalizedScriptPath)) return normalizedScriptPath;
      }
    } catch { /* fall through */ }
  }

  // Strategy 2: look in npm global node_modules
  const candidatePackageDirs = new Set();
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS }).trim();
    candidatePackageDirs.add(path.join(npmRoot, ...CLAUDE_PACKAGE_SEGMENTS));
  } catch { /* ignore */ }

  // Common Windows npm global paths
  const appData = process.env.APPDATA || '';
  if (appData) {
    candidatePackageDirs.add(path.join(appData, 'npm', 'node_modules', ...CLAUDE_PACKAGE_SEGMENTS));
  }
  candidatePackageDirs.add(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', ...CLAUDE_PACKAGE_SEGMENTS));

  for (const pkgDir of candidatePackageDirs) {
    // Try common entry points: cli.js, index.js, dist/cli.js
    for (const entry of CLAUDE_ENTRY_CANDIDATES) {
      const candidate = path.join(pkgDir, entry);
      if (fs.existsSync(candidate)) return candidate;
    }
    // Fallback: read package.json main field
    const pkgJson = path.join(pkgDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      try {
        const pkg = readJsonFile(pkgJson);
        const mainEntry = pkg.bin?.claude || pkg.main;
        if (mainEntry) {
          const candidate = path.join(pkgDir, mainEntry);
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch { /* ignore */ }
    }
  }

  return normalizedCommandPath;
}

/**
 * Reads the package.json near the binary path to find Claude's version.
 * Fallback to executing the binary with --version if package.json is missing.
 */
function detectClaudeVersion(binaryPath) {
  if (!binaryPath) return 'unknown';
  try {
    // Strategy 1: Look for package.json in nearby directories
    let currentDir = path.dirname(binaryPath);
    for (let i = 0; i < 3; i++) {
      const pkgJson = path.join(currentDir, 'package.json');
      if (fs.existsSync(pkgJson)) {
        const pkg = readJsonFile(pkgJson);
        if (pkg.name === '@anthropic-ai/claude-code' || pkg.name === 'claude-code') {
          return pkg.version || 'unknown';
        }
      }
      const nextDir = path.dirname(currentDir);
      if (nextDir === currentDir) break;
      currentDir = nextDir;
    }

    // Strategy 2: Fallback to executing {binary} --version
    // This is useful for standalone executables or global installs without accessible package.json
    const output = execSync(`"${binaryPath}" --version`, { 
      encoding: 'utf-8', 
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'] 
    }).trim();
    
    // Typical output might be "0.x.y" or "claude-code/0.x.y"
    const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
    if (versionMatch) return versionMatch[1];
    
    if (output && output.length < 20) return output;
  } catch { /* ignore */ }
  return 'unknown';
}

/**
 * Check if any backup file exists for the given binary path using the new naming convention.
 * The format is {binaryPath}.{version}.{salt}
 */
function hasBackup(binaryPath) {
  if (!binaryPath) return false;
  const dir = path.dirname(binaryPath);
  const base = path.basename(binaryPath);
  try {
    const files = fs.readdirSync(dir);
    return files.some(f => {
      if (!f.startsWith(base + '.')) return false;
      const suffix = f.slice(base.length + 1);
      // Ensure it has at least one dot (separating version and salt)
      return suffix.includes('.');
    });
  } catch {
    return false;
  }
}

module.exports = { detectUserId, detectClaudePath, hasBackup, detectClaudeVersion };
