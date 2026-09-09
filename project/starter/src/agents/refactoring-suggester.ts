import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { REFACTORING_SUGGESTER_PROMPT } from '../prompts/refactoring-suggester.prompt.js';

export const REFACTORING_SUGGESTER = 'refactoring-suggester';

/**
 * Refactoring Suggester subagent.
 *
 * Distinct from code-quality-analyzer: that agent finds defects, this one
 * proposes behavior-preserving structural change (extraction, simplification,
 * modernization, better patterns) with before/after snippets.
 *
 * Tools (least privilege - it proposes edits as text, it never applies them):
 * - Read/Grep/Glob                  read the file and check every call site
 *                                   before proposing a rename or extraction
 * - mcp__github__get_file_contents  fetch the PR version of a file
 */
export const refactoringSuggester: AgentDefinition = {
  description:
    'Identifies behavior-preserving refactorings for a single source file - extract-function, rename, modernize, simplify and pattern improvements - each with verbatim before/after code and its benefit. Use this agent whenever you need to know how a file could be RESTRUCTURED, as opposed to what is broken in it. Invoke it once per file with the file path, owner/repo/ref and the file patch.',
  prompt: REFACTORING_SUGGESTER_PROMPT,
  tools: ['Read', 'Grep', 'Glob', 'mcp__github__get_file_contents'],
  model: 'inherit'
};
