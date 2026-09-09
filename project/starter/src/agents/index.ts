/**
 * Subagent exports
 *
 * `subagents` is the map handed to the SDK `agents` option. The keys are the
 * names the orchestrator prompt uses in its Task calls - keep the two in sync.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { codeQualityAnalyzer, CODE_QUALITY_ANALYZER } from './code-quality-analyzer.js';
import { testCoverageAnalyzer, TEST_COVERAGE_ANALYZER } from './test-coverage-analyzer.js';
import { refactoringSuggester, REFACTORING_SUGGESTER } from './refactoring-suggester.js';

export { codeQualityAnalyzer, CODE_QUALITY_ANALYZER } from './code-quality-analyzer.js';
export { testCoverageAnalyzer, TEST_COVERAGE_ANALYZER } from './test-coverage-analyzer.js';
export { refactoringSuggester, REFACTORING_SUGGESTER } from './refactoring-suggester.js';

export const subagents: Record<string, AgentDefinition> = {
  [CODE_QUALITY_ANALYZER]: codeQualityAnalyzer,
  [TEST_COVERAGE_ANALYZER]: testCoverageAnalyzer,
  [REFACTORING_SUGGESTER]: refactoringSuggester
};

/**
 * Union of every tool the subagents declare.
 *
 * `allowedTools` on the top-level query is a session-wide permission filter, so
 * it has to cover the subagents' tools too - otherwise a stricter
 * `permissionMode` than `bypassPermissions` blocks them. Deriving the union here
 * keeps that list in sync when an agent's tools change.
 */
export const subagentTools: string[] = [
  ...new Set(Object.values(subagents).flatMap((agent) => agent.tools ?? []))
];

/** Versions recorded in ReviewReport.metadata.agentVersions. */
export const AGENT_VERSIONS: Record<string, string> = {
  [CODE_QUALITY_ANALYZER]: '1.0.0',
  [TEST_COVERAGE_ANALYZER]: '1.0.0',
  [REFACTORING_SUGGESTER]: '1.0.0'
};
