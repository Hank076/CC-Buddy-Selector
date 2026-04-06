const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { detectClaudeVersion } = require('./detector');
const { DEFAULT_SALT, SALT_LENGTH } = require('../renderer/constants');

const ASCII_ENCODING = 'ascii';
const SALT_PATTERN = /^[A-Za-z0-9_-]{15}$/;

function createPatcherError(operation, details, context = {}, suggestion = 'Please verify inputs and try again.') {
  const contextMessage = Object.entries(context)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ');
  const formattedContext = contextMessage ? ` Context: ${contextMessage}.` : '';
  return new Error(`[patcher:${operation}] ${details}.${formattedContext} Suggested action: ${suggestion}`);
}

/**
 * 取得備份檔案路徑。
 */
function getBackupPath(binaryPath, version, salt) {
  return `${binaryPath}.${version}.${salt}`;
}

/**
 * 偵測當前二進位檔案中的鹽值。
 * 策略：
 * 1. 直接搜尋預設鹽值。
 * 2. 若找不到預設值且存在備份，則比對備份中的偏移量來讀取當前值。
 */
function detectCurrentSalt(binaryPath) {
  const content = fs.readFileSync(binaryPath);
  const defaultSaltBuf = Buffer.from(DEFAULT_SALT, ASCII_ENCODING);
  
  // 1. 檢查是否為預設值
  if (content.indexOf(defaultSaltBuf) !== -1) {
    return DEFAULT_SALT;
  }
  
  // 2. 嘗試透過備份檔尋找偏移量
  try {
    const version = detectClaudeVersion(binaryPath);
    const defaultBackupPath = getBackupPath(binaryPath, version, DEFAULT_SALT);
    
    if (fs.existsSync(defaultBackupPath)) {
      const backupContent = fs.readFileSync(defaultBackupPath);
      const offset = backupContent.indexOf(defaultSaltBuf);
      
      if (offset !== -1) {
        const currentSaltBuf = content.slice(offset, offset + SALT_LENGTH);
        const currentSalt = currentSaltBuf.toString(ASCII_ENCODING);
        if (SALT_PATTERN.test(currentSalt)) {
          return currentSalt;
        }
      }
    }
  } catch (e) {
    // 忽略偵測錯誤，回傳未知狀態
  }
  
  return 'patched-or-other';
}

function assertBinaryPathExists(binaryPath, operation) {
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    throw createPatcherError(
      operation,
      'Binary not found',
      { binaryPath },
      'Detect Claude binary path again.',
    );
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    throw createPatcherError(
      'readJsonFile',
      'Unable to read or parse JSON',
      { filePath, reason: error.message },
      'Ensure the file exists and contains valid JSON.',
    );
  }
}

function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    throw createPatcherError(
      'writeJsonFile',
      'Unable to persist JSON',
      { filePath, reason: error.message },
      'Ensure the target path is writable.',
    );
  }
}

function validateSalt(newSalt) {
  if (typeof newSalt !== 'string') {
    throw createPatcherError(
      'validateSalt',
      'Salt must be a string',
      { receivedType: typeof newSalt },
      `Provide a ${SALT_LENGTH}-character salt using A-Z, a-z, 0-9, "-" or "_".`,
    );
  }
  if (!SALT_PATTERN.test(newSalt)) {
    throw createPatcherError(
      'validateSalt',
      'Salt format is invalid',
      { saltLength: newSalt.length, expectedLength: SALT_LENGTH },
      `Provide exactly ${SALT_LENGTH} characters using A-Z, a-z, 0-9, "-" or "_".`,
    );
  }
}

function replaceAsciiTokenInBuffer(buffer, sourceToken, targetToken) {
  const source = Buffer.from(sourceToken, ASCII_ENCODING);
  const target = Buffer.from(targetToken, ASCII_ENCODING);
  let count = 0;
  let pos = 0;
  while ((pos = buffer.indexOf(source, pos)) !== -1) {
    target.copy(buffer, pos);
    pos += source.length;
    count++;
  }
  return count;
}

/**
 * Creates a backup of the binary with version and salt.
 */
function backup(binaryPath, version, salt) {
  assertBinaryPathExists(binaryPath, 'backup');
  const backupPath = getBackupPath(binaryPath, version, salt);
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(binaryPath, backupPath);
  }
}

/**
 * Patches the Claude Code binary by replacing the default salt with newSalt.
 * Creates a backup first if not exists. Re-signs on macOS.
 */
function patch(binaryPath, newSalt) {
  assertBinaryPathExists(binaryPath, 'patch');
  validateSalt(newSalt);

  const version = detectClaudeVersion(binaryPath);
  const currentSalt = detectCurrentSalt(binaryPath);

  // Requirement: check if same version and salt=DEFAULT_SALT exists. If not, backup.
  const defaultBackupPath = getBackupPath(binaryPath, version, DEFAULT_SALT);
  if (!fs.existsSync(defaultBackupPath)) {
    if (currentSalt === DEFAULT_SALT) {
      fs.copyFileSync(binaryPath, defaultBackupPath);
    } else {
      // If we are already patched but have no default backup, this is a risky state.
      // However, we should still try to backup current state as a fallback.
      const currentBackupPath = getBackupPath(binaryPath, version, currentSalt);
      if (!fs.existsSync(currentBackupPath)) {
        fs.copyFileSync(binaryPath, currentBackupPath);
      }
    }
  }

  // If already patched, restore to default first to ensure we have a clean slate for the new patch.
  if (currentSalt !== DEFAULT_SALT && fs.existsSync(defaultBackupPath)) {
    fs.copyFileSync(defaultBackupPath, binaryPath);
  }

  const content = fs.readFileSync(binaryPath);
  // Now we are sure (or at least hopeful) that we are patching the DEFAULT_SALT.
  const replacedCount = replaceAsciiTokenInBuffer(content, DEFAULT_SALT, newSalt);

  if (replacedCount === 0) {
    throw createPatcherError(
      'patch',
      'Default salt token was not found in target binary',
      { binaryPath, currentSalt, version },
      'Restore the original binary or verify Claude Code version compatibility.',
    );
  }
  fs.writeFileSync(binaryPath, content);

  if (process.platform === 'darwin') codesign(binaryPath);
}

/**
 * Restores the binary from its latest DEFAULT_SALT backup.
 */
function restore(binaryPath) {
  assertBinaryPathExists(binaryPath, 'restore');
  const dir = path.dirname(binaryPath);
  const base = path.basename(binaryPath);
  
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(base + '.') && f.includes(DEFAULT_SALT))
    .map(f => {
      // Format: base.version.salt
      const parts = f.slice(base.length + 1).split('.');
      const salt = parts.pop();
      const version = parts.join('.');
      return { name: f, version, salt };
    });

  if (files.length === 0) {
    throw createPatcherError(
      'restore',
      'No DEFAULT_SALT backup found',
      { binaryPath },
      'Ensure a backup with the default salt exists.',
    );
  }

  // Sort by version (simple semver-like comparison)
  files.sort((a, b) => {
    const va = a.version.split('.').map(Number);
    const vb = b.version.split('.').map(Number);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const na = va[i] || 0;
      const nb = vb[i] || 0;
      if (na !== nb) return nb - na; // Descending
    }
    return 0;
  });

  const latestBackup = path.join(dir, files[0].name);
  fs.copyFileSync(latestBackup, binaryPath);
  
  if (process.platform === 'darwin') codesign(binaryPath);
}

/**
 * Ad-hoc codesign for macOS (replaces Anthropic's removed signature).
 */
function codesign(binaryPath) {
  try {
    execFileSync('codesign', ['--force', '--sign', '-', binaryPath], { timeout: 10000, stdio: 'pipe' });
  } catch (e) {
    console.warn(createPatcherError(
      'codesign',
      'macOS ad-hoc signing failed',
      { binaryPath, reason: e.message },
      'Run the app with sufficient permissions and ensure codesign is available.',
    ).message);
  }
}

/**
 * Updates companion name and personality in ~/.claude.json
 */
function updateBuddyInfo(newName, newPersonality) {
  const claudeJsonPath = path.join(os.homedir(), CLAUDE_CONFIG_FILE);
  if (!fs.existsSync(claudeJsonPath)) {
    throw createPatcherError(
      'updateBuddyInfo',
      'Claude config was not found',
      { claudeJsonPath },
      'Open Claude Code once to generate ~/.claude.json, then retry.',
    );
  }

  if (newName !== undefined && typeof newName !== 'string') {
    throw createPatcherError(
      'updateBuddyInfo',
      'Buddy name must be a string',
      { receivedType: typeof newName },
      'Pass a string for the buddy name field.',
    );
  }
  if (newPersonality !== undefined && typeof newPersonality !== 'string') {
    throw createPatcherError(
      'updateBuddyInfo',
      'Buddy personality must be a string',
      { receivedType: typeof newPersonality },
      'Pass a string for the buddy personality field.',
    );
  }

  const data = readJsonFile(claudeJsonPath);
  if (!data.companion) {
    throw createPatcherError(
      'updateBuddyInfo',
      'Companion section is missing in config',
      { claudeJsonPath },
      'Reset Claude config or add the companion section before updating.',
    );
  }
  if (newName !== undefined) data.companion.name = newName;
  if (newPersonality !== undefined) data.companion.personality = newPersonality;
  writeJsonFile(claudeJsonPath, data);
  return { name: data.companion.name, personality: data.companion.personality };
}

/**
 * Deletes all binary backups.
 */
function deleteBackup(binaryPath) {
  if (!binaryPath) {
    throw createPatcherError(
      'deleteBackup',
      'Binary path is required',
      { binaryPath },
      'Detect Claude binary path before deleting backup.',
    );
  }

  const dir = path.dirname(binaryPath);
  const base = path.basename(binaryPath);
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f.startsWith(base + '.')) {
        // Simple check to see if it follows the pattern: base.version.salt
        const suffix = f.slice(base.length + 1);
        if (suffix.includes('.') && suffix.split('.').length >= 2) {
          fs.unlinkSync(path.join(dir, f));
        }
      }
    }
  } catch (error) {
    console.warn(`[patcher:deleteBackup] Failed to delete some backups: ${error.message}`);
  }
}

module.exports = { backup, patch, restore, codesign, updateBuddyInfo, deleteBackup, detectCurrentSalt };
