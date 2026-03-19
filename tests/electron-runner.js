/**
 * Electron Test Runner — Bundles TS test files with esbuild, then runs them
 * inside Electron's Node.js runtime (correct native module ABI).
 *
 * Usage:
 *   npx electron --no-sandbox tests/electron-runner.js tests/test-routing.ts
 */
const { app } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const testFiles = process.argv.slice(2).filter(f => f.endsWith('.ts'));

  if (testFiles.length === 0) {
    console.error('Usage: npx electron --no-sandbox tests/electron-runner.js <test.ts> [...]');
    app.exit(1);
    return;
  }

  const projectRoot = path.resolve(__dirname, '..');
  const nodeModules = path.join(projectRoot, 'node_modules');

  // Set up temp DB for tests that need SQLite
  const tmpDir = path.join(os.tmpdir(), 'clawdia-test-' + process.pid);
  fs.mkdirSync(tmpDir, { recursive: true });
  process.env.CLAWDIA_DB_PATH = path.join(tmpDir, 'test.sqlite');

  let allPassed = true;

  for (const tsFile of testFiles) {
    const absTs = path.resolve(tsFile);
    const name = path.basename(tsFile, '.ts');
    const outJs = path.join(tmpDir, name + '.cjs');

    console.log(`\n── ${name} ──`);

    // Compile with esbuild: bundle everything EXCEPT node_modules packages
    // --packages=external makes ALL imports from node_modules resolve at runtime
    try {
      execSync(
        `npx esbuild "${absTs}" --bundle --platform=node --format=cjs --outfile="${outJs}" --packages=external --tsconfig=tsconfig.main.json 2>&1`,
        { cwd: projectRoot, stdio: 'pipe', timeout: 15000 }
      );
    } catch (err) {
      const msg = err.stdout?.toString() || err.stderr?.toString() || err.message;
      console.error(`  Compile failed:\n${msg.split('\n').slice(0, 8).join('\n')}`);
      allPassed = false;
      continue;
    }

    if (!fs.existsSync(outJs)) {
      console.error(`  Output not found: ${outJs}`);
      allPassed = false;
      continue;
    }

    // Patch require resolution: the bundled file lives in /tmp/ but needs
    // to resolve node_modules from the project root.
    const origResolveFilename = Module._resolveFilename;
    Module._resolveFilename = function(request, parent, isMain, options) {
      // If resolving from our temp bundle, add project node_modules to paths
      if (parent && parent.filename && parent.filename.startsWith(tmpDir)) {
        const opts = options || {};
        const paths = opts.paths ? [...opts.paths, nodeModules] : [nodeModules];
        try {
          return origResolveFilename.call(this, request, parent, isMain, { ...opts, paths });
        } catch {}
      }
      return origResolveFilename.call(this, request, parent, isMain, options);
    };

    // Run the compiled test inside Electron's Node
    try {
      require(outJs);
    } catch (err) {
      console.error(`  CRASHED: ${err.message}`);
      console.error(`  ${err.stack?.split('\n').slice(1, 3).join('\n  ')}`);
      allPassed = false;
    }

    // Restore original resolver
    Module._resolveFilename = origResolveFilename;
  }

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  app.exit(allPassed ? 0 : 1);
});

app.on('window-all-closed', () => {});
