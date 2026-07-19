import { ArrowLeft, Cloud, Server, Terminal, CheckCircle2, AlertTriangle, Info, ChevronDown, ChevronRight, Rocket } from 'lucide-react';
import { useState } from 'react';

/* ------------------------------------------------------------------ */
/*  Reusable components                                                */
/* ------------------------------------------------------------------ */

function CodeBlock({ children, title }: { children: string; title?: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
      {title && (
        <div className="border-b border-zinc-800 px-4 py-2 text-xs font-medium text-zinc-400">
          {title}
        </div>
      )}
      <pre className="p-4 text-sm leading-relaxed text-zinc-100">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function Callout({ type, children }: { type: 'tip' | 'warning' | 'info'; children: React.ReactNode }) {
  const styles = {
    tip: {
      bg: 'bg-emerald-50 border-emerald-200',
      icon: <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />,
      label: 'Tip',
      labelColor: 'text-emerald-700',
    },
    warning: {
      bg: 'bg-amber-50 border-amber-200',
      icon: <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />,
      label: 'Warning',
      labelColor: 'text-amber-700',
    },
    info: {
      bg: 'bg-blue-50 border-blue-200',
      icon: <Info className="h-5 w-5 shrink-0 text-blue-600" />,
      label: 'Note',
      labelColor: 'text-blue-700',
    },
  };
  const s = styles[type];
  return (
    <div className={`rounded-lg border ${s.bg} p-4`}>
      <div className="flex items-start gap-3">
        {s.icon}
        <div>
          <p className={`text-sm font-semibold ${s.labelColor}`}>{s.label}</p>
          <div className="mt-1 text-sm text-zinc-700 leading-relaxed">{children}</div>
        </div>
      </div>
    </div>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-600 text-lg font-bold text-white shadow-md shadow-primary-200">
      {n}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-5">
      <div className="flex flex-col items-center">
        <StepNumber n={n} />
        <div className="mt-2 w-px flex-1 bg-zinc-200" />
      </div>
      <div className="flex-1 pb-12">
        <h3 className="text-xl font-bold text-zinc-900 mt-1.5">{title}</h3>
        <div className="mt-4 space-y-4">{children}</div>
      </div>
    </div>
  );
}

function FaqItem({ q, children }: { q: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-zinc-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-6 py-4 text-left"
      >
        <span className="text-sm font-semibold text-zinc-900">{q}</span>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
        )}
      </button>
      {open && (
        <div className="border-t border-zinc-100 px-6 py-4 text-sm text-zinc-600 leading-relaxed">
          {children}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Service table data                                                 */
/* ------------------------------------------------------------------ */

const services = [
  { name: 'nginx', role: 'Reverse proxy & static file server', type: 'Infrastructure' },
  { name: 'api', role: 'Bam REST API + WebSocket server', type: 'API' },
  { name: 'banter-api', role: 'Banter messaging REST API + WebSocket', type: 'API' },
  { name: 'beacon-api', role: 'Beacon knowledge base API', type: 'API' },
  { name: 'brief-api', role: 'Brief collaborative docs REST API + WebSocket', type: 'API' },
  { name: 'bolt-api', role: 'Bolt workflow automation API', type: 'API' },
  { name: 'bearing-api', role: 'Bearing goals & OKRs API', type: 'API' },
  { name: 'board-api', role: 'Board visual collaboration REST API + WebSocket', type: 'API' },
  { name: 'bond-api', role: 'Bond CRM API', type: 'API' },
  { name: 'blast-api', role: 'Blast email campaigns API', type: 'API' },
  { name: 'bench-api', role: 'Bench analytics dashboards API', type: 'API' },
  { name: 'book-api', role: 'Book scheduling API', type: 'API' },
  { name: 'blank-api', role: 'Blank forms API', type: 'API' },
  { name: 'bill-api', role: 'Bill invoicing & expenses API', type: 'API' },
  { name: 'helpdesk-api', role: 'Helpdesk portal API', type: 'API' },
  { name: 'worker', role: 'Background job processor (email, notifications, exports, webhook delivery)', type: 'API' },
  { name: 'mcp-server', role: 'AI tool server (849 MCP tools)', type: 'API' },
  { name: 'voice-agent', role: 'AI voice agent (LiveKit)', type: 'API' },
  { name: 'frontend', role: 'All SPAs (Bam, Banter, Beacon, Bearing, Bench, Bill, Blank, Blast, Board, Bolt, Bond, Book, Brief, Helpdesk)', type: 'Frontend' },
  { name: 'migrate', role: 'Database migration runner (runs on startup, then exits)', type: 'Utility' },
  { name: 'postgres', role: 'PostgreSQL 16 database', type: 'Data' },
  { name: 'redis', role: 'Redis 7 (sessions, cache, pub/sub, job queues, confirm-action tokens)', type: 'Data' },
  { name: 'minio', role: 'S3-compatible file storage', type: 'Data' },
  { name: 'qdrant', role: 'Vector database for semantic search', type: 'Data' },
  { name: 'livekit', role: 'WebRTC SFU for voice/video', type: 'Data' },
  { name: 'site', role: 'Marketing site (this site!)', type: 'Frontend' },
];

/* ------------------------------------------------------------------ */
/*  Page component                                                     */
/* ------------------------------------------------------------------ */

export function DeployGuidePage() {
  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Top navbar */}
      <header className="fixed top-0 right-0 left-0 z-50 border-b border-zinc-200 bg-white/80 shadow-sm backdrop-blur-lg">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <a href="/" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600 text-sm font-bold text-white">
              B
            </div>
            <span className="text-lg font-bold text-zinc-900">BigBlueBam</span>
          </a>
          <div className="flex items-center gap-4">
            <a
              href="/docs"
              className="text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-900"
            >
              Docs
            </a>
            <a
              href="/"
              className="flex items-center gap-1.5 text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-900"
            >
              <ArrowLeft className="h-4 w-4" />
              Home
            </a>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-4xl px-4 pt-24 pb-20 sm:px-6 lg:px-8">

        {/* -------------------------------------------------------- */}
        {/*  Header                                                   */}
        {/* -------------------------------------------------------- */}
        <div className="mb-16 text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary-200 bg-primary-50 px-4 py-1.5 text-xs font-semibold text-primary-700">
            <Rocket className="h-3.5 w-3.5" />
            Deployment Guide
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight text-zinc-900 sm:text-5xl">
            Deploy BigBlueBam
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-zinc-500">
            From zero to running in about 10 minutes. No IT department required.
          </p>
        </div>

        {/* -------------------------------------------------------- */}
        {/*  Section 1: What You'll Need                              */}
        {/* -------------------------------------------------------- */}
        <section className="mb-16">
          <h2 className="mb-6 text-2xl font-bold text-zinc-900">What You'll Need</h2>
          <p className="mb-6 text-sm text-zinc-600 leading-relaxed">
            Before you start, here is what the deploy script will set up for you. You do not need to
            configure any of this by hand.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              {
                label: 'A place to run it',
                desc: 'Any machine with Docker, or a Railway account for managed cloud (both fully automated)',
              },
              {
                label: 'A database',
                desc: 'PostgreSQL 16, automatically provisioned and migrated',
              },
              {
                label: 'An admin account',
                desc: 'You will create this during setup -- takes 30 seconds',
              },
              {
                label: 'Optional extras',
                desc: 'File storage, AI features, vector search, voice/video -- all toggleable',
              },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-lg border border-zinc-200 bg-white p-5"
              >
                <p className="text-sm font-semibold text-zinc-900">{item.label}</p>
                <p className="mt-1 text-sm text-zinc-500">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* -------------------------------------------------------- */}
        {/*  Section 2: Choose Your Deployment                        */}
        {/* -------------------------------------------------------- */}
        <section className="mb-16">
          <h2 className="mb-6 text-2xl font-bold text-zinc-900">Choose Your Deployment</h2>
          <p className="mb-6 text-sm text-zinc-600 leading-relaxed">
            Two paths, same result. Pick the one that fits your team.
          </p>
          <div className="grid gap-6 sm:grid-cols-2">
            {/* Docker Compose card: currently the recommended path */}
            <div className="rounded-xl border-2 border-primary-200 bg-white p-6 shadow-sm">
              <div className="mb-3 flex items-center gap-2">
                <Server className="h-5 w-5 text-primary-600" />
                <h3 className="text-lg font-bold text-zinc-900">Docker Compose</h3>
                <span className="ml-auto rounded-full bg-primary-100 px-2.5 py-0.5 text-xs font-semibold text-primary-700">
                  Recommended
                </span>
              </div>
              <ul className="space-y-2 text-sm text-zinc-600">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  Run on any machine with Docker: Linux, macOS, Windows
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  Full control over your infrastructure
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  One <code className="rounded bg-zinc-100 px-1 text-xs">docker compose up</code> brings the entire stack online
                </li>
              </ul>
              <p className="mt-4 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-500 italic">
                Best for: Teams running BigBlueBam today. Works for both local
                development and production self-hosted deployments on a single
                VM or any Docker host.
              </p>
            </div>

            {/* Railway card */}
            <div className="relative rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
              <div className="mb-3 flex items-center gap-2">
                <Cloud className="h-5 w-5 text-zinc-500" />
                <h3 className="text-lg font-bold text-zinc-900">Railway</h3>
                <span className="ml-auto rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                  Fully automated
                </span>
              </div>
              <ul className="space-y-2 text-sm text-zinc-600">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  Cloud-hosted, managed infrastructure
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  Automatic HTTPS, scaling, managed Postgres &amp; Redis
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  Per-service config-as-code already in the repo (<code className="rounded bg-zinc-100 px-1 text-xs">railway/</code>)
                </li>
              </ul>
              <p className="mt-4 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-500 italic">
                Best for: Teams that want managed cloud hosting with zero server admin. The
                deploy script provisions the entire stack via Railway's public GraphQL API:
                project creation, all 19 services, env vars, and deploys in about
                5–10 minutes.
              </p>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------- */}
        {/*  Section 3: Step-by-Step Walkthrough                      */}
        {/* -------------------------------------------------------- */}
        <section className="mb-16">
          <h2 className="mb-8 text-2xl font-bold text-zinc-900">Step-by-Step Walkthrough</h2>

          <Step n={1} title="Clone the repository and launch the deploy script">
            <p className="text-sm text-zinc-600 leading-relaxed">
              First, clone the BigBlueBam repository. Then run the deploy script for your platform.
            </p>
            <CodeBlock title="Clone the repo">{`git clone https://github.com/eoffermann/BigBlueBam.git
cd BigBlueBam`}</CodeBlock>
            <p className="text-sm text-zinc-600 leading-relaxed mt-3">
              Now launch the interactive setup wizard:
            </p>
            <CodeBlock title="Linux / macOS">{`./scripts/deploy.sh`}</CodeBlock>
            <CodeBlock title="Windows (PowerShell)">{`.\\scripts\\deploy.ps1`}</CodeBlock>
            <CodeBlock title="Windows (Command Prompt)">{`scripts\\deploy.bat`}</CodeBlock>
            <Callout type="info">
              The script checks for Node.js and Docker, installing them if needed.
              On first run it may ask for permission to install dependencies.
              Docker is only required if you choose the Docker Compose deployment path. Railway
              deployments run entirely in the cloud.
            </Callout>
          </Step>

          <Step n={2} title="Pick your platform">
            <p className="text-sm text-zinc-600 leading-relaxed">
              The script presents a simple menu. Choose the deployment target that matches your plan.
            </p>
            <CodeBlock>{`Where are you deploying?

  1. Docker Compose: Run locally or on any server with Docker (recommended)
  2. Railway: Managed cloud containers, fully automated`}</CodeBlock>
            <Callout type="tip">
              Not sure? Docker Compose is great for local development and self-hosted
              production. Railway is simpler when you want managed cloud, and both are
              fully automated by the deploy script.
            </Callout>
          </Step>

          <Step n={3} title="Configure your services">
            <p className="text-sm text-zinc-600 leading-relaxed">
              The script auto-generates secure passwords and asks a few questions about optional features.
            </p>
            <div className="rounded-lg border border-zinc-200 bg-white p-5">
              <ul className="space-y-3 text-sm text-zinc-600">
                <li className="flex items-start gap-2">
                  <span className="mt-1 block h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500" />
                  <span><strong>File storage</strong> -- built-in MinIO (default) or bring your own S3 bucket</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-1 block h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500" />
                  <span><strong>Vector search</strong> -- powers the Beacon knowledge base semantic search (can skip)</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-1 block h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500" />
                  <span><strong>Voice/video</strong> -- LiveKit for team calls (can skip)</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-1 block h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500" />
                  <span><strong>Optional</strong> -- email notifications (SMTP), social login (OAuth)</span>
                </li>
              </ul>
            </div>
            <Callout type="tip">
              Most teams just press Enter for the defaults. You can change everything later
              in Settings or by editing your <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">.env</code> file.
            </Callout>
          </Step>

          <Step n={4} title="Deploy">
            <p className="text-sm text-zinc-600 leading-relaxed">
              The script takes it from here. Depending on which path you chose:
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-primary-200 bg-white p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Terminal className="h-4 w-4 text-primary-600" />
                  <p className="text-sm font-semibold text-zinc-900">Docker Compose</p>
                </div>
                <p className="text-xs text-zinc-500">
                  Pulls or builds all container images locally and starts the full stack
                  with a single <code className="rounded bg-zinc-100 px-1 text-xs">docker compose up -d</code>.
                  Migrations run automatically before app services start.
                </p>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Cloud className="h-4 w-4 text-zinc-500" />
                  <p className="text-sm font-semibold text-zinc-900">Railway</p>
                </div>
                <p className="text-xs text-zinc-500">
                  Logs in to your Railway account, creates the project, provisions
                  managed PostgreSQL + Redis, then creates and configures all 19
                  services via Railway's public GraphQL API.
                </p>
              </div>
            </div>
            <Callout type="info">
              This takes 3-5 minutes on first run while images are built or pulled.
              Subsequent starts are much faster.
            </Callout>
          </Step>

          <Step n={5} title="Create your admin account">
            <p className="text-sm text-zinc-600 leading-relaxed">
              Once services are running, the script walks you through creating the first user, a SuperUser
              with full admin access. You can choose to have a strong password generated for you, or type your own.
            </p>
            <CodeBlock>{`Let's create your admin account.

Email address: you@yourcompany.com

Password:
  1. Generate a strong password for me (recommended)
  2. I'll type my own password
> 1

  Your generated password:

    Falcon-Copper-Ribbon-Sage42!

  ⚠  Copy this now. It will not be shown again.

  ✓ Password saved to macOS Keychain
    Service: "BigBlueBam"  Account: "you@yourcompany.com"

  I've saved my password and I'm ready to continue (Y/n): Y

Your name: Jane Smith
Organization: Acme Corp

Creating account... ✓
Verifying login... ✓`}</CodeBlock>
            <Callout type="info">
              The generated password uses a memorable word-based format (like <code>Tiger-Maple-Creek-Storm73!</code>)
              that is both strong and easy to read. On macOS, Windows, and Linux desktops, the script can
              automatically save it to your system keychain so you don't need to write it down.
            </Callout>
            <Callout type="warning">
              This is a SuperUser account with full access to everything: all organizations, all settings,
              all data. Keep the password secure. You can create regular admin and member accounts from
              within the app once you're logged in.
            </Callout>
          </Step>

          <Step n={6} title="You're live!">
            <p className="text-sm text-zinc-600 leading-relaxed">
              The script prints a summary with all your URLs. Open any of them in your browser.
            </p>
            <CodeBlock>{`BigBlueBam is running!

  Bam (Projects):     https://your-domain/b3/
  Helpdesk:           https://your-domain/helpdesk/
  Banter (Messaging): https://your-domain/banter/
  Beacon (Knowledge): https://your-domain/beacon/
  Brief (Documents):  https://your-domain/brief/
  Bolt (Automations): https://your-domain/bolt/
  Bearing (Goals):    https://your-domain/bearing/`}</CodeBlock>
            <Callout type="tip">
              Bookmark the Bam URL -- it is the main project management interface and
              where most teams spend their time.
            </Callout>
          </Step>
        </section>

        {/* -------------------------------------------------------- */}
        {/*  Section 4: After Deployment                              */}
        {/* -------------------------------------------------------- */}
        <section className="mb-16">
          <h2 className="mb-6 text-2xl font-bold text-zinc-900">After Deployment</h2>
          <p className="mb-6 text-sm text-zinc-600 leading-relaxed">
            Your instance is running. Here are the next things most teams set up.
          </p>
          <div className="space-y-4">
            {[
              {
                title: 'Set up a custom domain',
                desc: 'Point your domain to the server and update DOMAIN in .env. Railway handles this in the dashboard; for Docker Compose, update your DNS and nginx config.',
              },
              {
                title: 'Configure AI providers',
                desc: 'Go to Settings and then AI Providers to add your OpenAI, Anthropic, or other LLM keys. This powers the MCP server, Beacon semantic search, and AI features throughout the suite.',
              },
              {
                title: 'Invite your team',
                desc: 'Navigate to People in Bam to invite team members by email. They will receive an invitation link to set up their account.',
              },
              {
                title: 'Import existing data',
                desc: 'Bam supports importing from CSV, Trello, Jira, and GitHub Issues. Go to any project and use the Import menu.',
              },
              {
                title: 'Set up email notifications',
                desc: 'Add SMTP credentials to your .env file (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS) or configure them in Settings to enable email notifications for ticket updates, mentions, and assignment changes.',
              },
            ].map((item) => (
              <div key={item.title} className="rounded-lg border border-zinc-200 bg-white p-5">
                <h3 className="text-sm font-semibold text-zinc-900">{item.title}</h3>
                <p className="mt-1.5 text-sm text-zinc-500 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* -------------------------------------------------------- */}
        {/*  Section 5: What's Running                                */}
        {/* -------------------------------------------------------- */}
        <section className="mb-16">
          <h2 className="mb-6 text-2xl font-bold text-zinc-900">What's Running</h2>
          <p className="mb-6 text-sm text-zinc-600 leading-relaxed">
            A full BigBlueBam deployment consists of {services.length} containers.
            Application services are stateless and can be scaled horizontally.
            Data services can be swapped for managed cloud equivalents by changing environment variables.
          </p>
          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                    Service
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                    Role
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                    Type
                  </th>
                </tr>
              </thead>
              <tbody>
                {services.map((svc, i) => (
                  <tr
                    key={svc.name}
                    className={i % 2 === 0 ? 'bg-white' : 'bg-zinc-50/50'}
                  >
                    <td className="px-4 py-2.5">
                      <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-medium text-zinc-800">
                        {svc.name}
                      </code>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600">{svc.role}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          svc.type === 'API'
                            ? 'bg-blue-50 text-blue-700'
                            : svc.type === 'Data'
                              ? 'bg-amber-50 text-amber-700'
                              : svc.type === 'Frontend'
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-zinc-100 text-zinc-600'
                        }`}
                      >
                        {svc.type}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* -------------------------------------------------------- */}
        {/*  Section 6: FAQ                                           */}
        {/* -------------------------------------------------------- */}
        <section className="mb-16">
          <h2 className="mb-6 text-2xl font-bold text-zinc-900">Frequently Asked Questions</h2>
          <div className="space-y-3">
            <FaqItem q="How does the Railway deploy work?">
              <p>
                The deploy script's Railway path uses Railway's public GraphQL
                API to provision and configure every service in the stack. You
                generate a Personal Access Token at{' '}
                <a
                  href="https://railway.com/account/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-600 underline underline-offset-2 hover:text-primary-700"
                >
                  railway.com/account/tokens
                </a>
                , paste it into the script, and it handles the rest: project
                creation, service creation (linked to the GitHub repo),
                per-service Dockerfile + healthcheck + environment variable
                configuration, and triggering the initial deploys. The only
                manual step is clicking "Add Postgres" and "Add Redis" in the
                Railway dashboard once, because Railway's public API doesn't
                expose plugin creation. Total run time: about 5–10 minutes from
                start to all services queued.
              </p>
            </FaqItem>

            <FaqItem q="How much will Railway cost?">
              <p>
                Railway offers a free Starter plan that includes $5 of usage per month.
                With BigBlueBam's 19 services + managed Postgres + Redis, expect to land
                in the Developer plan ($5/month + usage). Most small teams spend $20-40/month
                total once everything's running. See{' '}
                <a
                  href="https://railway.app/pricing"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-600 underline underline-offset-2 hover:text-primary-700"
                >
                  Railway pricing
                </a>{' '}
                for current details.
              </p>
            </FaqItem>

            <FaqItem q="Can I migrate between Railway and self-hosted?">
              <p>
                Yes, in either direction. Your data lives in PostgreSQL and Redis, both of which support standard
                backup/restore. Export your Postgres database with{' '}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">pg_dump</code>,
                import it into the destination, copy your{' '}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">.env</code> over,
                and run <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">docker compose up -d</code>.
                The migration service will apply any pending schema changes automatically.
              </p>
            </FaqItem>

            <FaqItem q="Which branch should I deploy?">
              <p>
                BigBlueBam uses a two-branch model:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>
                  <strong><code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">stable</code></strong>{' '}
                  is the production branch. Every commit has been validated on{' '}
                  <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">main</code> first.{' '}
                  <strong>This is the default.</strong> Pick it unless you specifically want the latest unreleased code.
                </li>
                <li>
                  <strong><code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">main</code></strong>{' '}
                  is the bleeding-edge integration branch. New features and fixes land here first. Choose this only if you're comfortable with the occasional rough edge.
                </li>
              </ul>
              <p className="mt-2">
                The deploy script prompts you once (on the first run) to choose between the two.
                Your choice is saved in{' '}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">.deploy-state.json</code>{' '}
                and reused on subsequent runs. To switch later, re-run with{' '}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">--reconfigure</code>.
              </p>
            </FaqItem>

            <FaqItem q="How do I update to a new version?">
              <p>
                The easiest way is to re-run the deploy script. It detects the existing
                installation, checks your chosen branch (default{' '}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">stable</code>) for new
                commits, forces a no-cache rebuild of the API image, runs migrations explicitly,
                and restarts services:
              </p>
              <div className="mt-2">
                <CodeBlock>{`./scripts/deploy.sh   # or deploy.ps1 on Windows`}</CodeBlock>
              </div>
              <p className="mt-2">
                If you'd rather drive the update manually, use the full sequence. A plain{' '}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">docker compose up -d --build</code>{' '}
                is <em>not</em> enough on an existing stack, because the{' '}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">migrate</code> sidecar
                is cached as <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">service_completed_successfully</code>{' '}
                and won't re-run, and the build cache can silently drop new migration files.
                Substitute <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">stable</code>{' '}
                with <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">main</code> if you opted into the bleeding-edge branch:
              </p>
              <div className="mt-2">
                <CodeBlock>{`git pull origin stable
docker compose build --no-cache api
docker compose up -d postgres
docker compose run --rm migrate
docker compose up -d --build`}</CodeBlock>
              </div>
              <p className="mt-2">
                The deploy script does all of this for you automatically, so you only need the
                manual sequence if you're scripting updates yourself.
              </p>
            </FaqItem>

            <FaqItem q="How do I back up my data?">
              <p>
                The critical data lives in PostgreSQL. Set up a cron job or use your hosting
                provider's automated backups.
              </p>
              <div className="mt-2">
                <CodeBlock title="Manual backup">{`docker compose exec postgres pg_dump -U bigbluebam bigbluebam > backup.sql`}</CodeBlock>
              </div>
              <p className="mt-2">
                For file attachments, back up the MinIO data volume or configure MinIO to
                replicate to an external S3 bucket.
              </p>
            </FaqItem>

            <FaqItem q="What if something goes wrong?">
              <p>
                Start by checking the logs for the affected service:
              </p>
              <div className="mt-2">
                <CodeBlock>{`# All services
docker compose logs -f

# Specific service
docker compose logs -f api

# Just the last 50 lines
docker compose logs --tail 50 api`}</CodeBlock>
              </div>
              <p className="mt-2">
                Common issues: port 80 already in use (stop Apache/nginx on the host), Docker
                out of disk space (run{' '}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">docker system prune</code>),
                or services failing health checks (increase Docker memory in Docker Desktop settings
                to at least 4 GB).
              </p>
            </FaqItem>

            <FaqItem q="Can multiple people deploy updates at the same time?">
              <p>
                The deploy script is idempotent -- running it again on a running instance will
                rebuild and restart services without losing data. However, you should coordinate
                deploys to avoid conflicting configuration changes. Most teams designate one
                person to handle deployments.
              </p>
            </FaqItem>

            <FaqItem q="How do I add HTTPS for self-hosted deployments?">
              <p>
                The easiest approach is to put a reverse proxy like Caddy or Traefik in front
                of the stack, which handles automatic Let's Encrypt certificates. Alternatively,
                replace the self-signed certificates in{' '}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">infra/nginx/certs/</code> with
                real certificates and update the nginx configuration.
              </p>
            </FaqItem>
          </div>
        </section>

        {/* -------------------------------------------------------- */}
        {/*  Footer CTA                                               */}
        {/* -------------------------------------------------------- */}
        <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
          <h2 className="text-xl font-bold text-zinc-900">Ready to deploy?</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-zinc-500">
            Clone the repo, run the script, and you will be up and running in minutes.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <a
              href="/docs"
              className="rounded-lg border border-zinc-200 bg-white px-5 py-2.5 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50"
            >
              Read the Docs
            </a>
            <a
              href="/#cta"
              className="rounded-lg bg-primary-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-700"
            >
              Get Started
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
