// scripts/seed-beacons.js
// Seed ~5000 beacons with varied topics, dates, statuses, tags, and links.
// Resolves the target org via SEED_ORG_SLUG env var (set by the orchestrator)
// or --org-slug=<slug> CLI arg, falling back to the oldest org in the DB.
// Run: docker compose exec api node /app/scripts/seed-beacons.js
//   or: DATABASE_URL=postgresql://... SEED_ORG_SLUG=mage-inc node scripts/seed-beacons.js
// idempotent: skip-if-exists via guard on beacon_entries count for the org.

import postgres from 'postgres';
import crypto from 'crypto';

// ── Constants ────────────────────────────────────────────────────────────────
const TOTAL_BEACONS = 5000;
const BATCH_SIZE = 500;
const NOW = new Date();

// ── Helpers ──────────────────────────────────────────────────────────────────
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, min, max) {
  const n = min + Math.floor(Math.random() * (max - min + 1));
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}
function uuid() { return crypto.randomUUID(); }
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 240);
}
function daysAgo(d) { return new Date(NOW.getTime() - d * 86400000); }
function daysFromNow(d) { return new Date(NOW.getTime() + d * 86400000); }
function randomBetween(a, b) { return new Date(a.getTime() + Math.random() * (b.getTime() - a.getTime())); }

// ── Status & visibility distributions ────────────────────────────────────────
function pickStatus() {
  const r = Math.random();
  if (r < 0.70) return 'Active';
  if (r < 0.80) return 'PendingReview';
  if (r < 0.88) return 'Draft';
  if (r < 0.95) return 'Archived';
  return 'Retired';
}

function pickVisibility() {
  const r = Math.random();
  if (r < 0.60) return 'Project';
  if (r < 0.90) return 'Organization';
  return 'Private';
}

// ── Expiry distribution ──────────────────────────────────────────────────────
function pickExpiresAt(createdAt) {
  const r = Math.random();
  if (r < 0.05) return daysAgo(1 + Math.floor(Math.random() * 30));           // already expired
  if (r < 0.15) return daysFromNow(1 + Math.floor(Math.random() * 7));        // within 7 days
  if (r < 0.30) return daysFromNow(8 + Math.floor(Math.random() * 22));       // within 30 days
  if (r < 0.50) return daysFromNow(31 + Math.floor(Math.random() * 60));      // within 90 days
  if (r < 0.75) return daysFromNow(91 + Math.floor(Math.random() * 90));      // within 6 months
  return daysFromNow(181 + Math.floor(Math.random() * 550));                   // 6 months – 2 years
}

// ── Topic categories ─────────────────────────────────────────────────────────
const CATEGORIES = [
  {
    name: 'Engineering',
    tags: ['deployment', 'ci-cd', 'testing', 'code-review', 'architecture', 'debugging', 'performance', 'monitoring', 'alerting', 'incident-response'],
    titles: [
      'Setting Up Blue-Green Deployments with ArgoCD',
      'Code Review Best Practices for Large PRs',
      'Debugging Memory Leaks in Node.js Services',
      'Performance Profiling with Chrome DevTools',
      'Incident Response Runbook Template',
      'Implementing Feature Branch CI Pipelines',
      'Load Testing Strategy with k6',
      'Architecture Decision Record: Event Sourcing',
      'Setting Up Automated Canary Deployments',
      'Monitoring Service Mesh with Istio',
      'Writing Effective Unit Tests for Async Code',
      'Code Coverage Thresholds and When to Ignore Them',
      'Trunk-Based Development Workflow Guide',
      'Post-Incident Review Process',
      'Configuring GitHub Actions for Monorepos',
      'Service Dependency Mapping Conventions',
      'Error Budget Policy for SRE',
      'Hot-Reload Development Setup for Backend Services',
      'Database Connection Pool Tuning Guide',
      'Zero-Downtime Schema Migration Patterns',
      'Structured Logging Standards',
      'gRPC vs REST Decision Framework',
    ],
  },
  {
    name: 'Infrastructure',
    tags: ['aws', 'kubernetes', 'docker', 'networking', 'dns', 'ssl-tls', 'load-balancing', 'cdn', 'database', 'caching'],
    titles: [
      'AWS EKS Cluster Setup and Configuration Guide',
      'Docker Multi-Stage Build Optimization',
      'Kubernetes Pod Autoscaling with KEDA',
      'DNS Configuration for Multi-Region Deployments',
      'SSL Certificate Rotation with cert-manager',
      'Load Balancer Health Check Configuration',
      'CloudFront CDN Cache Invalidation Patterns',
      'PostgreSQL Connection Pooling with PgBouncer',
      'Redis Cluster Mode vs Sentinel Mode',
      'Terraform State Management Best Practices',
      'VPC Peering vs PrivateLink Decision Guide',
      'Container Resource Limits and Requests',
      'EBS Volume Backup Automation',
      'NAT Gateway Cost Optimization',
      'Kubernetes Namespace Organization Strategy',
      'AWS IAM Role Hierarchy for EKS',
      'Persistent Volume Claims for Stateful Workloads',
      'Cross-AZ Traffic Cost Reduction',
      'Service Mesh Implementation with Linkerd',
      'Container Registry Migration to ECR',
      'Network Policy Best Practices for K8s',
      'Spot Instance Strategy for Non-Critical Workloads',
    ],
  },
  {
    name: 'Security',
    tags: ['authentication', 'authorization', 'encryption', 'api-security', 'vulnerability', 'compliance', 'audit', 'secrets-management'],
    titles: [
      'OAuth 2.0 PKCE Implementation Guide',
      'API Key Rotation Strategy',
      'Secrets Management with HashiCorp Vault',
      'Row-Level Security Patterns in PostgreSQL',
      'OWASP Top 10 Mitigation Checklist',
      'JWT Token Lifecycle and Revocation',
      'Content Security Policy Configuration',
      'Dependency Vulnerability Scanning with Trivy',
      'SOC 2 Compliance Preparation Checklist',
      'Audit Log Design for Sensitive Operations',
      'mTLS Configuration Between Services',
      'Data Encryption at Rest Strategy',
      'CORS Policy Configuration Guide',
      'Rate Limiting to Prevent Abuse',
      'Session Fixation Prevention Techniques',
      'Secure Cookie Configuration Checklist',
      'SAML SSO Integration Guide',
      'Penetration Testing Scope and Methodology',
      'Security Incident Classification Matrix',
      'RBAC vs ABAC Authorization Models',
      'Cryptographic Key Management Policy',
      'Supply Chain Security for npm Packages',
    ],
  },
  {
    name: 'Product',
    tags: ['feature-specs', 'user-research', 'ab-testing', 'analytics', 'roadmap', 'release-planning', 'customer-feedback', 'product-strategy'],
    titles: [
      'Feature Specification Template',
      'User Research Interview Script Template',
      'A/B Test Design and Statistical Significance',
      'Product Analytics Event Taxonomy',
      'Quarterly Roadmap Planning Process',
      'Release Readiness Checklist',
      'Customer Feedback Triage Workflow',
      'Feature Flag Lifecycle Management',
      'Product Requirements Document Template',
      'User Persona Development Guide',
      'Competitive Analysis Framework',
      'Feature Prioritization Using RICE Score',
      'Product Launch Communication Plan',
      'Beta Testing Program Guidelines',
      'Usage Metrics Dashboard Specifications',
      'Deprecation Policy for Legacy Features',
      'Customer Journey Mapping Process',
      'MVP Definition Criteria',
      'Product Discovery Sprint Format',
      'Go-to-Market Checklist for New Features',
      'Pricing Tier Feature Matrix',
      'User Onboarding Funnel Analysis',
    ],
  },
  {
    name: 'Design',
    tags: ['ui-patterns', 'accessibility', 'design-system', 'responsive-design', 'animations', 'color-theory', 'typography', 'figma'],
    titles: [
      'Design System Component Library Standards',
      'WCAG 2.1 AA Compliance Checklist',
      'Responsive Breakpoint Strategy',
      'Motion Design Guidelines for UI Transitions',
      'Color System and Theme Token Architecture',
      'Typography Scale and Hierarchy Rules',
      'Form Input Validation Pattern Library',
      'Dark Mode Implementation Guide',
      'Icon Design Specifications',
      'Empty State Design Patterns',
      'Error State UI Guidelines',
      'Loading Skeleton Screen Patterns',
      'Modal and Dialog Best Practices',
      'Toast Notification Placement Rules',
      'Data Table UX Patterns',
      'Navigation Sidebar Design Patterns',
      'Keyboard Navigation Requirements',
      'Touch Target Size Guidelines',
      'Design Handoff Process with Figma',
      'Component Naming Convention Guide',
      'Visual Regression Testing Setup',
      'Micro-Interaction Specification Format',
    ],
  },
  {
    name: 'Process',
    tags: ['agile', 'sprint-planning', 'retrospectives', 'onboarding', 'code-of-conduct', 'meeting-guidelines', 'documentation', 'process'],
    titles: [
      'Sprint Planning Ceremony Guide',
      'Retrospective Facilitation Techniques',
      'New Engineer Onboarding Checklist',
      'Code of Conduct for Open Source Contributors',
      'Meeting Facilitation Guidelines',
      'Documentation Style Guide',
      'On-Call Rotation Schedule and Expectations',
      'Pull Request Review Turnaround SLA',
      'Definition of Done Checklist',
      'Team Working Agreement Template',
      'Knowledge Sharing Session Format',
      'Technical Debt Tracking Process',
      'Escalation Path for Production Issues',
      'Pair Programming Guidelines',
      'Cross-Team Collaboration Framework',
      'RFC Process for Architectural Changes',
      'Blameless Postmortem Template',
      'Capacity Planning for Sprint Commitments',
      'Remote Stand-Up Async Format',
      'Quarterly OKR Setting Process',
      'Tech Talk Presentation Guidelines',
      'Intern Mentorship Program Structure',
    ],
  },
  {
    name: 'API',
    tags: ['rest', 'graphql', 'api-design', 'versioning', 'rate-limiting', 'error-handling', 'pagination', 'webhooks'],
    titles: [
      'REST API Naming Conventions',
      'GraphQL Schema Design Principles',
      'API Versioning Strategy (URL vs Header)',
      'Rate Limiting Implementation with Token Bucket',
      'Standard Error Response Envelope Format',
      'Cursor-Based Pagination Implementation',
      'Webhook Delivery and Retry Logic',
      'OpenAPI 3.1 Documentation Standards',
      'API Authentication Schemes Comparison',
      'Batch Endpoint Design Patterns',
      'Idempotency Key Implementation Guide',
      'API Deprecation and Sunset Policy',
      'HATEOAS Link Design for REST APIs',
      'Request Validation Middleware Patterns',
      'API Gateway Configuration Guide',
      'Content Negotiation with Accept Headers',
      'Long-Running Operation Pattern (202 Accepted)',
      'API Client SDK Generation with OpenAPI',
      'GraphQL DataLoader Pattern for N+1 Prevention',
      'WebSocket Protocol Design for Real-Time APIs',
      'API Changelog Format and Versioning',
      'Field Filtering and Sparse Fieldsets',
    ],
  },
  {
    name: 'Data',
    tags: ['data-modeling', 'migrations', 'etl', 'analytics-pipeline', 'data-governance', 'gdpr', 'backups', 'replication'],
    titles: [
      'Database Schema Naming Conventions',
      'Idempotent Migration Writing Guide',
      'ETL Pipeline Architecture with Airflow',
      'Analytics Event Schema Standards',
      'Data Governance Policy Overview',
      'GDPR Data Deletion Implementation',
      'PostgreSQL Backup and Point-in-Time Recovery',
      'Logical Replication Setup Guide',
      'Data Warehouse Dimensional Modeling',
      'Slowly Changing Dimension Patterns',
      'Database Partitioning Strategy for Activity Logs',
      'Data Quality Monitoring Alerts',
      'PII Anonymization Techniques',
      'CDC with Debezium for Event Streaming',
      'Database Index Optimization Guide',
      'Query Performance Analysis with EXPLAIN',
      'Data Retention Policy by Table',
      'JSON Schema Validation for JSONB Columns',
      'Time-Series Data Storage Patterns',
      'Cross-Database Join Strategies',
      'Materialized View Refresh Strategy',
      'Data Catalog and Discovery Process',
    ],
  },
  {
    name: 'Frontend',
    tags: ['react', 'state-management', 'routing', 'frontend-testing', 'frontend-performance', 'bundle-optimization', 'css-architecture', 'typescript'],
    titles: [
      'React Component Composition Patterns',
      'Zustand Store Organization Guide',
      'React Router v7 Migration Checklist',
      'Component Testing with React Testing Library',
      'Bundle Size Analysis and Optimization',
      'TailwindCSS Utility Class Conventions',
      'TypeScript Strict Mode Configuration',
      'Code Splitting with React.lazy and Suspense',
      'Optimistic Update Patterns with TanStack Query',
      'Form State Management with React Hook Form',
      'Virtual Scrolling for Large Lists',
      'Image Optimization Pipeline',
      'Custom Hook Design Guidelines',
      'Error Boundary Strategy',
      'Storybook Component Documentation',
      'CSS-in-JS Performance Comparison',
      'Web Vitals Monitoring and Improvement',
      'Accessibility Testing with axe-core',
      'Progressive Web App Configuration',
      'Browser Compatibility Testing Matrix',
      'Internationalization Architecture with i18next',
      'Drag and Drop Implementation with dnd-kit',
    ],
  },
  {
    name: 'DevOps',
    tags: ['terraform', 'ansible', 'devops-monitoring', 'logging', 'devops-alerting', 'slos', 'chaos-engineering', 'feature-flags'],
    titles: [
      'Terraform Module Structure Guide',
      'Ansible Playbook for Server Provisioning',
      'Prometheus Alerting Rules Configuration',
      'Centralized Logging with ELK Stack',
      'SLO Definition and Error Budget Policy',
      'Chaos Engineering Experiment Catalog',
      'Feature Flag System Architecture',
      'GitOps Workflow with Flux CD',
      'Infrastructure as Code Review Checklist',
      'Grafana Dashboard Template Library',
      'PagerDuty Escalation Policy Setup',
      'CI/CD Pipeline Performance Optimization',
      'Secrets Injection with External Secrets Operator',
      'Blue-Green Deployment Rollback Procedure',
      'Observability Pillar Implementation Guide',
      'Cost Monitoring and Budget Alerts',
      'Disaster Recovery Runbook',
      'Environment Parity Checklist (Dev/Staging/Prod)',
      'Database Migration Rollback Strategies',
      'Log Retention and Rotation Policy',
      'Synthetic Monitoring with Datadog',
      'Deployment Frequency Tracking Dashboard',
    ],
  },
  {
    name: 'AI/ML',
    tags: ['embeddings', 'rag', 'fine-tuning', 'prompt-engineering', 'model-evaluation', 'agent-design', 'vector-databases', 'llm'],
    titles: [
      'RAG Pipeline Architecture Overview',
      'Prompt Engineering Best Practices',
      'Vector Database Selection Guide (Pinecone vs pgvector)',
      'LLM Fine-Tuning Workflow with LoRA',
      'Model Evaluation Metrics and Benchmarks',
      'AI Agent Design Patterns',
      'Embedding Generation and Caching Strategy',
      'Semantic Search Implementation Guide',
      'LLM Token Cost Optimization',
      'Structured Output Parsing from LLMs',
      'AI Feature Guardrails and Safety Filters',
      'Retrieval-Augmented Generation Chunking Strategy',
      'Prompt Versioning and A/B Testing',
      'Multi-Model Routing Architecture',
      'AI Content Moderation Pipeline',
      'Conversational Memory Management for Agents',
      'Batch Inference Pipeline Design',
      'Human-in-the-Loop Feedback Collection',
      'LLM Observability and Tracing',
      'AI-Powered Code Review Integration',
      'Knowledge Graph Construction from Documents',
      'Tool-Use Pattern for LLM Agents',
    ],
  },
  {
    name: 'Mobile',
    tags: ['ios', 'android', 'react-native', 'push-notifications', 'offline-first', 'app-store', 'mobile-testing', 'mobile-performance'],
    titles: [
      'React Native Project Structure Guide',
      'Push Notification Architecture Overview',
      'Offline-First Data Sync Strategy',
      'App Store Submission Checklist',
      'Mobile Performance Profiling Guide',
      'Deep Linking Configuration',
      'Mobile A/B Testing Framework',
      'Biometric Authentication Implementation',
      'Mobile Crash Reporting Setup',
      'Responsive Layout for Tablets',
      'CodePush OTA Update Strategy',
      'Native Module Bridge Development Guide',
      'Mobile CI/CD with Fastlane',
      'In-App Purchase Implementation Guide',
      'Mobile Accessibility Requirements',
      'Gesture Handler Pattern Library',
      'Background Task Scheduling on Mobile',
      'App Size Reduction Techniques',
      'Mobile Network Error Handling Patterns',
      'Cross-Platform Navigation Architecture',
      'Mobile Feature Flag Integration',
      'Device Testing Matrix and Priorities',
    ],
  },
  {
    name: 'Communication',
    tags: ['writing-guides', 'technical-writing', 'documentation-templates', 'presentation-skills', 'remote-work', 'async-communication', 'feedback'],
    titles: [
      'Technical Writing Style Guide',
      'README Template for Internal Services',
      'Architecture Decision Record Format',
      'Presentation Slide Deck Template',
      'Remote Work Communication Norms',
      'Async Communication Best Practices',
      'Giving and Receiving Code Review Feedback',
      'Status Update Email Template',
      'Technical Blog Post Writing Guide',
      'API Documentation Writing Standards',
      'Meeting Notes Template',
      'Stakeholder Communication Cadence',
      'Slack Channel Naming Conventions',
      'Incident Communication Template',
      'Demo Day Presentation Format',
      'RFC Writing Guide',
      'User-Facing Changelog Style Guide',
      'Engineering Newsletter Template',
      'Cross-Timezone Meeting Scheduling Policy',
      'Video Recording Guidelines for Knowledge Base',
      'Writing Effective Bug Reports',
      'Internal Wiki Organization Structure',
    ],
  },
  {
    name: 'Business',
    tags: ['pricing', 'billing', 'sla-management', 'vendor-evaluation', 'budget-planning', 'hiring', 'interview-processes', 'business-strategy'],
    titles: [
      'SaaS Pricing Model Comparison',
      'Stripe Billing Integration Guide',
      'SLA Definition and Monitoring Framework',
      'Vendor Evaluation Scorecard Template',
      'Engineering Budget Planning Process',
      'Technical Interview Question Bank',
      'Engineering Hiring Pipeline Overview',
      'Cost-per-Seat Calculation Guide',
      'Enterprise Customer Onboarding Playbook',
      'Revenue Impact Assessment for Feature Work',
      'Open Source Licensing Decision Matrix',
      'Build vs Buy Evaluation Framework',
      'Engineering Team Growth Model',
      'Technical Due Diligence Checklist',
      'Customer Success Metrics Dashboard',
      'Usage-Based Billing Implementation',
      'Contractor Engagement Guidelines',
      'Engineering Career Ladder Definitions',
      'Budget Approval Process for Cloud Spend',
      'Partnership Integration Technical Specs',
      'Annual Technology Audit Checklist',
      'Total Cost of Ownership Calculator Template',
    ],
  },
  {
    name: 'Misc',
    tags: ['general', 'tips', 'checklists', 'glossary', 'decision-records', 'postmortems', 'learning', 'tools'],
    titles: [
      'Engineering Glossary of Terms',
      'New Project Setup Checklist',
      'Tech Stack Decision Record Template',
      'Postmortem Analysis Template',
      'Learning Resources for New Engineers',
      'IDE Setup and Extensions Guide',
      'Git Workflow and Branch Naming Conventions',
      'Environment Variable Management Guide',
      'Useful Shell Aliases and Scripts',
      'Team Toolkit and Recommended Software',
      'Weekly Tech Digest Curation Process',
      'Conference Talk Submission Guide',
      'Side Project Policy',
      'Open Source Contribution Guidelines',
      'Emergency Contact and Escalation List',
      'Technical Book Club Reading List',
      'Hackathon Planning Checklist',
      'Developer Experience Survey Template',
      'Migration Playbook for Major Upgrades',
      'Service Ownership Registry',
      'Dependency Update Policy',
      'Platform Engineering Principles',
    ],
  },
];

// ── All unique tags pool ─────────────────────────────────────────────────────
const ALL_TAGS = [...new Set(CATEGORIES.flatMap(c => c.tags))];

// ── Body generation ──────────────────────────────────────────────────────────
function generateBody(title, category) {
  const paragraphPool = [
    `This beacon covers the essential guidelines and best practices for ${title.toLowerCase()}. Teams should reference this document when starting new work in this area.`,
    `## Background\n\nAs our systems have grown, we've found that having a consistent approach to ${category.name.toLowerCase()} topics reduces cognitive load and improves delivery velocity. This document captures our current thinking.`,
    `## Key Principles\n\n- **Consistency over perfection** — follow the existing patterns unless there's a strong reason to deviate\n- **Document decisions** — when you deviate, leave a note explaining why\n- **Iterate** — this is a living document, update it when practices evolve`,
    `## Implementation Notes\n\n\`\`\`bash\n# Example setup command\nnpm install --save-dev @tools/lint-config\nnpx setup-config --preset team-standard\n\`\`\`\n\nMake sure to run the setup in the root of the project directory.`,
    `## When to Use This\n\nThis applies to all new ${category.name.toLowerCase()} work. For existing systems, migrate incrementally during regular maintenance cycles. Don't block feature work to adopt these patterns retroactively.`,
    `## Common Pitfalls\n\n1. Over-engineering the initial solution — start simple\n2. Not measuring the impact of changes\n3. Skipping documentation updates when the approach changes\n4. Assuming everyone has the same context you do`,
    `## Related Resources\n\n- Check the internal wiki for team-specific adaptations\n- The design document has more detailed specifications\n- Ask in #engineering-questions if anything is unclear`,
    `## Checklist\n\n- [ ] Review the existing implementation\n- [ ] Identify gaps with current standards\n- [ ] Create a plan for incremental adoption\n- [ ] Update team documentation\n- [ ] Schedule a review in 30 days`,
    `## Configuration\n\n\`\`\`json\n{\n  "enabled": true,\n  "level": "warning",\n  "maxRetries": 3,\n  "timeout": 5000\n}\n\`\`\`\n\nAdjust these values based on your service's requirements. Production values should be more conservative than development.`,
    `## Monitoring\n\nSet up alerts for key metrics related to this area. Use the standard Grafana dashboard template and add service-specific panels as needed.\n\n\`\`\`\nALERT: high_error_rate\nFOR: 5m\nTHRESHOLD: > 1%\nACTION: page on-call\n\`\`\``,
    `## FAQ\n\n**Q: Do I need to follow this for prototypes?**\nA: No, prototypes are exempt. But convert to standard patterns before shipping to production.\n\n**Q: Who owns this document?**\nA: The ${category.name.toLowerCase()} working group. Reach out in the team channel for questions.`,
    `## Decision Log\n\n| Date | Decision | Rationale |\n|------|----------|----------|\n| 2025-10 | Adopted current approach | Simpler than alternatives, good community support |\n| 2025-12 | Added caching layer | Performance requirements increased with user growth |`,
  ];

  const numParagraphs = 3 + Math.floor(Math.random() * 6); // 3–8
  const selected = pickN(paragraphPool, numParagraphs, numParagraphs);
  return `# ${title}\n\n${selected.join('\n\n')}`;
}

function generateSummary(title, category) {
  const templates = [
    `Guidelines for ${title.toLowerCase()} within the ${category.name.toLowerCase()} domain.`,
    `Best practices and conventions for ${title.toLowerCase()}.`,
    `Reference document covering ${title.toLowerCase()} for the team.`,
    `Standards and procedures for ${title.toLowerCase()}. Updated regularly.`,
    `Quick-reference guide for ${title.toLowerCase()} practices.`,
    `Team consensus on how to approach ${title.toLowerCase()}.`,
  ];
  return pick(templates);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const dbUrl = process.env.DATABASE_URL || 'postgresql://bigbluebam:change-me-in-production@postgres:5432/bigbluebam';
  const sql = postgres(dbUrl, { max: 5 });
  console.log('Connecting to database...');

  // Verify connection
  const [{ now }] = await sql`SELECT now()`;
  console.log(`Connected. Server time: ${now}`);

  // ── Resolve target org dynamically ─────────────────────────────────────
  const orgSlug = process.env.SEED_ORG_SLUG
    ?? process.argv.find((a) => a.startsWith('--org-slug='))?.split('=')[1];
  const [org] = orgSlug
    ? await sql`SELECT id, name FROM organizations WHERE slug = ${orgSlug} LIMIT 1`
    : await sql`SELECT id, name FROM organizations ORDER BY created_at LIMIT 1`;
  if (!org) {
    console.error('No org found, run create-admin first');
    await sql.end();
    process.exit(1);
  }
  const ORG_ID = org.id;
  console.log(`Using org: ${org.name} (${org.id})`);

  const users = await sql`SELECT id, email, display_name FROM users WHERE org_id = ${org.id} ORDER BY created_at`;
  if (users.length === 0) {
    console.error('No users in org, run create-admin first');
    await sql.end();
    process.exit(1);
  }
  const USER_IDS = users.map((u) => u.id);
  console.log(`User pool: ${USER_IDS.length} users`);

  // Pick an available project. Beacons optionally scope to a project; falling back to NULL is fine.
  const projects = await sql`SELECT id, name FROM projects WHERE org_id = ${org.id} ORDER BY created_at LIMIT 1`;
  const PROJECT_ID = projects.length > 0 ? projects[0].id : null;
  if (PROJECT_ID) {
    console.log(`Using project: ${projects[0].name} (${PROJECT_ID}) for ~80% of beacons`);
  } else {
    console.log('No project found; all beacons will be org-scoped (project_id=NULL).');
  }

  // Idempotency guard: skip if the org already has beacons seeded.
  const [{ count: existingCount }] = await sql`SELECT COUNT(*)::int AS count FROM beacon_entries WHERE organization_id = ${ORG_ID}`;
  if (existingCount > 0) {
    console.log(`Beacon seed: ${existingCount} beacon_entries already exist for this org, skipping.`);
    await sql.end();
    return;
  }

  // ── Generate beacons ───────────────────────────────────────────────────
  console.log(`Generating ${TOTAL_BEACONS} beacons...`);
  const beacons = [];
  const beaconTags = [];
  // beacon_entries.slug is GLOBALLY unique (UNIQUE(slug), not per-org), so the
  // dedupe set must start from every slug already in the DB — not just the ones
  // we generate this run. Otherwise seeding a second org collides with the first
  // org's slugs (e.g. "useful-shell-aliases-and-scripts-part-2") and the bulk
  // INSERT dies on beacon_entries_slug_key. Pre-loading lets the existing
  // suffix-on-collision loop below resolve cross-org clashes too.
  const existingSlugRows = await sql`SELECT slug FROM beacon_entries`;
  const usedSlugs = new Set(existingSlugRows.map((r) => r.slug));

  for (let i = 0; i < TOTAL_BEACONS; i++) {
    const cat = CATEGORIES[i % CATEGORIES.length]; // round-robin for even distribution
    const titleBase = pick(cat.titles);
    // Add a numeric suffix to ensure unique slugs
    const suffix = Math.floor(i / CATEGORIES.length);
    const title = suffix === 0 ? titleBase : `${titleBase} (Part ${suffix + 1})`;
    let slug = slugify(title);
    // Ensure slug uniqueness
    while (usedSlugs.has(slug)) { slug = slug.slice(0, 230) + '-' + crypto.randomBytes(3).toString('hex'); }
    usedSlugs.add(slug);

    const id = uuid();
    const status = pickStatus();
    const visibility = pickVisibility();
    const createdBy = pick(USER_IDS);
    const ownedBy = pick(USER_IDS);
    const createdAt = randomBetween(daysAgo(180), daysAgo(1));
    const updatedAt = randomBetween(createdAt, NOW);
    const expiresAt = pickExpiresAt(createdAt);
    const version = 1 + Math.floor(Math.random() * 5);
    const projectId = Math.random() < 0.80 ? PROJECT_ID : null;

    let lastVerifiedAt = null;
    let lastVerifiedBy = null;
    let verificationCount = 0;
    if (status === 'Active') {
      lastVerifiedAt = randomBetween(createdAt, NOW);
      lastVerifiedBy = pick(USER_IDS);
      // older beacons get more verifications
      const ageDays = (NOW - createdAt) / 86400000;
      verificationCount = Math.min(15, Math.floor(Math.random() * (ageDays / 12)));
    }

    let retiredAt = null;
    if (status === 'Retired') {
      retiredAt = randomBetween(createdAt, NOW);
    }

    beacons.push({
      id, slug, title,
      summary: generateSummary(title, cat),
      body_markdown: generateBody(title, cat),
      body_html: null,
      version, status, visibility,
      created_by: createdBy,
      owned_by: ownedBy,
      project_id: projectId,
      organization_id: ORG_ID,
      expires_at: expiresAt,
      last_verified_at: lastVerifiedAt,
      last_verified_by: lastVerifiedBy,
      verification_count: verificationCount,
      created_at: createdAt,
      updated_at: updatedAt,
      retired_at: retiredAt,
      vector_id: null,
      metadata: {},
    });

    // Tags: 2-5 from category + maybe 1-2 from global pool
    const catTags = pickN(cat.tags, 2, Math.min(5, cat.tags.length));
    const extraTags = pickN(ALL_TAGS.filter(t => !catTags.includes(t)), 0, 2);
    const allBeaconTags = [...new Set([...catTags, ...extraTags])];
    for (const tag of allBeaconTags) {
      beaconTags.push({ id: uuid(), beacon_id: id, tag, created_by: createdBy, created_at: createdAt });
    }
  }

  console.log(`Generated ${beacons.length} beacons, ${beaconTags.length} tags`);

  // ── Bulk insert beacons ────────────────────────────────────────────────
  console.log('Inserting beacons...');
  const t0 = Date.now();
  for (let i = 0; i < beacons.length; i += BATCH_SIZE) {
    const batch = beacons.slice(i, i + BATCH_SIZE);
    await sql`
      INSERT INTO beacon_entries ${sql(batch, 'id', 'slug', 'title', 'summary', 'body_markdown', 'body_html', 'version', 'status', 'visibility', 'created_by', 'owned_by', 'project_id', 'organization_id', 'expires_at', 'last_verified_at', 'last_verified_by', 'verification_count', 'created_at', 'updated_at', 'retired_at', 'vector_id', 'metadata')}
    `;
    process.stdout.write(`  beacons: ${Math.min(i + BATCH_SIZE, beacons.length)}/${beacons.length}\r`);
  }
  console.log(`\nBeacons inserted in ${Date.now() - t0}ms`);

  // ── Bulk insert tags ───────────────────────────────────────────────────
  console.log('Inserting tags...');
  const t1 = Date.now();
  for (let i = 0; i < beaconTags.length; i += BATCH_SIZE) {
    const batch = beaconTags.slice(i, i + BATCH_SIZE);
    await sql`
      INSERT INTO beacon_tags ${sql(batch, 'id', 'beacon_id', 'tag', 'created_by', 'created_at')}
    `;
    process.stdout.write(`  tags: ${Math.min(i + BATCH_SIZE, beaconTags.length)}/${beaconTags.length}\r`);
  }
  console.log(`\nTags inserted in ${Date.now() - t1}ms`);

  // ── Generate and insert links ──────────────────────────────────────────
  console.log('Generating links...');
  // Build a tag-to-beacon index for linking similar beacons
  const tagToBeacons = {};
  for (const bt of beaconTags) {
    if (!tagToBeacons[bt.tag]) tagToBeacons[bt.tag] = [];
    tagToBeacons[bt.tag].push(bt.beacon_id);
  }

  const linkSet = new Set();
  const links = [];
  const linkTypes = ['RelatedTo', 'RelatedTo', 'RelatedTo', 'RelatedTo', // 40%
                     'DependsOn', 'DependsOn',                           // 20%
                     'SeeAlso', 'SeeAlso',                               // ~15%
                     'Supersedes', 'Supersedes',                          // ~15%
                     'ConflictsWith'];                                    // ~10%
  const TARGET_LINKS = 2000;

  let attempts = 0;
  while (links.length < TARGET_LINKS && attempts < TARGET_LINKS * 10) {
    attempts++;
    // Pick a random tag, then pick two beacons that share it
    const tag = pick(ALL_TAGS);
    const pool = tagToBeacons[tag];
    if (!pool || pool.length < 2) continue;
    const a = pick(pool);
    const b = pick(pool);
    if (a === b) continue;
    const linkType = pick(linkTypes);
    const key = `${a}:${b}:${linkType}`;
    if (linkSet.has(key)) continue;
    linkSet.add(key);
    links.push({
      id: uuid(),
      source_id: a,
      target_id: b,
      link_type: linkType,
      created_by: pick(USER_IDS),
      created_at: randomBetween(daysAgo(150), NOW),
    });
  }

  console.log(`Generated ${links.length} links`);
  const t2 = Date.now();
  for (let i = 0; i < links.length; i += BATCH_SIZE) {
    const batch = links.slice(i, i + BATCH_SIZE);
    await sql`
      INSERT INTO beacon_links ${sql(batch, 'id', 'source_id', 'target_id', 'link_type', 'created_by', 'created_at')}
    `;
    process.stdout.write(`  links: ${Math.min(i + BATCH_SIZE, links.length)}/${links.length}\r`);
  }
  console.log(`\nLinks inserted in ${Date.now() - t2}ms`);

  // ── Verify ─────────────────────────────────────────────────────────────
  const [beaconCount] = await sql`SELECT COUNT(*)::int AS count FROM beacon_entries`;
  const [tagCount] = await sql`SELECT COUNT(*)::int AS count FROM beacon_tags`;
  const [linkCount] = await sql`SELECT COUNT(*)::int AS count FROM beacon_links`;
  console.log(`\nFinal counts:`);
  console.log(`  beacon_entries: ${beaconCount.count}`);
  console.log(`  beacon_tags:    ${tagCount.count}`);
  console.log(`  beacon_links:   ${linkCount.count}`);
  console.log(`\nTotal time: ${Date.now() - t0}ms`);

  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
