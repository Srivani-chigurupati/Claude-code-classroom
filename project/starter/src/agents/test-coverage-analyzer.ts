import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { TEST_COVERAGE_ANALYZER_PROMPT } from '../prompts/test-coverage-analyzer.prompt.js';

export const TEST_COVERAGE_ANALYZER = 'test-coverage-analyzer';

/**
 * Test Coverage Analyzer subagent.
 *
 * It cannot run a test suite, so it estimates coverage statically: enumerate the
 * testable units in the source file, locate the test files that reference them,
 * and report what is left unasserted.
 *
 * Tools (least privilege - no Bash, so it cannot execute a test runner):
 * - Read/Grep/Glob                  read sources and search local test files
 * - mcp__github__get_file_contents  fetch the PR version of a file
 * - mcp__github__search_code        find test files elsewhere in the repository
 */
export const testCoverageAnalyzer: AgentDefinition = {
  description:
    'Evaluates test completeness for a single source file: finds the test files that cover it, estimates coverage 0-100, and suggests specific missing test cases with concrete inputs and expected results. Use this agent whenever you need to know what is NOT TESTED. Invoke it once per file with the file path, owner/repo/ref and the file patch.',
  prompt: TEST_COVERAGE_ANALYZER_PROMPT,
  tools: [
    'Read',
    'Grep',
    'Glob',
    'Skill',
    'mcp__github__get_file_contents',
    'mcp__github__search_code'
  ],
  model: 'inherit'
};
