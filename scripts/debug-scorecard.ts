import * as fs from 'fs';
import * as path from 'path';

async function main(): Promise<void> {
  const argDb = process.argv.find((arg) => arg.startsWith('--db='))?.slice('--db='.length);
  const dbPath = argDb || process.env.CLAWDIA_DB_PATH || path.join(process.cwd(), '.tmp', 'scorecard-debug.sqlite');

  process.env.CLAWDIA_DB_PATH = dbPath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const { getCapabilityScorecard } = await import('../src/main/agent/system-audit');
  const { closeDb } = await import('../src/main/db/database');

  try {
    const scorecard = getCapabilityScorecard();
    console.log(`[scorecard] db=${dbPath}`);
    console.log(scorecard.text);
    console.log('\nJSON');
    console.log(JSON.stringify({
      generatedAt: new Date(scorecard.generatedAt).toISOString(),
      overallScore: scorecard.overallScore,
      workflowSummary: scorecard.workflowSummary,
      scenarios: scorecard.scenarioSummaries,
    }, null, 2));
  } finally {
    closeDb();
  }
}

main().catch((error) => {
  console.error('[scorecard] failed:', error);
  process.exitCode = 1;
});
