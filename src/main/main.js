const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, execFileSync, spawn } = require('child_process');
const readline = require('readline');
const { detectUserId, detectClaudePath, hasBackup, detectClaudeVersion, CLAUDE_CONFIG_FILE } = require('./detector');
const { backup, patch, restore, updateBuddyInfo, deleteBackup, detectCurrentSalt } = require('./patcher');
const { IPC_CHANNELS } = require('../shared/ipc-channels');

const BUN_HASH_SCRIPT = 'console.log(Number(BigInt(Bun.hash(process.env.HASH_INPUT)) & 0xFFFFFFFFn))';
const SEARCH_PROGRESS_PREFIX = 'PROGRESS:';
const SEARCH_ENTRY_PREFIX = 'BUDDY:';
const SEARCH_DONE_PREFIX = 'DONE:';
const SEARCH_ERROR_PREFIX = 'ERROR:';
let mainWindow = null;
let cachedClaudePath = null;
const activeSearches = new Map();

function success(data = undefined) {
  return data === undefined ? { success: true } : { success: true, data };
}

function failure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { success: false, error: message || 'Unknown error.' };
}

function withSafeResult(handler) {
  try {
    return handler();
  } catch (error) {
    return failure(error);
  }
}

function unlinkIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function closeReadlineSafely(readlineInterface) {
  if (!readlineInterface || readlineInterface.closed) return;
  readlineInterface.close();
}

function createTempFile(prefix) {
  return path.join(
    os.tmpdir(),
    `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.js`,
  );
}

function ensureNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${fieldName}: expected a non-empty string.`);
  }
  return value.trim();
}

function normalizeTotalAttempts(rawTotalAttempts) {
  const MIN_TOTAL_ATTEMPTS = 1;
  const MAX_TOTAL_ATTEMPTS = 50_000_000;
  if (rawTotalAttempts === null || rawTotalAttempts === undefined || rawTotalAttempts === '') return null;
  const parsed = Number(rawTotalAttempts);
  if (!Number.isFinite(parsed)) return null;
  const asInteger = Math.trunc(parsed);
  return Math.max(MIN_TOTAL_ATTEMPTS, Math.min(MAX_TOTAL_ATTEMPTS, asInteger));
}

function normalizeTargetCount(rawTargetCount) {
  const DEFAULT_TARGET_COUNT = 360;
  const MIN_TARGET_COUNT = 1;
  const MAX_TARGET_COUNT = 5000;
  const parsed = Number(rawTargetCount);
  if (!Number.isFinite(parsed)) return DEFAULT_TARGET_COUNT;
  const asInteger = Math.trunc(parsed);
  return Math.max(MIN_TARGET_COUNT, Math.min(MAX_TARGET_COUNT, asInteger));
}

function parseJsonWithContext(rawText, contextLabel) {
  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Failed to parse JSON for ${contextLabel}: ${error.message}`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 900,
    minWidth: 800,
    minHeight: 830,
    backgroundColor: '#1A1D21',
    title: 'CC Buddy Selector',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  if (process.env.NODE_ENV === 'development') mainWindow.webContents.openDevTools();

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  //Menu.setApplicationMenu(null);
  createWindow();
  cachedClaudePath = detectClaudePath();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Helpers ──

/** Ensures cachedClaudePath is populated. Returns an error result object if not found, null if ready. */
function ensureClaudePath() {
  if (!cachedClaudePath) cachedClaudePath = detectClaudePath();
  if (!cachedClaudePath) return { success: false, error: 'Claude binary not found.' };
  return null;
}

function runWithClaudePath(operation) {
  const pathError = ensureClaudePath();
  if (pathError) return pathError;
  return withSafeResult(() => {
    operation(cachedClaudePath);
    return success();
  });
}

/** Resolves the bun executable path. Prefers system bun; falls back to bundled binary. Throws if not found. */
function resolveBunCmd() {
  const binaryName = process.platform === 'win32'
    ? 'bun.exe'
    : (process.arch === 'arm64' ? 'bun-aarch64' : 'bun-x64');
  const bundledBunPath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', binaryName)
    : path.join(__dirname, '../../bin', binaryName);

  // In packaged apps, prefer the bundled binary so runtime behavior does not depend on user machine setup.
  if (app.isPackaged && fs.existsSync(bundledBunPath)) {
    return bundledBunPath;
  }

  const checkCmd = process.platform === 'win32' ? 'where bun' : 'which bun';
  try {
    execSync(checkCmd, { stdio: 'ignore' });
    return 'bun';
  } catch {
    if (!fs.existsSync(bundledBunPath)) {
      throw new Error('Bun executable not found. Ensure the bundled /bin resources or local /bin folder are present.');
    }
    return bundledBunPath;
  }
}

// ── IPC Handlers ──

ipcMain.handle(IPC_CHANNELS.detectUserId, () => detectUserId());

ipcMain.handle(IPC_CHANNELS.detectClaudePath, () => {
  cachedClaudePath = detectClaudePath();
  return cachedClaudePath;
});

ipcMain.handle(IPC_CHANNELS.hasBackup, () => {
  if (!cachedClaudePath) cachedClaudePath = detectClaudePath();
  return hasBackup(cachedClaudePath);
});

ipcMain.handle(IPC_CHANNELS.backupBinary, () => runWithClaudePath((binaryPath) => {
  const version = detectClaudeVersion(binaryPath);
  const salt = detectCurrentSalt(binaryPath);
  backup(binaryPath, version, salt);
}));

ipcMain.handle(IPC_CHANNELS.deleteBackup, () => runWithClaudePath((binaryPath) => deleteBackup(binaryPath)));

ipcMain.handle(IPC_CHANNELS.patchBinary, (_event, salt) => runWithClaudePath((binaryPath) => patch(binaryPath, salt)));

ipcMain.handle(IPC_CHANNELS.restoreBinary, () => runWithClaudePath((binaryPath) => restore(binaryPath)));

ipcMain.handle(IPC_CHANNELS.updateBuddyInfo, (_event, name, description) => {
  return withSafeResult(() => success(updateBuddyInfo(name, description)));
});

ipcMain.handle(IPC_CHANNELS.getBuddyInfo, async () => {
  return withSafeResult(() => {
    const claudeJsonPath = path.join(os.homedir(), CLAUDE_CONFIG_FILE);
    if (!fs.existsSync(claudeJsonPath)) {
      throw new Error(`Config not found at "${claudeJsonPath}".`);
    }
    const data = parseJsonWithContext(fs.readFileSync(claudeJsonPath, 'utf-8'), claudeJsonPath);
    return success(data.companion || {});
  });
});

ipcMain.handle(IPC_CHANNELS.calculateBunHash, async (_event, input) => {
  const tempFile = createTempFile('bun_hash');
  try {
    return withSafeResult(() => {
      const validatedInput = ensureNonEmptyString(input, 'hash input');
      const bunCmd = resolveBunCmd();
      // Write script to file and pass input via env var to avoid shell injection
      fs.writeFileSync(tempFile, BUN_HASH_SCRIPT);
      const result = execFileSync(bunCmd, [tempFile], {
        stdio: 'pipe',
        env: { ...process.env, HASH_INPUT: validatedInput },
        encoding: 'utf-8',
      }).trim();
      const seed = Number.parseInt(result, 10);
      if (!Number.isFinite(seed)) {
        throw new Error(`Bun returned an invalid hash seed: "${result}".`);
      }
      return { success: true, seed };
    });
  } finally {
    unlinkIfExists(tempFile);
  }
});

function stopActiveSearch(webContentsId) {
  const active = activeSearches.get(webContentsId);
  if (!active) return;

  activeSearches.delete(webContentsId);
  active.sender.removeListener('destroyed', active.destroyListener);
  active.markStopped();
  if (!active.child.killed) active.child.kill();
  closeReadlineSafely(active.rl);
  unlinkIfExists(active.tempFile);
}

function isSenderAlive(senderEvent) {
  return Boolean(senderEvent && senderEvent.sender && !senderEvent.sender.isDestroyed());
}

function safeReply(senderEvent, channel, payload) {
  if (!isSenderAlive(senderEvent)) return;
  senderEvent.reply(channel, payload);
}

function safeSend(senderEvent, channel, payload) {
  if (!isSenderAlive(senderEvent)) return;
  senderEvent.sender.send(channel, payload);
}

function buildSearchScript() {
  const constantsPath = path.join(__dirname, '../renderer/constants.js');
  let constantsInjected;
  try {
    constantsInjected = fs.readFileSync(constantsPath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read constants.js for search script: ${err.message}`);
  }

  return `
    ${constantsInjected}
    const { userId, filters, totalAttempts, targetCount } = JSON.parse(process.env.BUDDY_DATA);
    const TOTAL = Number.isFinite(Number(totalAttempts)) && Number(totalAttempts) > 0
      ? Math.trunc(Number(totalAttempts))
      : null;
    const TARGET = targetCount || 360;
    const PROGRESS_INTERVAL = TOTAL ? Math.max(1000, Math.floor(TOTAL / 50)) : 100000;

    function mulberry32(seed) {
      let a = seed >>> 0;
      return function() {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function rollMeta(uid, salt) {
      const seed = Number(BigInt(Bun.hash(uid + salt)) & 0xFFFFFFFFn);
      const rng = mulberry32(seed);
      let rollVal = rng() * 100, rarity = 'common';
      for (const r of RARITIES) { rollVal -= RARITY_WEIGHTS[r]; if (rollVal < 0) { rarity = r; break; } }
      const species = SPECIES[Math.floor(rng() * SPECIES.length)];
      const eye     = EYES[Math.floor(rng() * EYES.length)];
      const hat     = rarity !== 'common' ? HATS[Math.floor(rng() * HATS.length)] : 'none';
      const shiny   = rng() < 0.01;
      const floor   = RARITY_FLOOR[rarity];
      const peakIdx = Math.floor(rng() * 5);
      let dumpIdx   = Math.floor(rng() * 5);
      while (dumpIdx === peakIdx) dumpIdx = Math.floor(rng() * 5);
      return { rng, rarity, species, eye, hat, shiny, floor, peakIdx, dumpIdx };
    }

    function rollStats(meta, filters) {
      let total = 0, d = 0, p = 0, c = 0, w = 0, s = 0;
      for (let i = 0; i < 5; i++) {
        const rv = meta.rng();
        let val;
        if      (i === meta.peakIdx) val = Math.min(100, meta.floor + 50 + Math.floor(rv * 30));
        else if (i === meta.dumpIdx) val = Math.max(1,   meta.floor - 10 + Math.floor(rv * 15));
        else                         val = meta.floor + Math.floor(rv * 40);

        if      (i === 0) { d = val; if (filters.d && d < filters.d) return null; }
        else if (i === 1) { p = val; if (filters.p && p < filters.p) return null; }
        else if (i === 2) { c = val; if (filters.c && c < filters.c) return null; }
        else if (i === 3) { w = val; if (filters.w && w < filters.w) return null; }
        else              { s = val; if (filters.s && s < filters.s) return null; }
        total += val;
      }
      return { total, d, p, c, w, s };
    }

    function randomSalt() {
      let salt = '';
      for (let i = 0; i < 15; i++) salt += CHARSET[(Math.random() * CHARSET.length) | 0];
      return salt;
    }

    const pool = [];
    let matchedCount = 0, storedCount = 0, bestTotal = 0;

    for (let i = 0; TOTAL === null || i < TOTAL; i++) {
      const salt = randomSalt();
      const meta = rollMeta(userId, salt);

      // Stage 1: fast categorical filter
      if (
        (!filters.species || meta.species === filters.species) &&
        (!filters.rarity  || meta.rarity  === filters.rarity)  &&
        (!filters.eye     || meta.eye     === filters.eye)      &&
        (!filters.hat     || meta.hat     === filters.hat)      &&
        (!filters.shiny   || meta.shiny   === filters.shiny)
      ) {
        // Stage 2: numeric stats filter (only computed after stage 1 passes)
        const stats = rollStats(meta, filters);
        if (stats) {
          matchedCount++;
          const entry = {
            salt, species: meta.species, rarity: meta.rarity, eye: meta.eye, hat: meta.hat,
            shiny: meta.shiny, total: stats.total, d: stats.d, p: stats.p, c: stats.c, w: stats.w, s: stats.s
          };
          if (pool.length < TARGET) {
            pool.push(entry);
            storedCount++;
            if (entry.total > bestTotal) bestTotal = entry.total;
            process.stdout.write("BUDDY:" + JSON.stringify(entry) + "\\n");
          } else {
            let weakIdx = 0, weakTotal = Infinity;
            for (let j = 0; j < pool.length; j++) {
              if (pool[j].total < weakTotal) { weakIdx = j; weakTotal = pool[j].total; }
            }
            if (entry.total > weakTotal) {
              pool[weakIdx] = entry;
              if (entry.total > bestTotal) bestTotal = entry.total;
              process.stdout.write("BUDDY:" + JSON.stringify(entry) + "\\n");
            }
          }

          if (storedCount >= TARGET) {
            process.stdout.write("PROGRESS:" + JSON.stringify({ done: i + 1, total: TOTAL, matches: matchedCount, stored: storedCount, bestTotal }) + "\\n");
            break;
          }
        }
      }

      if ((i + 1) % PROGRESS_INTERVAL === 0) {
        process.stdout.write("PROGRESS:" + JSON.stringify({ done: i + 1, total: TOTAL ?? null, matches: matchedCount, stored: storedCount, bestTotal }) + "\\n");
      }
    }

    process.stdout.write("DONE:\\n");
  `;
}

ipcMain.on(IPC_CHANNELS.stopSearch, (event) => {
  stopActiveSearch(event.sender.id);
});

ipcMain.on(IPC_CHANNELS.startBunSearch, (event, payload) => {
  const userId = typeof payload?.userId === 'string' ? payload.userId.trim() : '';
  const filters = payload?.filters && typeof payload.filters === 'object' ? payload.filters : {};
  const totalAttempts = normalizeTotalAttempts(payload?.totalAttempts);
  const targetCount = normalizeTargetCount(payload?.targetCount);
  if (!userId) {
    safeReply(event, IPC_CHANNELS.searchError, 'Cannot start search: missing userId.');
    return;
  }

  let bunCmd;
  try {
    bunCmd = resolveBunCmd();
  } catch (error) {
    safeReply(event, IPC_CHANNELS.searchError, error.message);
    return;
  }

  const senderId = event.sender.id;
  stopActiveSearch(senderId);

  const tempFile = createTempFile('buddy_search');
  try {
    fs.writeFileSync(tempFile, buildSearchScript());
  } catch (error) {
    safeReply(event, IPC_CHANNELS.searchError, `Failed to prepare search script: ${error.message}`);
    unlinkIfExists(tempFile);
    return;
  }

  let child;
  try {
    child = spawn(bunCmd, [tempFile], {
      env: { ...process.env, BUDDY_DATA: JSON.stringify({ userId, filters, totalAttempts, targetCount }) },
    });
  } catch (error) {
    safeReply(event, IPC_CHANNELS.searchError, `Failed to start Bun search process: ${error.message}`);
    unlinkIfExists(tempFile);
    return;
  }
  const rl = readline.createInterface({ input: child.stdout });
  let didEmitDone = false;
  let wasStopped = false;
  let stderrBuffer = '';

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith(SEARCH_PROGRESS_PREFIX)) {
      try {
        safeReply(event, IPC_CHANNELS.searchProgress, JSON.parse(trimmed.slice(SEARCH_PROGRESS_PREFIX.length)));
      } catch (error) {
        safeReply(event, IPC_CHANNELS.searchError, `${SEARCH_ERROR_PREFIX} Invalid search progress payload: ${error.message}`);
      }
    } else if (trimmed.startsWith(SEARCH_ENTRY_PREFIX)) {
      try {
        safeSend(event, IPC_CHANNELS.searchFoundOne, JSON.parse(trimmed.slice(SEARCH_ENTRY_PREFIX.length)));
      } catch (error) {
        safeReply(event, IPC_CHANNELS.searchError, `${SEARCH_ERROR_PREFIX} Invalid buddy payload: ${error.message}`);
      }
    } else if (trimmed.startsWith(SEARCH_DONE_PREFIX)) {
      didEmitDone = true;
      safeSend(event, IPC_CHANNELS.searchDoneSignal, undefined);
    }
  });

  child.stderr.on('data', (chunk) => {
    const nextChunk = String(chunk);
    if (stderrBuffer.length > 2048) return;
    stderrBuffer += nextChunk;
  });

  const onSenderDestroyed = () => stopActiveSearch(senderId);

  const cleanup = () => {
    activeSearches.delete(senderId);
    event.sender.removeListener('destroyed', onSenderDestroyed);
    closeReadlineSafely(rl);
    unlinkIfExists(tempFile);
  };

  child.on('close', (code, signal) => {
    if (!didEmitDone && !wasStopped && code !== 0 && signal !== 'SIGTERM') {
      const detail = stderrBuffer.trim();
      const suffix = detail ? ` stderr: ${detail.slice(0, 300)}` : '';
      safeReply(event, IPC_CHANNELS.searchError, `Bun search exited unexpectedly (code: ${code ?? 'null'}).${suffix}`);
    }
    cleanup();
  });

  child.on('error', (error) => {
    safeReply(event, IPC_CHANNELS.searchError, error.message);
    cleanup();
  });

  event.sender.once('destroyed', onSenderDestroyed);
  activeSearches.set(senderId, {
    child,
    rl,
    tempFile,
    sender: event.sender,
    destroyListener: onSenderDestroyed,
    markStopped: () => { wasStopped = true; },
  });
});

ipcMain.handle(IPC_CHANNELS.getPlatform, () => process.platform);

ipcMain.handle(IPC_CHANNELS.getDebugInfo, () => {
  let bunAvailable = false;
  let bunResolvedPath = null;

  try {
    bunResolvedPath = resolveBunCmd();
    bunAvailable = true;
  } catch {
    bunAvailable = false;
  }

  if (!cachedClaudePath) cachedClaudePath = detectClaudePath();

  return {
    platform: process.platform,
    bunAvailable,
    bunResolvedPath,
    claudeBinaryDetected: Boolean(cachedClaudePath),
  };
});
