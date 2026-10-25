// Product facts shown on the site. Each one is checked against the code in CI
// (scripts/check-tool-return-coverage.mjs), so a stale number fails the build
// instead of shipping.

/** MCP tools registered by apps/mcp-server (one registerTool() call each). */
export const MCP_TOOL_COUNT = 802;
