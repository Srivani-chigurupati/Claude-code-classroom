import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CodeReviewOrchestrator } from './orchestrator.js';
import { ReportGenerator } from './utils/report-generator.js';
import { formatError, isReviewError } from './utils/error-handler.js';
import { logger } from './utils/logger.js';
import type { ReviewReport } from './types/report-types.js';

const USAGE = [
  'Usage: npm run dev -- <owner> <repo> <pr-number>',
  'Example: npm run dev -- octocat Hello-World 1'
].join('\n');

/** Directory the three report files are written to. */
const REPORTS_DIR = process.env.REPORTS_DIR ?? 'reports';

function fail(message: string): never {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

/**
 * Validate CLI arguments and return the parsed PR coordinates.
 *
 * `process.argv.slice(2)` is passed in, so argv[0] (node) and argv[1] (script)
 * are already stripped by the caller.
 */
export function parseArgs(args: string[]): {
  owner: string;
  repo: string;
  prNumber: number;
} {
  const [owner, repo, prStr] = args;

  if (!owner || !repo || !prStr) {
    fail(`Missing arguments - owner, repo and pr-number are all required.\n${USAGE}`);
  }

  // Number() rejects "12abc" (NaN) where parseInt would silently accept it.
  const prNumber = Number(prStr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    fail(
      `Invalid pull request number: "${prStr}". Expected a positive integer.\n${USAGE}`
    );
  }

  return { owner, repo, prNumber };
}

/**
 * Require exactly one working auth method: an Anthropic API key, or AWS
 * credentials for Bedrock.
 */
function validateAuth(): void {
  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
  // Bedrock needs BOTH halves of the credential pair, hence AND not OR.
  const hasAwsKeys = Boolean(
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
  );

  if (hasAwsKeys) {
    if (!process.env.AWS_REGION) {
      fail('AWS credentials found but AWS_REGION is not set. Set AWS_REGION (e.g. us-east-1).');
    }
    console.log('🔐 Using AWS Bedrock authentication');
    return;
  }

  if (hasAnthropicKey) {
    console.log('🔐 Using Anthropic API authentication');
    return;
  }

  fail(
    'No authentication configured. Choose ONE:\n' +
      '  1) Anthropic API:  ANTHROPIC_API_KEY=sk-ant-...\n' +
      '  2) AWS Bedrock:    AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION\n' +
      '(In the Vocareum workspace ANTHROPIC_API_KEY is already in your environment.)'
  );
}

/**
 * ANTHROPIC_MODEL is required for both auth methods - the orchestrator never
 * hardcodes a model id.
 */
function validateModel(): string {
  const model = process.env.ANTHROPIC_MODEL;
  if (!model) {
    fail(
      'ANTHROPIC_MODEL is not set. Add it to .env:\n' +
        '  Anthropic API: ANTHROPIC_MODEL=claude-sonnet-4-5-20250929\n' +
        '  AWS Bedrock:   ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0'
    );
  }
  return model;
}

/**
 * Write the Markdown, HTML and JSON reports for one PR.
 *
 * Filenames follow `<owner>_<repo>_<pr>.<ext>` so the nine submission files
 * sort together by PR.
 */
export async function writeReports(
  report: ReviewReport,
  owner: string,
  repo: string,
  prNumber: number,
  reportsDir: string = REPORTS_DIR
): Promise<string[]> {
  const generator = new ReportGenerator();
  await mkdir(reportsDir, { recursive: true });

  const base = `${owner}_${repo}_${prNumber}`;
  const outputs: Array<{ file: string; body: string }> = [
    { file: `${base}.json`, body: generator.generateJSONReport(report) },
    { file: `${base}.md`, body: generator.generateMarkdownReport(report) },
    { file: `${base}.html`, body: generator.generateHTMLReport(report) }
  ];

  const written: string[] = [];
  for (const { file, body } of outputs) {
    const target = path.join(reportsDir, file);
    await writeFile(target, body, 'utf-8');
    written.push(target);
  }

  return written;
}

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 * Usage: npm run dev <owner> <repo> <pr-number>
 */
async function main() {
  const { owner, repo, prNumber } = parseArgs(process.argv.slice(2));

  validateAuth();
  const model = validateModel();

  console.log(`🔍 Reviewing ${owner}/${repo}#${prNumber}`);
  console.log(`🤖 Model: ${model}\n`);

  const startedAt = Date.now();

  try {
    const orchestrator = new CodeReviewOrchestrator();
    const report = await orchestrator.reviewPullRequest(owner, repo, prNumber);

    const written = await writeReports(report, owner, repo, prNumber);

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\n✅ Review complete in ${elapsed}s`);
    console.log(`   Overall score : ${report.summary.overallScore}/100`);
    console.log(`   Files reviewed: ${report.summary.totalFiles}`);
    console.log(`   Critical issues: ${report.summary.criticalIssues}`);
    console.log(`   Tests needed   : ${report.summary.highPriorityTests}`);
    console.log(`   Refactorings   : ${report.summary.refactoringOpportunities}`);
    console.log('\n📄 Reports written:');
    for (const file of written) {
      console.log(`   ${file}`);
    }
  } catch (error) {
    // Report the problem, not a stack trace. The full error (with stack) is in
    // logs/error.log for debugging.
    logger.error('Review failed', { owner, repo, prNumber, error });

    const detail = isReviewError(error)
      ? `${formatError(error)}\n   ${JSON.stringify(error.metadata ?? {})}`
      : formatError(error);

    fail(
      `Review of ${owner}/${repo}#${prNumber} failed.\n   ${detail}\n\n` +
        'Common causes:\n' +
        '  - GITHUB_TOKEN missing or lacking access to a private repo\n' +
        '  - the PR number does not exist in that repository\n' +
        '  - npx unavailable, so an MCP server could not start\n' +
        'See logs/error.log for the full stack trace.'
    );
  }
}

/**
 * Only run when this file is the process entry point, so tests can import
 * `parseArgs` and `writeReports` without triggering a review or process.exit.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main();
}
