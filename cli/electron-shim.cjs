/**
 * electron-shim.cjs
 * 
 * Minimal mock of the Electron APIs used by Clawdia's main-process modules
 * so they can run in a plain Node.js CLI context without Electron.
 * 
 * Handles:
 *   - app.getPath('userData') → ~/.config/clawdia
 *   - BrowserWindow (type-only in loop.ts — no-op)
 *   - Notification (human-intervention-manager.ts — no-op in CLI)
 *   - ipcMain (not used in CLI path — no-op)
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const userData = path.join(os.homedir(), '.config', 'clawdia');
fs.mkdirSync(userData, { recursive: true });

const app = {
  getPath: (name) => {
    if (name === 'userData') return userData;
    if (name === 'home') return os.homedir();
    if (name === 'temp') return os.tmpdir();
    if (name === 'downloads') return path.join(os.homedir(), 'Downloads');
    if (name === 'desktop') return path.join(os.homedir(), 'Desktop');
    if (name === 'documents') return path.join(os.homedir(), 'Documents');
    return userData;
  },
  getName: () => 'clawdia',
  getVersion: () => '4.0.0',
  quit: () => process.exit(0),
  on: () => {},
  whenReady: () => Promise.resolve(),
  requestSingleInstanceLock: () => true,
};

const BrowserWindow = class {
  constructor() {}
  loadURL() {}
  on() {}
  webContents = { send: () => {}, on: () => {} };
};

const Notification = class {
  constructor(opts) { this._opts = opts; }
  show() {
    // In CLI mode, print notifications to stderr instead of desktop popup
    console.error(`[Notification] ${this._opts?.title || ''}: ${this._opts?.body || ''}`);
  }
};

const ipcMain = {
  on: () => {},
  handle: () => {},
  removeHandler: () => {},
  removeAllListeners: () => {},
};

const Menu = {
  buildFromTemplate: () => ({}),
  setApplicationMenu: () => {},
};

const shell = {
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(''),
};

const dialog = {
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: () => Promise.resolve({ canceled: true }),
  showMessageBox: () => Promise.resolve({ response: 0 }),
};

module.exports = {
  app,
  BrowserWindow,
  Notification,
  ipcMain,
  Menu,
  shell,
  dialog,
};
