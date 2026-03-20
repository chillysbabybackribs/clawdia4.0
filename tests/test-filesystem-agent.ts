/**
 * Filesystem Agent Tests — Verifies quote lookup retrieval and index reuse.
 *
 * Run via Electron test runner because the executor uses better-sqlite3.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { executeFsFolderSummary, executeFsQuoteLookup, executeFsReorgPlan, executeFsDuplicateScan, executeFsApplyPlan } from '../src/main/agent/executors/core-executors';
import { getFilesystemExtraction, searchFilesystemExtractions } from '../src/main/db/filesystem-extractions';
import { closeDb } from '../src/main/db/database';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ❌ ${label}`);
  }
}

function section(name: string): void {
  console.log(`\n━━━ ${name} ━━━`);
}

function assertIncludes(text: string, needle: string, label: string): void {
  assert(text.includes(needle), `${label} (missing: ${needle})`);
}

const done = (async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-fs-agent-'));

  try {
    const exactSentence = 'Single Go binary serves both the JSON API and the built ui/dist/ as static files.';
    const exactFile = path.join(tmpDir, 'architecture-notes.txt');
    const nearFile = path.join(tmpDir, 'almost-match.txt');

    fs.writeFileSync(
      exactFile,
      [
        'Deployment notes',
        exactSentence,
        'This note explains the serving strategy.',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      nearFile,
      [
        'Deployment summary',
        'A single Go service can expose a JSON API and static frontend assets.',
        'This is intentionally similar but not exact.',
      ].join('\n'),
      'utf8',
    );

    const nestedDir = path.join(tmpDir, 'project-assets');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, 'roadmap.pdf'), 'fake roadmap pdf placeholder', 'utf8');
    fs.writeFileSync(path.join(nestedDir, 'budget.csv'), 'month,amount\njan,1200', 'utf8');
    fs.writeFileSync(path.join(nestedDir, 'notes.md'), '# Notes\n\nFolder summary test.', 'utf8');

    section('First lookup seeds extraction cache');
    const firstResult = await executeFsQuoteLookup({
      query: exactSentence,
      rootPath: tmpDir,
      maxResults: 3,
      maxFiles: 20,
    });

    assertIncludes(firstResult, '[fs_quote_lookup]', 'Returns fs_quote_lookup header');
    assertIncludes(firstResult, 'BEST MATCH:', 'Exact lookup reports a best match');
    assertIncludes(firstResult, exactFile, 'Exact file is returned');
    assertIncludes(firstResult, 'type=exact', 'Exact match is scored as exact');
    assertIncludes(firstResult, 'BEST MATCH TYPE: exact', 'Exact lookup reports exact best-match type');
    assertIncludes(firstResult, 'Indexed hits: 0.', 'First lookup starts without indexed hits');

    const exactStat = fs.statSync(exactFile);
    const cached = getFilesystemExtraction(exactFile, exactStat.size, exactStat.mtimeMs);
    assert(cached !== null, 'Exact file extraction persisted');
    assert(cached?.text?.includes(exactSentence) === true, 'Persisted extraction contains the exact sentence');

    const indexedResults = searchFilesystemExtractions(tmpDir, exactSentence, 3);
    assert(indexedResults.length >= 1, 'Indexed search returns at least one match');
    assert(indexedResults[0]?.path === exactFile, 'Indexed search ranks the exact file first');

    section('Second lookup reuses lexical index');
    const secondResult = await executeFsQuoteLookup({
      query: exactSentence,
      rootPath: tmpDir,
      maxResults: 1,
      maxFiles: 20,
    });

    assertIncludes(secondResult, 'Indexed hits: 1.', 'Second lookup hits the lexical index');
    assertIncludes(secondResult, 'Scanned 0 candidate files', 'Second lookup avoids a filesystem rescan');
    assertIncludes(secondResult, 'BEST MATCH CONFIDENCE:', 'Indexed lookup reports best-match confidence');
    assertIncludes(secondResult, exactFile, 'Second lookup still returns the correct file');

    section('Semantic fallback handles paraphrased queries');
    const paraphraseResult = await executeFsQuoteLookup({
      query: 'Find the file saying one Go executable serves the JSON API and static frontend assets.',
      rootPath: tmpDir,
      maxResults: 3,
      maxFiles: 20,
    });

    assertIncludes(paraphraseResult, 'Semantic fallback:', 'Paraphrase path reports semantic fallback');
    assertIncludes(paraphraseResult, exactFile, 'Paraphrase query still returns the correct file');
    assertIncludes(paraphraseResult, 'type=semantic', 'Paraphrase result is marked semantic');
    assertIncludes(paraphraseResult, 'RECOMMENDATION:', 'Paraphrase result includes recommendation guidance');

    section('Folder summary gives structured directory overview');
    const folderSummary = await executeFsFolderSummary({
      path: tmpDir,
      depth: 3,
      maxEntries: 50,
    });

    assertIncludes(folderSummary, '[fs_folder_summary]', 'Folder summary returns tool header');
    assertIncludes(folderSummary, 'Top file types:', 'Folder summary reports dominant file types');
    assertIncludes(folderSummary, 'Largest files:', 'Folder summary reports largest files');
    assertIncludes(folderSummary, nestedDir, 'Folder summary includes busiest subdirectory information');

    section('Reorg plan proposes safe categorized moves');
    const messyDir = path.join(tmpDir, 'messy-drop');
    fs.mkdirSync(messyDir, { recursive: true });
    const imageFile = path.join(messyDir, 'Screenshot 2026-03-19.png');
    const archiveFile = path.join(messyDir, 'client-export.zip');
    const noteFile = path.join(messyDir, 'meeting-notes.md');
    fs.writeFileSync(imageFile, 'png placeholder', 'utf8');
    fs.writeFileSync(archiveFile, 'zip placeholder', 'utf8');
    fs.writeFileSync(noteFile, '# Meeting notes', 'utf8');

    const reorgPlan = await executeFsReorgPlan({
      path: messyDir,
      depth: 2,
      maxEntries: 50,
      maxMoves: 10,
    });

    assertIncludes(reorgPlan, '[fs_reorg_plan]', 'Reorg plan returns tool header');
    assertIncludes(reorgPlan, 'Planning only. No files were moved.', 'Reorg plan is explicitly non-destructive');
    assertIncludes(reorgPlan, path.join(messyDir, 'Images'), 'Reorg plan proposes Images folder');
    assertIncludes(reorgPlan, path.join(messyDir, 'Archives'), 'Reorg plan proposes Archives folder');
    assertIncludes(reorgPlan, path.join(messyDir, 'Notes'), 'Reorg plan proposes Notes folder');
    assertIncludes(reorgPlan, `${imageFile} -> ${path.join(messyDir, 'Images', 'Screenshot 2026-03-19.png')}`, 'Reorg plan maps image file to Images bucket');
    assertIncludes(reorgPlan, 'Recommendation: review the planned moves before applying any filesystem changes.', 'Reorg plan includes review guidance');

    section('Reorg plan preserves documentation structure');
    const docsDir = path.join(tmpDir, 'docs');
    const specsDir = path.join(docsDir, 'specs');
    const plansDir = path.join(docsDir, 'plans');
    const superpowersDir = path.join(docsDir, 'superpowers');
    const nestedNamespacedSpecsDir = path.join(superpowersDir, 'specs');
    const nestedNamespacedPlansDir = path.join(superpowersDir, 'plans');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.mkdirSync(plansDir, { recursive: true });
    fs.mkdirSync(nestedNamespacedSpecsDir, { recursive: true });
    fs.mkdirSync(nestedNamespacedPlansDir, { recursive: true });
    const rootAudit = path.join(docsDir, 'VALIDATION-GUI-REALITY-CHECK.md');
    const nestedSpec = path.join(specsDir, '2026-03-19-platform-expansion-design.md');
    const nestedPlan = path.join(plansDir, '2026-03-19-async-runs.md');
    const namespacedSpec = path.join(nestedNamespacedSpecsDir, '2026-03-19-cli-anything-pipeline-design.md');
    const namespacedPlan = path.join(nestedNamespacedPlansDir, '2026-03-19-cli-anything-pipeline.md');
    fs.writeFileSync(rootAudit, '# Audit doc', 'utf8');
    fs.writeFileSync(nestedSpec, '# Spec doc', 'utf8');
    fs.writeFileSync(nestedPlan, '# Plan doc', 'utf8');
    fs.writeFileSync(namespacedSpec, '# Namespaced spec doc', 'utf8');
    fs.writeFileSync(namespacedPlan, '# Namespaced plan doc', 'utf8');

    const docsPlan = await executeFsReorgPlan({
      path: docsDir,
      depth: 3,
      maxEntries: 50,
      maxMoves: 10,
    });

    assertIncludes(docsPlan, 'Mode: documentation-aware; existing semantic subfolders will be preserved.', 'Docs reorg enters documentation-aware mode');
    assertIncludes(docsPlan, `${rootAudit} -> ${path.join(docsDir, 'audits', 'VALIDATION-GUI-REALITY-CHECK.md')}`, 'Loose audit doc is normalized into audits bucket');
    assert(!docsPlan.includes(`${nestedSpec} ->`), 'Nested spec is preserved instead of flattened');
    assert(!docsPlan.includes(`${nestedPlan} ->`), 'Nested plan is preserved instead of flattened');
    assert(!docsPlan.includes(`${namespacedSpec} ->`), 'Namespaced spec subtree is preserved instead of flattened');
    assert(!docsPlan.includes(`${namespacedPlan} ->`), 'Namespaced plan subtree is preserved instead of flattened');
    assertIncludes(docsPlan, 'Preserved structured docs: 4 files.', 'Docs reorg reports preserved nested structure');
    assertIncludes(docsPlan, path.join(docsDir, 'superpowers', 'specs'), 'Docs reorg lists namespaced protected subtree');

    section('Duplicate scan groups exact duplicates safely');
    const dupesDir = path.join(tmpDir, 'dupes');
    fs.mkdirSync(dupesDir, { recursive: true });
    const dupA = path.join(dupesDir, 'photo-copy-a.png');
    const dupB = path.join(dupesDir, 'photo-copy-b.png');
    const uniqueFile = path.join(dupesDir, 'different.png');
    fs.writeFileSync(dupA, 'same-image-bytes', 'utf8');
    fs.writeFileSync(dupB, 'same-image-bytes', 'utf8');
    fs.writeFileSync(uniqueFile, 'different-image-bytes', 'utf8');

    const duplicateScan = await executeFsDuplicateScan({
      path: dupesDir,
      depth: 2,
      maxEntries: 50,
      maxGroups: 10,
    });

    assertIncludes(duplicateScan, '[fs_duplicate_scan]', 'Duplicate scan returns tool header');
    assertIncludes(duplicateScan, 'Found 1 exact duplicate group', 'Duplicate scan finds one duplicate group');
    assertIncludes(duplicateScan, dupA, 'Duplicate scan includes first duplicate path');
    assertIncludes(duplicateScan, dupB, 'Duplicate scan includes second duplicate path');
    assertIncludes(duplicateScan, 'Potential reclaimable bytes:', 'Duplicate scan reports reclaimable bytes');
    assertIncludes(duplicateScan, 'Analysis only. No files were deleted or moved.', 'Duplicate scan is explicitly non-destructive');

    section('Apply plan executes reviewed moves safely');
    const applyDir = path.join(tmpDir, 'apply-plan');
    const sourceDir = path.join(applyDir, 'incoming');
    const destDir = path.join(applyDir, 'organized');
    fs.mkdirSync(sourceDir, { recursive: true });
    const sourceOne = path.join(sourceDir, 'alpha.txt');
    const sourceTwo = path.join(sourceDir, 'beta.txt');
    fs.writeFileSync(sourceOne, 'alpha', 'utf8');
    fs.writeFileSync(sourceTwo, 'beta', 'utf8');

    const applyResult = await executeFsApplyPlan({
      moves: [
        { source: sourceOne, destination: path.join(destDir, 'alpha.txt') },
        { source: sourceTwo, destination: path.join(destDir, 'beta.txt') },
      ],
    });

    assertIncludes(applyResult, '[fs_apply_plan]', 'Apply plan returns tool header');
    assertIncludes(applyResult, 'Applied 2 moves (skipped=0, errors=0).', 'Apply plan reports moved files');
    assert(!fs.existsSync(sourceOne), 'Apply plan removed first source after move');
    assert(!fs.existsSync(sourceTwo), 'Apply plan removed second source after move');
    assert(fs.existsSync(path.join(destDir, 'alpha.txt')), 'Apply plan created first destination');
    assert(fs.existsSync(path.join(destDir, 'beta.txt')), 'Apply plan created second destination');

    section('Project-aware reorg keeps docs and config with code');
    const projectDir = path.join(tmpDir, 'project-root');
    fs.mkdirSync(projectDir, { recursive: true });
    const readme = path.join(projectDir, 'README.md');
    const requirements = path.join(projectDir, 'requirements.txt');
    const configJson = path.join(projectDir, 'config.json');
    const mainPy = path.join(projectDir, 'main.py');
    const screenshot = path.join(projectDir, 'screenshot_001.png');
    fs.writeFileSync(readme, '# Project', 'utf8');
    fs.writeFileSync(requirements, 'fastapi==1.0.0', 'utf8');
    fs.writeFileSync(configJson, '{"port":3000}', 'utf8');
    fs.writeFileSync(mainPy, 'print("hello")', 'utf8');
    fs.writeFileSync(screenshot, 'png placeholder', 'utf8');

    const projectPlan = await executeFsReorgPlan({
      path: projectDir,
      depth: 2,
      maxEntries: 50,
      maxMoves: 20,
    });

    assertIncludes(projectPlan, 'Mode: project-aware; project docs and config files stay close to code.', 'Project reorg enters project-aware mode');
    assertIncludes(projectPlan, `${readme} -> ${path.join(projectDir, 'Code', 'README.md')}`, 'README stays with code in project-aware mode');
    assertIncludes(projectPlan, `${requirements} -> ${path.join(projectDir, 'Code', 'requirements.txt')}`, 'requirements stays with code in project-aware mode');
    assertIncludes(projectPlan, `${configJson} -> ${path.join(projectDir, 'Code', 'config.json')}`, 'config stays with code in project-aware mode');
    assertIncludes(projectPlan, `${mainPy} -> ${path.join(projectDir, 'Code', 'main.py')}`, 'source code still goes to Code bucket');
    assertIncludes(projectPlan, `${screenshot} -> ${path.join(projectDir, 'Images', 'screenshot_001.png')}`, 'non-project assets still go to domain bucket');
  } finally {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('\n' + '═'.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  ❌ ${failure}`);
    process.exit(1);
  }
  console.log('\n🎉 All filesystem agent tests passed!');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

export default done;
