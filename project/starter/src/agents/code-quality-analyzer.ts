import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { CODE_QUALITY_ANALYZER_PROMPT } from '../prompts/code-quality-analyzer.prompt.js';

/**
 * Agent name. The orchestrator prompt must use this exact string, otherwise
 * the Task tool reports "agent not found".
 */
export const CODE_QUALITY_ANALYZER = 'code-quality-analyzer';

/**
 * Code Quality Analyzer subagent.
 *
 * Tools (least privilege - read and search only, never write or execute):
 * - Read/Grep/Glob            inspect local files and trace symbol usage
 * - Skill                     invoke security-analysis / javascript-best-practices
 * - mcp__github__get_file_contents  fetch the PR version of a file
 * - mcp__eslint__lint-files   lint files that exist in the local working tree
 *
 * `model: 'inherit'` makes the subagent run on the same model as the
 * orchestrator, so ANTHROPIC_MODEL stays the single source of truth.
 */
export const codeQualityAnalyzer: AgentDefinition = {
  description:
    'Analyzes a single source file for security vulnerabilities, performance problems, bug risks and maintainability issues, and scores its quality 0-100. Use this agent whenever you need to know what is WRONG with a file. Invoke it once per file with the file path, owner/repo/ref and the file patch.',
  prompt: CODE_QUALITY_ANALYZER_PROMPT,
  tools: [
    'Read',
    'Grep',
    'Glob',
    'Skill',
    'mcp__github__get_file_contents',
    'mcp__eslint__lint-files'
  ],
  model: 'inherit'
};
