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

module.exports = { IPC_CHANNELS };
