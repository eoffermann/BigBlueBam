/*
 * catalog-stats.ts
 *
 * Single source of truth for the marketing site's headline platform counts.
 * Everything here is DERIVED at module load from the committed, auto-generated
 * MCP tool catalog (`docs-catalog.generated.json`), which is produced by
 * `node scripts/docs/build-docs-catalog.mjs` (aka `pnpm docs:catalog`) directly
 * from the mcp-server `registerTool(...)` source.
 *
 * Do NOT hardcode tool/product/app counts anywhere in `site/`. Import these
 * constants instead so the numbers can never drift from the real catalog.
 */
import docsCatalog from './docs-catalog.generated.json';

interface GeneratedCategory {
  name: string;
  tools: { name: string; description: string }[];
}

interface GeneratedProduct {
  id: string;
  name: string;
  description: string;
  toolCount: number;
  categories: GeneratedCategory[];
}

const catalog = docsCatalog as GeneratedProduct[];

/** Total number of registered MCP tools across every product (847 today). */
export const TOTAL_MCP_TOOLS: number = catalog.reduce(
  (sum, product) => sum + product.toolCount,
  0,
);

/** Total number of products in the /docs catalog, including the Platform layer (23 today). */
export const TOTAL_PRODUCTS: number = catalog.length;

/** Number of products that are actual apps (Platform is a product but NOT an app) (22 today). */
export const TOTAL_APPS: number = catalog.filter(
  (product) => product.id !== 'platform',
).length;
