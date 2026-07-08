// Headless stub so the harness can exercise the full TURN path (agent loop) outside
// Electron: safeStorage reports unavailable -> backends degrade to "no key" honestly.
module.exports = {
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  app: { getPath: () => require('node:os').tmpdir(), isPackaged: false }
}
