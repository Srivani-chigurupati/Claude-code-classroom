import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The SDK is mocked so the whole suite runs with no API key and no network.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn()
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { CodeReviewOrchestrator, Orchestrator } from '../src/orchestrator.js';
import { writeReports } from '../src/main.js';
import { subagents, subagentTools, AGENT_VERSIONS } from '../src/agents/index.js';
import { ReviewReportSchema } from '../src/types/report-types.js';
import { ErrorCodes } from '../src/utils/error-handler.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const mockedQuery = vi.mocked(query);

const FILE_A = 'src/todo.ts';
const FILE_B = 'src/search.ts';

/** A file review with tunable counts, so summary math is observable. */
const fileReview = (
  file: string,
  opts: { score: number; criticals: number; highTests: number; refactors: number }
) => ({
  file,
  codeQuality: {
    file,
    issues: [
      ...Array.from({ length: opts.criticals }, (_, i) => ({
        line: i + 1,
        severity: 'critical' as const,
        category: 'security' as const,
        description: 'Injection risk.',
        suggestion: 'Parameterize the query.'
      })),
      {
        line: 99,
        severity: 'low' as const,
        category: 'style' as const,
        description: 'Naming could be clearer.',
        suggestion: 'Rename to loadTodos.'
      }
    ],
    overallScore: opts.score,
    summary: 'Summary for ' + file
  },
  testCoverage: {
    file,
    hasTests: true,
    testFiles: ['tests/todo.test.ts'],
    untestedPaths: [
      ...Array.from({ length: opts.highTests }, (_, i) => ({
        type: 'function' as const,
        location: `fn${i}:10`,
        priority: 'high' as const,
        reasoning: 'Untested exported function.',
        suggestedTest: 'Assert it throws on empty input.'
      })),
      {
        type: 'edge-case' as const,
        location: 'fnLow:20',
        priority: 'low' as const,
        reasoning: 'Trivial path.',
        suggestedTest: 'Assert the happy path.'
      }
    ],
    coverageEstimate: 55,
    summary: 'Coverage for ' + file
  },
  refactorings: {
    file,
    suggestions: Array.from({ length: opts.refactors }, (_, i) => ({
      type: 'modernize' as const,
      location: `block${i}`,
      impact: 'medium' as const,
      description: 'Use async/await.',
      before: 'p.then(x => x)',
      after: 'await p',
      benefits: 'Errors surface through try/catch.'
    })),
    summary: 'Refactorings for ' + file
  }
});

/** Deliberately wrong summary + metadata, so we can prove they get replaced. */
const structuredReport = () => ({
  pullRequest: { owner: 'wrong', repo: 'wrong', number: -1 },
  fileReviews: [
    fileReview(FILE_A, { score: 80, criticals: 2, highTests: 1, refactors: 3 }),
    fileReview(FILE_B, { score: 60, criticals: 1, highTests: 2, refactors: 1 })
  ],
  summary: {
    totalFiles: 999,
    overallScore: 1,
    criticalIssues: 999,
    highPriorityTests: 999,
    refactoringOpportunities: 999
  },
  recommendations: [
    {
      priority: 'critical' as const,
      category: 'Security',
      description: 'Parameterize both queries.',
      files: [FILE_A, FILE_B]
    }
  ],
  metadata: {
    analyzedAt: '1970-01-01T00:00:00.000Z',
    duration: 0,
    agentVersions: { stale: '0.0.0' }
  }
});

/** Build a fake SDK stream: init -> Task tool_use per agent -> result. */
function fakeStream(
  structuredOutput: unknown,
  opts: { subtype?: string; mcpFailed?: string } = {}
) {
  return async function* () {
    yield {
      type: 'system',
      subtype: 'init',
      mcp_servers: [
        { name: 'github', status: opts.mcpFailed === 'github' ? 'failed' : 'connected' },
        { name: 'eslint', status: opts.mcpFailed === 'eslint' ? 'failed' : 'connected' }
      ]
    };

    for (const agent of Object.keys(subagents)) {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Task',
              input: { subagent_type: agent, description: `analyze with ${agent}` }
            }
          ]
        }
      };
    }

    yield {
      type: 'result',
      subtype: opts.subtype ?? 'success',
      num_turns: 12,
      total_cost_usd: 0.12,
      structured_output: structuredOutput
    };
  };
}

let originalModel: string | undefined;

beforeEach(() => {
  originalModel = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_MODEL = MODEL;
  mockedQuery.mockReset();
});

afterEach(() => {
  if (originalModel === undefined) {
    delete process.env.ANTHROPIC_MODEL;
  } else {
    process.env.ANTHROPIC_MODEL = originalModel;
  }
});

describe('CodeReviewOrchestrator', () => {
  describe('Configuration', () => {
    it('should initialize with default options', () => {
      const orchestrator = new CodeReviewOrchestrator();
      expect(orchestrator).toBeInstanceOf(CodeReviewOrchestrator);

      const status = orchestrator.getRateLimiterStatus();
      expect(status.activeRequests).toBe(0);
      expect(status.availableRequests).toBe(50);
      expect(status.availableTokens).toBe(100000);
    });

    it('should accept custom rate limit configuration', () => {
      const orchestrator = new CodeReviewOrchestrator({
        rateLimits: { maxRequestsPerMinute: 3, maxTokensPerMinute: 9000 }
      });

      const status = orchestrator.getRateLimiterStatus();
      expect(status.availableRequests).toBe(3);
      expect(status.availableTokens).toBe(9000);
    });

    it('reads the model from ANTHROPIC_MODEL rather than hardcoding it', async () => {
      process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
      mockedQuery.mockImplementation(fakeStream(structuredReport()) as never);

      await new CodeReviewOrchestrator().reviewPullRequest('octocat', 'Hello-World', 1);

      const options = mockedQuery.mock.calls[0]?.[0]?.options;
      expect(options?.model).toBe('claude-haiku-4-5-20251001');
    });

    it('throws a helpful error when ANTHROPIC_MODEL is missing', () => {
      delete process.env.ANTHROPIC_MODEL;
      expect(() => new CodeReviewOrchestrator()).toThrow(/ANTHROPIC_MODEL is not set/);
    });

    it('exposes an Orchestrator alias', () => {
      expect(Orchestrator).toBe(CodeReviewOrchestrator);
    });
  });

  describe('Agent registry', () => {
    it('registers all three subagents', () => {
      expect(Object.keys(subagents).sort()).toEqual([
        'code-quality-analyzer',
        'refactoring-suggester',
        'test-coverage-analyzer'
      ]);
    });

    it('gives code-quality-analyzer the Skill tool', () => {
      expect(subagents['code-quality-analyzer']?.tools).toContain('Skill');
    });

    it('grants no write or execute tools to any subagent (least privilege)', () => {
      for (const tool of subagentTools) {
        expect(['Write', 'Edit', 'Bash', 'NotebookEdit']).not.toContain(tool);
      }
    });

    it('lets every subagent inherit the orchestrator model', () => {
      for (const agent of Object.values(subagents)) {
        expect(agent.model).toBe('inherit');
      }
    });
  });

  describe('reviewPullRequest', () => {
    it('passes the Task tool and all three agents to the SDK', async () => {
      mockedQuery.mockImplementation(fakeStream(structuredReport()) as never);

      await new CodeReviewOrchestrator().reviewPullRequest('octocat', 'Hello-World', 1);

      const options = mockedQuery.mock.calls[0]?.[0]?.options;
      expect(options?.allowedTools).toContain('Task');
      expect(Object.keys(options?.agents ?? {})).toHaveLength(3);
    });

    it('should fetch PR files from GitHub MCP', async () => {
      mockedQuery.mockImplementation(fakeStream(structuredReport()) as never);

      await new CodeReviewOrchestrator().reviewPullRequest('octocat', 'Hello-World', 1);

      const call = mockedQuery.mock.calls[0]?.[0];
      // Both GitHub MCP servers are configured and their PR tools are allowed.
      expect(Object.keys(call?.options?.mcpServers ?? {})).toEqual(['github', 'eslint']);
      expect(call?.options?.allowedTools).toContain('mcp__github__get_pull_request');
      expect(call?.options?.allowedTools).toContain('mcp__github__get_pull_request_files');
    });

    it('should spawn all 3 subagents in parallel', async () => {
      mockedQuery.mockImplementation(fakeStream(structuredReport()) as never);

      await new CodeReviewOrchestrator().reviewPullRequest('octocat', 'Hello-World', 1);

      // The orchestrator prompt instructs one Task call per agent per file, all
      // issued in a single message.
      const prompt = mockedQuery.mock.calls[0]?.[0]?.prompt;
      const rendered = JSON.stringify(await collect(prompt));
      for (const agent of Object.keys(subagents)) {
        expect(rendered).toContain(`Use the ${agent} agent to`);
      }
      expect(rendered).toContain('SINGLE message so they run in parallel');
    });

    it('should aggregate results into ReviewReport', async () => {
      mockedQuery.mockImplementation(fakeStream(structuredReport()) as never);

      const report = await new CodeReviewOrchestrator().reviewPullRequest(
        'airaamane',
        'simple-todo-app',
        2
      );

      expect(report.fileReviews.map((r) => r.file)).toEqual([FILE_A, FILE_B]);
      expect(report.fileReviews[0]?.codeQuality.overallScore).toBe(80);
      expect(report.recommendations).toHaveLength(1);
    });

    it('overwrites the PR block with the requested coordinates', async () => {
      mockedQuery.mockImplementation(fakeStream(structuredReport()) as never);

      const report = await new CodeReviewOrchestrator().reviewPullRequest(
        'airaamane',
        'simple-todo-app',
        3
      );

      expect(report.pullRequest).toEqual({
        owner: 'airaamane',
        repo: 'simple-todo-app',
        number: 3
      });
    });

    it('recomputes the summary from the findings, ignoring the model’s numbers', async () => {
      mockedQuery.mockImplementation(fakeStream(structuredReport()) as never);

      const report = await new CodeReviewOrchestrator().reviewPullRequest('o', 'r', 1);

      expect(report.summary).toEqual({
        totalFiles: 2,
        overallScore: 70, // mean of 80 and 60
        criticalIssues: 3, // 2 + 1
        highPriorityTests: 3, // 1 + 2
        refactoringOpportunities: 4 // 3 + 1
      });
    });

    it('replaces metadata with measured values and real agent versions', async () => {
      mockedQuery.mockImplementation(fakeStream(structuredReport()) as never);

      const before = Date.now();
      const report = await new CodeReviewOrchestrator().reviewPullRequest('o', 'r', 1);

      expect(report.metadata.agentVersions).toEqual(AGENT_VERSIONS);
      expect(report.metadata.duration).toBeGreaterThanOrEqual(0);
      expect(new Date(report.metadata.analyzedAt).getTime()).toBeGreaterThanOrEqual(before);
    });

    it('should validate output with Zod schema', async () => {
      mockedQuery.mockImplementation(fakeStream(structuredReport()) as never);

      const report = await new CodeReviewOrchestrator().reviewPullRequest('o', 'r', 1);
      expect(ReviewReportSchema.safeParse(report).success).toBe(true);
    });

    it('rejects structured output that does not match the schema', async () => {
      mockedQuery.mockImplementation(
        fakeStream({ pullRequest: {}, fileReviews: 'not-an-array' }) as never
      );

      await expect(
        new CodeReviewOrchestrator({ maxRetries: 1 }).reviewPullRequest('o', 'r', 1)
      ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
    });

    it('refuses an empty report instead of reporting success with score 0', async () => {
      // What a failed PR fetch actually produces: schema-valid, zero files.
      mockedQuery.mockImplementation(
        fakeStream({
          pullRequest: { owner: 'airaamane', repo: 'simple-todo-app', number: 1 },
          fileReviews: [],
          summary: {
            totalFiles: 0,
            overallScore: 0,
            criticalIssues: 0,
            highPriorityTests: 0,
            refactoringOpportunities: 0
          },
          recommendations: [
            {
              priority: 'critical',
              category: 'Data Retrieval',
              description: 'Failed to fetch pull request #1.',
              files: []
            }
          ],
          metadata: {
            analyzedAt: '2026-01-01T00:00:00.000Z',
            duration: 0,
            agentVersions: { x: '1.0.0' }
          }
        }) as never
      );

      await expect(
        new CodeReviewOrchestrator({ maxRetries: 1 }).reviewPullRequest(
          'airaamane',
          'simple-todo-app',
          1
        )
      ).rejects.toMatchObject({ code: ErrorCodes.PR_NOT_FOUND });
    });

    it('fails fast when an MCP server does not connect', async () => {
      mockedQuery.mockImplementation(
        fakeStream(structuredReport(), { mcpFailed: 'github' }) as never
      );

      await expect(
        new CodeReviewOrchestrator({ maxRetries: 1 }).reviewPullRequest('o', 'r', 1)
      ).rejects.toThrow(/MCP server 'github' failed to connect/);
    });

    it('surfaces a non-success result subtype as AGENT_FAILED', async () => {
      mockedQuery.mockImplementation(
        fakeStream(structuredReport(), { subtype: 'error_max_turns' }) as never
      );

      await expect(
        new CodeReviewOrchestrator({ maxRetries: 1 }).reviewPullRequest('o', 'r', 1)
      ).rejects.toMatchObject({ code: ErrorCodes.AGENT_FAILED });
    });

    it('retries a transient failure and then succeeds', async () => {
      let attempts = 0;
      mockedQuery.mockImplementation((() => {
        attempts++;
        if (attempts === 1) {
          throw new Error('transient MCP startup failure');
        }
        return fakeStream(structuredReport())();
      }) as never);

      const report = await new CodeReviewOrchestrator({
        maxRetries: 2,
        retryDelayMs: 1
      }).reviewPullRequest('o', 'r', 1);

      expect(attempts).toBe(2);
      expect(report.summary.totalFiles).toBe(2);
    });

    it('releases the rate limiter slot even when the review fails', async () => {
      mockedQuery.mockImplementation((() => {
        throw new Error('hard failure');
      }) as never);

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 1 });
      await expect(orchestrator.reviewPullRequest('o', 'r', 1)).rejects.toThrow();

      // A leaked slot would block every later review.
      expect(orchestrator.getRateLimiterStatus().activeRequests).toBe(0);
    });

    it('times out a hung review', async () => {
      mockedQuery.mockImplementation((async function* () {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        yield { type: 'result', subtype: 'success', structured_output: {} };
      }) as never);

      await expect(
        new CodeReviewOrchestrator({ maxRetries: 1, timeoutMs: 30 }).reviewPullRequest(
          'o',
          'r',
          1
        )
      ).rejects.toMatchObject({ code: ErrorCodes.AGENT_TIMEOUT });
    });
  });

  describe('Report generation', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'review-reports-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('writes all three formats with the submission naming convention', async () => {
      mockedQuery.mockImplementation(fakeStream(structuredReport()) as never);
      const report = await new CodeReviewOrchestrator().reviewPullRequest(
        'airaamane',
        'simple-todo-app',
        2
      );

      const written = await writeReports(report, 'airaamane', 'simple-todo-app', 2, dir);

      expect(written.map((f) => path.basename(f))).toEqual([
        'airaamane_simple-todo-app_2.json',
        'airaamane_simple-todo-app_2.md',
        'airaamane_simple-todo-app_2.html'
      ]);
    });

    it('produces valid JSON that round-trips through the schema', async () => {
      mockedQuery.mockImplementation(fakeStream(structuredReport()) as never);
      const report = await new CodeReviewOrchestrator().reviewPullRequest('o', 'r', 1);

      await writeReports(report, 'o', 'r', 1, dir);
      const raw = await readFile(path.join(dir, 'o_r_1.json'), 'utf-8');

      expect(ReviewReportSchema.safeParse(JSON.parse(raw)).success).toBe(true);
    });

    it('produces populated Markdown and HTML, not empty placeholders', async () => {
      mockedQuery.mockImplementation(fakeStream(structuredReport()) as never);
      const report = await new CodeReviewOrchestrator().reviewPullRequest('o', 'r', 1);

      await writeReports(report, 'o', 'r', 1, dir);
      const md = await readFile(path.join(dir, 'o_r_1.md'), 'utf-8');
      const html = await readFile(path.join(dir, 'o_r_1.html'), 'utf-8');

      expect(md).toContain('# 🔍 Code Review Report');
      expect(md).toContain(FILE_A);
      expect(md).not.toContain('undefined');

      expect(html.trimStart().startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('Overall Score');
      expect(html).not.toContain('undefined');
    });
  });

  describe('Integration', () => {
    // These tests require actual API keys and should be skipped in CI
    it.skip('should review a real small PR', async () => {
      // Run manually with valid credentials:
      //   npm run dev -- octocat Hello-World 1
    });
  });
});

/** Drain the SDK `prompt` input, which is an async generator of user messages. */
async function collect(prompt: unknown): Promise<unknown[]> {
  if (typeof prompt === 'string') return [prompt];
  const out: unknown[] = [];
  for await (const item of prompt as AsyncIterable<unknown>) {
    out.push(item);
  }
  return out;
}
