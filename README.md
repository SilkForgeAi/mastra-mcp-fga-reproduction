# Mastra MCP FGA mapping reproduction

A hosted MCP tool is listed as authorized under a per-server FGA mapping, but execution fails when the core tool wrapper checks a different resource and permission.

Related: [mastra-ai/mastra#17508](https://github.com/mastra-ai/mastra/issues/17508), which introduced independent MCP mappings.

## Tested environment

- Mastra commit: `1be23784ae3c21c99a134371929bff47a6fc6ba0`
- Checkout package versions: `@mastra/core` 1.80.0, `@mastra/mcp` 2.6.0
- Node 24.22.1, pnpm 11.21.0, Vitest 4.1.12, macOS
- No LLM, API keys, external target, or deployed service is involved.

The checkout versions above are not a claim of reproduction against published npm releases.

## Expected and actual behavior

The server maps tool access to `team:team-1/read`. Its in-memory policy permits exactly that access for `operator`.

Expected: the listed tool executes and records an operation in its ledger.

Actual: listing succeeds, then execution fails with:

```text
FGA authorization denied: user operator cannot tools:execute on tool:record
```

The ledger remains empty. The same failure occurs through a real MCP HTTP client and the public `MCPServer.executeTool()` API.

## Reproduce in the pinned Mastra checkout

Run with the Node and pnpm versions above. Save this repository beside a separate Mastra checkout:

```sh
git clone https://github.com/SilkForgeAi/mastra-mcp-fga-reproduction.git
git clone https://github.com/mastra-ai/mastra.git mastra-checkout
cd mastra-checkout
git checkout 1be23784ae3c21c99a134371929bff47a6fc6ba0
pnpm --filter @mastra/mcp... install --frozen-lockfile
pnpm exec turbo build --filter='@mastra/core^...'
pnpm --filter @mastra/core build:lib
cp ../mastra-mcp-fga-reproduction/reproduction.test.ts packages/mcp/src/server/__tests__/server-fga-revocation.test.ts
cd packages/mcp
MASTRA_TELEMETRY_DISABLED=true pnpm exec vitest run --project unit:packages/mcp src/server/__tests__/server-fga-revocation.test.ts
```

Use a disposable checkout: the copy command creates/replaces the test path. The test uses Mastra's existing real HTTP test helper, `harness.mock.ts`; despite its name, it binds a real loopback socket and uses the actual MCP SDK client.

The test command deliberately exits with status 1: **two mapping tests fail and two revocation controls pass**. The mapping assertions use ordinary `it`, not `it.fails`.

If using a prebuilt checkout, only the copy and final test command are needed. The exact packaged test was rerun locally; its output is in `evidence/submission-reproduction.log`. The installation/build sequence reflects the local setup; the published clone URL becomes usable once this repository is pushed.

## Traced cause

1. `MCPServer.enforceToolExecutionFGA()` honors the configured resource and permission mapping.
2. Registration through `new Mastra(...)` reconverts hosted tools using the real Mastra instance.
3. `CoreToolBuilder.requireToolExecuteFGA()` runs a second check. This tool has no outbound MCP metadata or agent ID, so it resolves as a standalone tool.
4. The second check requests `tool:record/tools:execute`; the policy correctly denies that different request.

The existing MCP mapping test uses a substitute Mastra object; this reproduction uses the public real constructor.

## Evidence and controls

- Three original runs: both mapping cases failed in every run.
- Exact packaged reproduction rerun: two mapping failures, two passing revocation controls.
- Revocation after discovery/successful execution blocks later calls on both paths.
- Restoring access allows execution again.
- An unavailable policy provider blocks execution.
- Wider server suite: **23 files passed, 236 tests passed, 2 explicitly expected failures**. That wider run marked the known mapping failures with `it.fails`; it does not represent a production fix.

The logs preserve failure details while replacing the local workspace prefix with `<workspace>`.

## Scope

This demonstrates a configuration/availability failure that blocks authorized operations. It does not demonstrate unauthorized access, a data leak, or a production incident. No production fix is included.

A correction should preserve revocation and policy-error handling and keep independent checks on tools called inside hosted agents/workflows. Simply removing all inner authorization checks would be too broad.

Prepared with AI assistance. The commands and outcomes reported here were executed locally.
