const { contextBridge, ipcRenderer } = require('electron');
const IPC_CHANNELS = Object.freeze({
  detectUserId: 'detect-user-id',
  detectClaudePath: 'detect-claude-path',
  hasBackup: 'has-backup',
  backupBinary: 'backup-binary',
  deleteBackup: 'delete-backup',
  patchBinary: 'patch-binary',
  restoreBinary: 'restore-binary',
  updateBuddyInfo: 'update-buddy-info',
  getBuddyInfo: 'get-buddy-info',
  calculateBunHash: 'calculate-bun-hash',
  stopSearch: 'stop-search',
  startBunSearch: 'start-bun-search',
  searchProgress: 'search-progress',
  searchFoundOne: 'search-found-one',
  searchDoneSignal: 'search-done-signal',
  searchError: 'search-error',
  getPlatform: 'get-platform',
  getDebugInfo: 'get-debug-info',
});

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

function send(channel, payload) {
  ipcRenderer.send(channel, payload);
}

function on(channel, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError(`Invalid IPC listener for "${channel}": callback must be a function.`);
  }
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const buddyAPI = {
  detectUserId: () => invoke(IPC_CHANNELS.detectUserId),
  detectClaudePath: () => invoke(IPC_CHANNELS.detectClaudePath),
  hasBackup: () => invoke(IPC_CHANNELS.hasBackup),
  backupBinary: () => invoke(IPC_CHANNELS.backupBinary),
  deleteBackup: () => invoke(IPC_CHANNELS.deleteBackup),
  patchBinary: (salt) => invoke(IPC_CHANNELS.patchBinary, salt),
  restoreBinary: () => invoke(IPC_CHANNELS.restoreBinary),
  updateBuddyInfo: (name, description) => invoke(IPC_CHANNELS.updateBuddyInfo, name, description),
  getBuddyInfo: () => invoke(IPC_CHANNELS.getBuddyInfo),
  calculateBunHash: (input) => invoke(IPC_CHANNELS.calculateBunHash, input),
  startBunSearch: (data) => send(IPC_CHANNELS.startBunSearch, data),
  stopSearch: () => send(IPC_CHANNELS.stopSearch),
  onSearchProgress: (callback) => on(IPC_CHANNELS.searchProgress, callback),
  onSearchFoundOne: (callback) => on(IPC_CHANNELS.searchFoundOne, callback),
  onSearchDone: (callback) => on(IPC_CHANNELS.searchDoneSignal, callback),
  onSearchError: (callback) => on(IPC_CHANNELS.searchError, callback),
  getPlatform: () => invoke(IPC_CHANNELS.getPlatform),
  getDebugInfo: () => invoke(IPC_CHANNELS.getDebugInfo),
};

Object.freeze(buddyAPI);
contextBridge.exposeInMainWorld('buddyAPI', buddyAPI);
