import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';

import {
  CodeQualityResultSchema,
  TestCoverageResultSchema,
  RefactoringSuggestionSchema,
  CodeQualityResultJSONSchema,
  TestCoverageResultJSONSchema,
  RefactoringSuggestionJSONSchema
} from '../src/types/analysis-results.js';
import {
  ReviewReportSchema,
  ReviewReportJSONSchema
} from '../src/types/report-types.js';

const FILE = 'src/todo.ts';

const validCodeQuality = {
  file: FILE,
  issues: [
    {
      line: 42,
      severity: 'critical',
      category: 'security',
      description: 'User input is interpolated into a SQL string.',
      suggestion: 'Use a parameterized query.'
    }
  ],
  overallScore: 75,
  summary: 'One critical injection issue.'
};

const validTestCoverage = {
  file: FILE,
  hasTests: true,
  testFiles: ['tests/todo.test.ts'],
  untestedPaths: [
    {
      type: 'function',
      location: 'deleteTodo:88',
      priority: 'high',
      reasoning: 'Deletion has no test, so a regression loses user data.',
      suggestedTest: 'deleteTodo("missing") should reject with NotFoundError.'
    }
  ],
  coverageEstimate: 60,
  summary: 'Main paths covered, deletion is not.'
};

const validRefactoring = {
  file: FILE,
  suggestions: [
    {
      type: 'modernize',
      location: 'loadTodos',
      impact: 'medium',
      description: 'Replace the promise chain with async/await.',
      before: 'fetch(url).then(r => r.json())',
      after: 'const r = await fetch(url); return r.json();',
      benefits: 'Errors surface through try/catch instead of a dangling catch.'
    }
  ],
  summary: 'One modernization opportunity.'
};

const validReport = {
  pullRequest: { owner: 'airaamane', repo: 'simple-todo-app', number: 2 },
  fileReviews: [
    {
      file: FILE,
      codeQuality: validCodeQuality,
      testCoverage: validTestCoverage,
      refactorings: validRefactoring
    }
  ],
  summary: {
    totalFiles: 1,
    overallScore: 75,
    criticalIssues: 1,
    highPriorityTests: 1,
    refactoringOpportunities: 1
  },
  recommendations: [
    {
      priority: 'critical',
      category: 'Security',
      description: 'Parameterize the query in todo.ts.',
      files: [FILE]
    }
  ],
  metadata: {
    analyzedAt: '2026-09-09T12:00:00.000Z',
    duration: 42_000,
    agentVersions: { 'code-quality-analyzer': '1.0.0' }
  }
};

describe('CodeQualityResultSchema', () => {
  it('accepts a valid result', () => {
    expect(() => CodeQualityResultSchema.parse(validCodeQuality)).not.toThrow();
  });

  it('accepts an empty issues array (a clean file)', () => {
    const clean = { ...validCodeQuality, issues: [], overallScore: 100 };
    expect(CodeQualityResultSchema.parse(clean).issues).toEqual([]);
  });

  it.each([0, 100])('accepts the boundary score %i', (overallScore) => {
    expect(() =>
      CodeQualityResultSchema.parse({ ...validCodeQuality, overallScore })
    ).not.toThrow();
  });

  it.each([-1, 101])('rejects the out-of-range score %i', (overallScore) => {
    expect(() =>
      CodeQualityResultSchema.parse({ ...validCodeQuality, overallScore })
    ).toThrow(ZodError);
  });

  it('rejects an unknown severity', () => {
    const bad = {
      ...validCodeQuality,
      issues: [{ ...validCodeQuality.issues[0], severity: 'catastrophic' }]
    };
    expect(() => CodeQualityResultSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects an unknown category', () => {
    const bad = {
      ...validCodeQuality,
      issues: [{ ...validCodeQuality.issues[0], category: 'vibes' }]
    };
    expect(() => CodeQualityResultSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects a non-numeric line', () => {
    const bad = {
      ...validCodeQuality,
      issues: [{ ...validCodeQuality.issues[0], line: '42' }]
    };
    expect(() => CodeQualityResultSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects a missing required field', () => {
    const { summary, ...noSummary } = validCodeQuality;
    expect(() => CodeQualityResultSchema.parse(noSummary)).toThrow(ZodError);
  });

  it('reports the failing path in the error', () => {
    const result = CodeQualityResultSchema.safeParse({
      ...validCodeQuality,
      overallScore: 500
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0]?.path).toEqual(['overallScore']);
    }
  });
});

describe('TestCoverageResultSchema', () => {
  it('accepts a valid result', () => {
    expect(() => TestCoverageResultSchema.parse(validTestCoverage)).not.toThrow();
  });

  it('accepts a file with no tests at all', () => {
    const untested = {
      ...validTestCoverage,
      hasTests: false,
      testFiles: [],
      untestedPaths: [],
      coverageEstimate: 0
    };
    const parsed = TestCoverageResultSchema.parse(untested);
    expect(parsed.hasTests).toBe(false);
    expect(parsed.coverageEstimate).toBe(0);
  });

  it('rejects a non-boolean hasTests', () => {
    expect(() =>
      TestCoverageResultSchema.parse({ ...validTestCoverage, hasTests: 'yes' })
    ).toThrow(ZodError);
  });

  it('rejects an unknown untested-path type', () => {
    const bad = {
      ...validTestCoverage,
      untestedPaths: [{ ...validTestCoverage.untestedPaths[0], type: 'module' }]
    };
    expect(() => TestCoverageResultSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects "info" as a priority (that is a severity, not a priority)', () => {
    const bad = {
      ...validTestCoverage,
      untestedPaths: [{ ...validTestCoverage.untestedPaths[0], priority: 'info' }]
    };
    expect(() => TestCoverageResultSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects a coverage estimate above 100', () => {
    expect(() =>
      TestCoverageResultSchema.parse({ ...validTestCoverage, coverageEstimate: 120 })
    ).toThrow(ZodError);
  });
});

describe('RefactoringSuggestionSchema', () => {
  it('accepts a valid result', () => {
    expect(() => RefactoringSuggestionSchema.parse(validRefactoring)).not.toThrow();
  });

  it('accepts an empty suggestions array (an already clean file)', () => {
    const clean = { ...validRefactoring, suggestions: [] };
    expect(RefactoringSuggestionSchema.parse(clean).suggestions).toEqual([]);
  });

  it('rejects an unknown refactoring type', () => {
    const bad = {
      ...validRefactoring,
      suggestions: [{ ...validRefactoring.suggestions[0], type: 'rewrite-everything' }]
    };
    expect(() => RefactoringSuggestionSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects an unknown impact level', () => {
    const bad = {
      ...validRefactoring,
      suggestions: [{ ...validRefactoring.suggestions[0], impact: 'critical' }]
    };
    expect(() => RefactoringSuggestionSchema.parse(bad)).toThrow(ZodError);
  });

  it('requires both before and after snippets', () => {
    const { after, ...noAfter } = validRefactoring.suggestions[0]!;
    expect(() =>
      RefactoringSuggestionSchema.parse({ ...validRefactoring, suggestions: [noAfter] })
    ).toThrow(ZodError);
  });
});

describe('ReviewReportSchema', () => {
  it('accepts a complete report', () => {
    expect(() => ReviewReportSchema.parse(validReport)).not.toThrow();
  });

  it('accepts a PR with no reviewable files', () => {
    const empty = {
      ...validReport,
      fileReviews: [],
      summary: {
        totalFiles: 0,
        overallScore: 0,
        criticalIssues: 0,
        highPriorityTests: 0,
        refactoringOpportunities: 0
      },
      recommendations: []
    };
    expect(ReviewReportSchema.parse(empty).fileReviews).toEqual([]);
  });

  it('rejects a report missing the pullRequest block', () => {
    const { pullRequest, ...noPr } = validReport;
    expect(() => ReviewReportSchema.parse(noPr)).toThrow(ZodError);
  });

  it('rejects a string PR number', () => {
    const bad = { ...validReport, pullRequest: { ...validReport.pullRequest, number: '2' } };
    expect(() => ReviewReportSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects a file review missing a subagent section', () => {
    const bad = {
      ...validReport,
      fileReviews: [{ file: FILE, codeQuality: validCodeQuality, testCoverage: validTestCoverage }]
    };
    expect(() => ReviewReportSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects an unknown recommendation priority', () => {
    const bad = {
      ...validReport,
      recommendations: [{ ...validReport.recommendations[0], priority: 'urgent' }]
    };
    expect(() => ReviewReportSchema.parse(bad)).toThrow(ZodError);
  });

  it('requires agentVersions values to be strings', () => {
    const bad = {
      ...validReport,
      metadata: { ...validReport.metadata, agentVersions: { 'code-quality-analyzer': 1 } }
    };
    expect(() => ReviewReportSchema.parse(bad)).toThrow(ZodError);
  });

  it('safeParse returns errors instead of throwing', () => {
    const result = ReviewReportSchema.safeParse({ pullRequest: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.length).toBeGreaterThan(0);
    }
  });
});

describe('JSON Schema export (for SDK structured outputs)', () => {
  const schemas: Array<[string, Record<string, unknown>]> = [
    ['CodeQualityResult', CodeQualityResultJSONSchema],
    ['TestCoverageResult', TestCoverageResultJSONSchema],
    ['RefactoringSuggestion', RefactoringSuggestionJSONSchema],
    ['ReviewReport', ReviewReportJSONSchema]
  ];

  it.each(schemas)('%s is a JSON Schema object with properties', (_name, schema) => {
    expect(schema['type']).toBe('object');
    expect(schema['properties']).toBeTypeOf('object');
  });

  it.each(schemas)('%s is JSON-serializable', (_name, schema) => {
    expect(() => JSON.parse(JSON.stringify(schema))).not.toThrow();
  });

  it('marks ReviewReport top-level fields as required', () => {
    expect(ReviewReportJSONSchema['required']).toEqual(
      expect.arrayContaining([
        'pullRequest',
        'fileReviews',
        'summary',
        'recommendations',
        'metadata'
      ])
    );
  });

  it('marks CodeQualityResult fields as required', () => {
    expect(CodeQualityResultJSONSchema['required']).toEqual(
      expect.arrayContaining(['file', 'issues', 'overallScore', 'summary'])
    );
  });

  it('inlines definitions with $refStrategy root (no unresolved local $ref)', () => {
    // A dangling "#/definitions/..." reference makes the SDK reject the schema.
    const serialized = JSON.stringify(ReviewReportJSONSchema);
    expect(serialized).not.toContain('"$ref":"#/definitions/');
  });

  it('preserves the severity enum in the JSON schema', () => {
    const serialized = JSON.stringify(CodeQualityResultJSONSchema);
    for (const severity of ['critical', 'high', 'medium', 'low', 'info']) {
      expect(serialized).toContain(severity);
    }
  });
});
