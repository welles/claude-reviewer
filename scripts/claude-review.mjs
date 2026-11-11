// Runs the Claude review with the Claude Agent SDK and writes the findings as JSON to the step
// output `review`.
//
// The review uses the Agent SDK on the Anthropic API rather than anthropics/claude-code-action:
// that action identifies itself as Claude Code, which API credit for the Agent SDK does not cover.
// Claude has only the reading tools, reads only the checkout and the PR files fetched by the
// workflow (a hook refuses every other path), loads no settings, hooks or MCP servers from the repo
// (the checkout is the PR's code) and returns the result in the schema of schema.json.
//
// Usage: node scripts/claude-review.mjs (in the checkout; the SDK is installed in this repository's
// directory with npm ci, see the workflow)
// Environment: ANTHROPIC_API_KEY, MODEL, PR_DIR, PR_NUMBER, REPOSITORY, INSTRUCTIONS_PATH,
// MAX_TURNS, MAX_BUDGET_USD, GITHUB_OUTPUT. Claude's messages are not logged (they may quote
// anything it read); only the cost, the number of turns and refused tool calls, and the API's
// reason when the run fails.

import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const { ANTHROPIC_API_KEY, MODEL, PR_DIR, PR_NUMBER, REPOSITORY, INSTRUCTIONS_PATH, GITHUB_OUTPUT } = process.env;
const MAX_TURNS = Number(process.env.MAX_TURNS || 60);
const MAX_BUDGET_USD = Number(process.env.MAX_BUDGET_USD || 5);

// Prompt and schema live next to this script, at the same commit as the workflow
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const values = { PR_NUMBER, REPOSITORY, PR_DIR, INSTRUCTIONS: INSTRUCTIONS_PATH };
const REVIEW_PROMPT = readFileSync(path.join(ROOT, 'prompt.md'), 'utf8').replace(
  /\{\{(\w+)\}\}/g,
  (match, key) => values[key] ?? match,
);
const REVIEW_SCHEMA = readFileSync(path.join(ROOT, 'schema.json'), 'utf8');

// The reading tools may read anywhere on the runner without approval (e.g. the runner's
// credentials or other files in RUNNER_TEMP), so a hook allows them only in the checkout and
// PR_DIR. Paths are resolved through symlinks, which a PR could add.
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const ROOTS = [real(process.cwd()), real(PR_DIR)];
const inside = (p) => {
  // The tools expand ~ to the home directory, path.resolve does not
  if (p.startsWith('~')) return false;
  const target = real(path.resolve(process.cwd(), p));
  return ROOTS.some((root) => target === root || target.startsWith(root + path.sep));
};
// A glob pattern must stay below the directory it is applied to
const relativePattern = (pattern) =>
  pattern === undefined ||
  (!path.isAbsolute(pattern) && !pattern.startsWith('~') && !pattern.split(/[\\/]/).includes('..'));
const readable = (tool, input) => {
  if (tool === 'Read') return typeof input.file_path === 'string' && inside(input.file_path);
  if (!inside(input.path ?? '.')) return false;
  if (tool === 'Glob') return relativePattern(input.pattern);
  if (tool === 'Grep') return relativePattern(input.glob);
  return false;
};

const run = query({
  prompt: REVIEW_PROMPT,
  options: {
    model: MODEL,
    // Upper limits, so that a run that keeps reading (a large PR, an instruction in the diff) does
    // not use up the credit; so far reviews took 6 to 19 turns and up to 1.66 $
    maxTurns: MAX_TURNS,
    maxBudgetUsd: MAX_BUDGET_USD,
    cwd: process.cwd(),
    additionalDirectories: [PR_DIR],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    // The only built-in tools Claude has; no shell, no network
    tools: ['Read', 'Grep', 'Glob'],
    // Reading only in the checkout and PR_DIR (see readable); the deny rules and refusing any
    // approval are a second line, e.g. for /proc/self/environ with the key
    hooks: {
      PreToolUse: [
        {
          matcher: 'Read|Grep|Glob',
          hooks: [
            async (input) =>
              readable(input.tool_name, input.tool_input)
                ? {}
                : {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: 'Nur das Repo und die PR-Dateien lesen.',
                    },
                  },
          ],
        },
      ],
    },
    canUseTool: async () => ({ behavior: 'deny', message: 'Nur das Repo und die PR-Dateien lesen.' }),
    disallowedTools: ['Read(//proc/**)', 'Read(//sys/**)', 'Read(//etc/**)', 'Read(//home/runner/.*/**)'],
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    outputFormat: { type: 'json_schema', schema: JSON.parse(REVIEW_SCHEMA) },
    // Replaces the environment of the Claude process, so it does not get the GitHub token
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY },
  },
});

let result;
try {
  for await (const message of run) {
    if (message.type === 'result') result = message;
  }
} catch (error) {
  // An error result (e.g. a refused API call: credit, rate limit) ends the iteration with an error
  // that names the API's reason
  console.error(`The review failed: ${error.message}`);
  process.exit(1);
}

if (!result) {
  console.error('The run ended without a result.');
  process.exit(1);
}
const cost = result.total_cost_usd?.toFixed(2) ?? '?';
console.log(`${MODEL}: ${result.num_turns} turns, ${cost} $, ${result.permission_denials?.length ?? 0} refused tool calls`);
if (result.subtype !== 'success' || result.is_error || result.structured_output === undefined) {
  // For a refused API call (credit, rate limit) this is the API's reason
  console.error(`The review failed (${result.subtype}): ${result.result ?? result.errors?.join('; ') ?? ''}`);
  process.exit(1);
}

const json = JSON.stringify(result.structured_output);
appendFileSync(GITHUB_OUTPUT, `review<<REVIEW_JSON_END\n${json}\nREVIEW_JSON_END\n`);
