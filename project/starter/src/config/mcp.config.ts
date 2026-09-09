/**
 * Model Context Protocol (MCP) server configurations
 *
 * Required MCP Servers:
 * 1. GitHub - For PR/repo operations
 * 2. ESLint - For code linting and style analysis
 *
 * Documentation:
 * - MCP Protocol: https://modelcontextprotocol.io
 * - GitHub MCP: https://github.com/github/github-mcp-server
 * - ESLint MCP: https://eslint.org/docs/latest/use/mcp
 *
 * SECURITY: no credential is ever written here. The GitHub token is read from
 * the environment (`GITHUB_TOKEN`) and mapped onto the variable name the
 * GitHub MCP server expects (`GITHUB_PERSONAL_ACCESS_TOKEN`).
 */

import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Shape of a stdio MCP server entry.
 *
 * `type` is a string literal (not `string`) so the object stays assignable to
 * the SDK's `mcpServers` option.
 */
export interface StdioMcpServerConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export const mcpServersConfig: Record<string, StdioMcpServerConfig> = {
  /**
   * GitHub MCP Server
   * Provides tools for GitHub API operations (PRs, files, code search).
   *
   * `npx -y` runs the published package without a global install.
   * GITHUB_TOKEN is optional - without it the server falls back to
   * unauthenticated access (public repos only, low rate limits).
   */
  github: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? ''
    }
  },

  /**
   * ESLint MCP Server
   * Lints files in the local working tree. Requires no authentication.
   */
  eslint: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@eslint/mcp@latest'],
    env: {}
  }
};

/**
 * GitHub MCP tool names.
 * MCP tools are namespaced as `mcp__<serverName>__<toolName>`.
 */
export const githubTools = [
  'mcp__github__get_pull_request',       // PR metadata (title, body, state)
  'mcp__github__get_pull_request_files', // changed files + patches
  'mcp__github__get_file_contents',      // full contents of a file at a ref
  'mcp__github__search_code'             // find related files (e.g. tests)
] as const;

/**
 * ESLint MCP tool names.
 */
export const eslintTools = [
  'mcp__eslint__lint-files' // lint local files with the project ESLint config
] as const;

/**
 * True when a GitHub token is present. Used to warn about rate limits
 * rather than to gate execution - public PRs work without a token.
 */
export const hasGitHubToken = Boolean(process.env.GITHUB_TOKEN);
