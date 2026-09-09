import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

import { ReviewReportSchema, ReviewReportJSONSchema } from './types/report-types.js';
import type { ReviewReport } from './types/report-types.js';
import { subagents, subagentTools, AGENT_VERSIONS } from './agents/index.js';
import { buildOrchestratorPrompt } from './prompts/index.js';
import {
  mcpServersConfig,
  githubTools,
  eslintTools,
  hasGitHubToken
} from './config/mcp.config.js';
import { logger } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Directory that contains `.claude/skills/`, so the Skill tool can find them. */
const DEFAULT_PROJECT_ROOT = process.env.PROJECT_ROOT ?? path.resolve(__dirname, '..');

/**
 * Orchestrator configuration options
 */
export interface OrchestratorOptions {
  /**
   * Model for the orchestrator. Subagents use `model: 'inherit'`, so this one
   * value drives the whole run. Defaults to `process.env.ANTHROPIC_MODEL` -
   * never hardcoded, so the same build works against the Anthropic API
   * (`claude-sonnet-4-5-20250929`) and Bedrock
   * (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`).
   */
  model?: string;
  /** Turn budget. Multi-agent coordination needs room: 3 agents x N files. */
  maxTurns?: number;
  /** `bypassPermissions` for unattended CI/CD; the agents are read-only. */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  /** Root used as `cwd`, and where `.claude/skills/` is discovered. */
  projectRoot?: string;
  /** Maximum PR files sent to the subagents, to bound cost and turns. */
  maxFiles?: number;
  /** Override the subagent registry (tests inject fakes here). */
  agents?: Record<string, AgentDefinition>;
}

/** Shape we read off the SDK message stream. */
interface StreamMessage {
  type: string;
  subtype?: string;
  structured_output?: unknown;
  message?: { content?: unknown };
  mcp_servers?: Array<{ name: string; status: string }>;
  parent_tool_use_id?: string | null;
  num_turns?: number;
  total_cost_usd?: number;
}

interface ToolUseBlock {
  type: string;
  name?: string;
  input?: { subagent_type?: string; description?: string };
}

async function* singleUserMessage(content: string) {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content },
    parent_tool_use_id: null,
    session_id: 'code-review-orchestrator'
  };
}

/**
 * Main Code Review Orchestrator
 * Coordinates subagents to analyze pull requests and generate comprehensive reports
 */
export class CodeReviewOrchestrator {
  private readonly model: string;
  private readonly maxTurns: number;
  private readonly permissionMode: NonNullable<OrchestratorOptions['permissionMode']>;
  private readonly projectRoot: string;
  private readonly maxFiles: number;
  private readonly agents: Record<string, AgentDefinition>;

  constructor(options: OrchestratorOptions = {}) {
    const model = options.model ?? process.env.ANTHROPIC_MODEL;
    if (!model) {
      throw new Error(
        'ANTHROPIC_MODEL is not set. Set it in .env (e.g. claude-sonnet-4-5-20250929) ' +
          'or pass { model } to CodeReviewOrchestrator.'
      );
    }

    this.model = model;
    this.maxTurns = options.maxTurns ?? 60;
    this.permissionMode = options.permissionMode ?? 'bypassPermissions';
    this.projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;
    this.maxFiles = options.maxFiles ?? 5;
    this.agents = options.agents ?? subagents;
  }

  /**
   * Review a pull request using parallel subagent analysis
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @returns Complete review report
   */
  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    if (!hasGitHubToken) {
      logger.warn(
        'GITHUB_TOKEN is not set - using unauthenticated GitHub access (public repos only, 60 requests/hour).'
      );
    }

    logger.info('Starting code review', { owner, repo, prNumber, model: this.model });
    const startedAt = Date.now();

    const prompt = buildOrchestratorPrompt({
      owner,
      repo,
      prNumber,
      maxFiles: this.maxFiles
    });

    let structuredOutput: unknown;

    for await (const raw of query({
      prompt: singleUserMessage(prompt),
      options: {
        // Working directory + project settings are what let the Skill tool
        // discover `.claude/skills/`.
        cwd: this.projectRoot,
        settingSources: ['project'],
        model: this.model,
        // External integrations: GitHub for PR data, ESLint for local linting.
        mcpServers: mcpServersConfig,
        // `Task` is mandatory - without it the orchestrator cannot spawn a
        // single subagent and silently does all the work itself. The list is a
        // session-wide filter, so it also has to cover the subagents' tools.
        allowedTools: [
          ...new Set<string>([
            'Task',
            ...githubTools,
            ...eslintTools,
            ...subagentTools
          ])
        ],
        agents: this.agents,
        outputFormat: {
          type: 'json_schema',
          schema: ReviewReportJSONSchema
        },
        maxTurns: this.maxTurns,
        // Unattended CI/CD: nobody is present to approve a tool call.
        permissionMode: this.permissionMode
      }
    })) {
      // The SDK message union evolves between releases; read it through one
      // narrow local shape instead of pinning to per-version type names.
      const message = raw as unknown as StreamMessage;

      if (message.type === 'system' && message.subtype === 'init') {
        this.assertMcpServersConnected(message);
        continue;
      }

      if (message.type === 'assistant') {
        this.logToolUse(message);
        continue;
      }

      if (message.type !== 'result') {
        continue;
      }

      if (message.subtype === 'success' && message.structured_output) {
        logger.debug('Orchestrator finished', {
          turns: message.num_turns,
          costUsd: message.total_cost_usd
        });
        structuredOutput = message.structured_output;
        break;
      }

      if (message.subtype === 'error_max_structured_output_retries') {
        throw new Error(
          'The agent could not produce output matching ReviewReportSchema after the maximum retries. ' +
            'Check that the orchestrator prompt still describes every required field.'
        );
      }

      throw new Error(`Code review failed: ${message.subtype ?? 'unknown result'}`);
    }

    if (structuredOutput === undefined) {
      throw new Error('The agent stream ended without returning structured output.');
    }

    const report = this.finalizeReport(structuredOutput, owner, repo, prNumber, startedAt);

    logger.info('Code review completed', {
      owner,
      repo,
      prNumber,
      score: report.summary.overallScore,
      files: report.summary.totalFiles,
      duration: report.metadata.duration
    });

    return report;
  }

  /**
   * Fail fast when an MCP server did not come up - otherwise the run burns
   * turns while the agent retries tools that will never exist.
   */
  private assertMcpServersConnected(message: StreamMessage): void {
    for (const server of message.mcp_servers ?? []) {
      logger.debug('MCP server status', { server: server.name, status: server.status });
      if (server.status === 'failed') {
        throw new Error(
          `MCP server '${server.name}' failed to connect. Check the package name in ` +
            'src/config/mcp.config.ts, that npx is on PATH, and that required env vars are set.'
        );
      }
    }
  }

  /** Trace which subagent the orchestrator is delegating to. */
  private logToolUse(message: StreamMessage): void {
    const content = message.message?.content;
    if (!Array.isArray(content)) {
      return;
    }

    for (const block of content as ToolUseBlock[]) {
      if (block.type !== 'tool_use') {
        continue;
      }
      if (block.name === 'Task') {
        logger.info('Delegating to subagent', {
          agent: block.input?.subagent_type ?? 'unknown',
          task: block.input?.description ?? ''
        });
      } else {
        logger.debug('Orchestrator tool call', { tool: block.name });
      }
    }
  }

  /**
   * Overwrite the fields the caller measures rather than the model guesses
   * (real timings, the requested PR, recomputed totals), then validate.
   *
   * `safeParse` rather than `parse`: we want the validation errors in the
   * message instead of a raw ZodError bubbling out of the SDK call.
   */
  private finalizeReport(
    structuredOutput: unknown,
    owner: string,
    repo: string,
    prNumber: number,
    startedAt: number
  ): ReviewReport {
    const draft = {
      ...(structuredOutput as Record<string, unknown>),
      pullRequest: { owner, repo, number: prNumber },
      metadata: {
        analyzedAt: new Date().toISOString(),
        duration: Date.now() - startedAt,
        agentVersions: AGENT_VERSIONS
      }
    };

    const parsed = ReviewReportSchema.safeParse(draft);

    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      logger.error('Report validation failed', { issues });
      throw new Error(`Report validation failed - ${issues}`);
    }

    return {
      ...parsed.data,
      summary: recomputeSummary(parsed.data.fileReviews)
    };
  }
}

/**
 * Derive the summary counters from the per-file results, so the headline
 * numbers can never drift from the findings underneath them.
 */
function recomputeSummary(
  fileReviews: ReviewReport['fileReviews']
): ReviewReport['summary'] {
  const totalFiles = fileReviews.length;

  const scoreTotal = fileReviews.reduce((sum, r) => sum + r.codeQuality.overallScore, 0);

  const criticalIssues = fileReviews.reduce(
    (sum, r) => sum + r.codeQuality.issues.filter((i) => i.severity === 'critical').length,
    0
  );

  const highPriorityTests = fileReviews.reduce(
    (sum, r) =>
      sum +
      r.testCoverage.untestedPaths.filter(
        (p) => p.priority === 'critical' || p.priority === 'high'
      ).length,
    0
  );

  const refactoringOpportunities = fileReviews.reduce(
    (sum, r) => sum + r.refactorings.suggestions.length,
    0
  );

  return {
    totalFiles,
    overallScore: totalFiles === 0 ? 0 : Math.round(scoreTotal / totalFiles),
    criticalIssues,
    highPriorityTests,
    refactoringOpportunities
  };
}

/** Alias matching the name used in the course guide's quick test. */
export { CodeReviewOrchestrator as Orchestrator };
