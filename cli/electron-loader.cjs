/**
 * electron-loader.cjs
 *
 * Node.js module loader hook that intercepts `require('electron')` calls
 * and redirects them to the CLI electron shim.
 *
 * Used by: clawdia-cli (via tsx --require or node -r)
 */

'use strict';

const Module = require('module');
const path = require('path');

const SHIM_PATH = path.join(__dirname, 'electron-shim.cjs');

const _resolveFilename = Module._resolveFilename.bind(Module);

Module._resolveFilename = function(request, parent, isMain, options) {
  if (request === 'electron') {
    return SHIM_PATH;
  }
  return _resolveFilename(request, parent, isMain, options);
};
