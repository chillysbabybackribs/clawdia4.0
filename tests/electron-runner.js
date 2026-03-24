/**
 * Electron Test Runner — runs Vitest test files under Electron's runtime so
 * native modules (for example `better-sqlite3`) use the correct ABI.
 *
 * Usage:
 *   npx electron --no-sandbox tests/electron-runner.js tests/test-routing.ts
 */
const { app } = require('electron');
const { spawnSync } = require('child_process');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const testFiles = process.argv.slice(2).filter((f) => f.endsWith('.ts'));

  if (testFiles.length === 0) {
    console.error('Usage: npx electron --no-sandbox tests/electron-runner.js <test.ts> [...]');
    app.exit(1);
    return;
  }

  const projectRoot = path.resolve(__dirname, '..');
  const vitestCli = path.join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs');
  let allPassed = true;

  for (const tsFile of testFiles) {
    const name = path.basename(tsFile, '.ts');
    console.log(`\n── ${name} ──`);

    const result = spawnSync(process.execPath, [
      '--no-sandbox',
      vitestCli,
      'run',
      tsFile,
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    const output = `${result.stdout || ''}${result.stderr || ''}`
      .split('\n')
      .filter((line) => !/(libEGL|libGL|GPU|MESA|Gtk-WARNING|DBus|DevTools)/.test(line))
      .join('\n')
      .trim();

    if (output) console.log(output);
    if (result.status !== 0) allPassed = false;
  }

  app.exit(allPassed ? 0 : 1);
});

app.on('window-all-closed', () => {});
