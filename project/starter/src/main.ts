import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

import { CodeReviewOrchestrator } from './orchestrator.js';

const USAGE = 'Usage: npm run dev -- <owner> <repo> <pr-number>\nExample: npm run dev -- octocat Hello-World 1';

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

/**
 * Validate CLI arguments and return the parsed PR coordinates.
 */
function parseArgs(argv: string[]): { owner: string; repo: string; prNumber: number } {
  const [owner, repo, prStr] = argv;

  if (!owner || !repo || !prStr) {
    fail(`Missing arguments.\n${USAGE}`);
  }

  const prNumber = Number(prStr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    fail(`Invalid pull request number: "${prStr}". Expected a positive integer.\n${USAGE}`);
  }

  return { owner, repo, prNumber };
}

/**
 * Require exactly one working auth method: an Anthropic API key, or AWS
 * credentials for Bedrock.
 */
function validateAuth(): void {
  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
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
 * Main entry point for the Claude Multi-Agent Code Review System
 * Usage: npm run dev <owner> <repo> <pr-number>
 */
async function main() {
  const { owner, repo, prNumber } = parseArgs(process.argv.slice(2));

  validateAuth();
  const model = validateModel();

  console.log(`🔍 Reviewing ${owner}/${repo}#${prNumber} with ${model}\n`);

  try {
    const orchestrator = new CodeReviewOrchestrator();
    const report = await orchestrator.reviewPullRequest(owner, repo, prNumber);

    console.log(JSON.stringify(report, null, 2));

    // TODO (Part 2): render the report with ReportGenerator and write
    // Markdown, HTML and JSON files into reports/.
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
