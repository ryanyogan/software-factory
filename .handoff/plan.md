

# Software Factory — Research & Product Plan
2026-10-16 · 

## Executive summary
Build a thin, very fast control plane for agent work, not another agent and not another everything-workspace. Engineers keep driving Claude Code, Codex or T3 Code from their own machine; the same runs show up live in a web GUI where teammates and business stakeholders watch, steer, review and approve.
The wedge is the gap every incumbent leaves open: a run that moves freely between your terminal, the cloud and the browser, carrying the org's context with it. Obvious, Factory and Cursor each own their own cockpit; none is a neutral layer over the agents engineers already use.
What we build (five objects, done perfectly):
- 
Project — a repo plus its brain, skills and settings
- 
Task — one unit of intent, one branch, one worktree
- 
Run — one agent execution, local or cloud, with a live event log, diff, checks and preview URL
- 
Review — the final gate where engineers and business sign off, in the GUI or in Slack
- 
Brain — org, project and personal knowledge plus the shared skill and plugin registry
Every object is reachable through three equal surfaces generated from one typed contract: the sf CLI, a remote MCP server, and the GUI.
What we will not build: docs, sheets, slides, galleries, timelines, app builders, meeting transcription, support agents, or our own coding agent. Obvious ships all of these; we beat it by doing far less.
Success in six months = our own team cancels Obvious seats because the local loop, review queue and Slack approvals are faster than what they replace.

## Landscape
A 2026 software factory is a pipeline where agents take work from intake to merged PR while humans set intent and review evidence (TrueFoundry, Unblocked). The market has split into cockpits that own the agent and control planes that wrap agents you already pay for.
|  | 
Product | 
Where you drive it | 
Where runs happen | 
Bring your own agent? | 
Gap we exploit
|  | 
Obvious (Autobuild) | 
Its web workspace | 
Obvious sandboxes | 
No | 
GUI-only cockpit, see next section
|  | 
Factory (Droids) | 
CLI, IDE, web, desktop, Slack | 
Local or Factory sandbox | 
No, its own Droid | 
Closed agent; no neutral layer over Claude Code or Codex
|  | 
Cursor cloud agents | 
Editor, CLI, web, Slack | 
Local or Cursor VM | 
No | 
CLI can push to cloud but not list or resume cloud agents (forum)
|  | 
Claude Code | 
Terminal, IDE, web, desktop | 
Local or Anthropic cloud | 
n/a | 
Handoff is web-to-local only; sessions siloed by surface (issue)
|  | 
Codex | 
CLI, IDE, app, ChatGPT | 
Local or OpenAI containers | 
n/a | 
Single-vendor; no org brain
|  | 
T3 Code | 
Desktop and web GUI | 
Your machine | 
Yes: Claude Code, Codex, OpenCode, Cursor | 
Single-player; no cloud runs, review gate or business view
|  | 
Superset | 
Desktop GUI | 
Your machine | 
Yes | 
Local-only; no team layer
The pattern: cockpits (Obvious, Factory, Cursor) have team features but lock you to their agent and UI; control planes (T3 Code, Superset) respect your agent but stop at one laptop. Nobody combines a bring-your-own-agent control plane with multiplayer, cloud runs and a business review surface. That is the product.

## Obvious teardown
Obvious (formerly Flatfile, $50M Series B) is a general AI workspace with an engineering "factory" bolted on; we keep roughly 4 of its 12 feature areas and cut the rest. Its own positioning treats Autobuild as the first of several factories, with AutoDesign and AutoGrowth next (LLM info). Feature claims below are from Obvious's own site and help center.
|  | 
Area | 
What Obvious offers | 
Our call
|  | 
Autobuild | 
Spec in, agents run understand, research, spec, plan, implement, self-review, PR review, per-package QA, deliver; loops up to 3 tries (home) | 
Keep the run loop, drop the spec-first ceremony
|  | 
Sandboxed code work | 
Isolated sandbox from your repo; PRs linked for review (help) | 
Keep, but local is first-class
|  | 
PR dashboard | 
Board, PRs, issues; review SLA dashboard built for 6,000+ PRs in one project (build blog) | 
Keep as the Review queue
|  | 
Atlas | 
System map of the codebase | 
Keep as Brain, exposed over MCP
|  | 
Skills, memory, custom agents | 
Reusable skills, persistent memory, agent personas | 
Keep skills and memory; cut personas
|  | 
Integrations | 
Slack, GitHub, Linear, Figma, Calendar, Notion, Attio; inbound MCP over HTTPS (MCP help) | 
Keep Slack and GitHub only in v1
|  | 
Collaboration | 
Presence, comments, team spaces, templates | 
Keep presence and comments
|  | 
Artifacts | 
Docs, sheets, slides, apps, galleries, timelines, boards, dashboards | 
Cut
|  | 
Meetings | 
Transcription, summaries, action items | 
Cut
|  | 
Support agents | 
Ticket triage with human escalation | 
Cut
|  | 
Pricing | 
$25 and $200 personal, $40 and $240 per seat team; credits at $0.85 from a shared pool (billing, pricing) | 
Bring your own agent subscription; we charge for the platform
Where it falls short for engineers:
- 
The GUI is the only cockpit. Docs cover connecting MCP servers into Obvious, but I found no first-party CLI or MCP server for driving Obvious from Claude Code, Codex or a terminal.
- 
Your local environment doesn't come along. Connected MCP servers must be public HTTPS endpoints reachable from Obvious's infrastructure, so local, stdio and VPN-only tools are out (MCP help).
- 
Breadth over depth. Ten-plus artifact types, meetings and support agents compete with engineering for product attention.
- 
Batch, not pairing. The model is precise specs and overnight builds without supervision; most engineering time is the iterative loop, which this serves poorly.
- 
Opaque cost. Credits bundle models, compute and storage into one pool with auto-reload; the pricing page lists no bring-your-own-key option.
- 
Review becomes the bottleneck. Obvious says so itself: at hundreds of agent PRs a day, review latency dominates. We design for review first, not last.
Open question: list the specific pain points our team hits in Obvious today so we can turn each into an acceptance test.

## The core gap: TUI and GUI as one session
Engineers want to start in the terminal, glance at a GUI, hand a long job to the cloud, and pull it back, without losing context; in October 2026 no vendor-neutral tool does this in both directions. Each vendor solves it only for its own agent, and usually one way.
|  | 
Tool | 
Local to cloud | 
Cloud to local | 
Across agents
|  | 
Claude Code | 
& prefix sends a task to web | 
/teleport pulls a web session down | 
No
|  | 
Cursor | 
& hands off to a cloud agent | 
IDE handoff both ways since June 2026; CLI cannot resume | 
No
|  | 
T3 Code | 
No cloud runs | 
n/a | 
Yes, locally
|  | 
Obvious | 
No local runs | 
n/a | 
No
Our design answer: the Run is the session, not the agent. A Run owns an append-only event log (prompts, tool calls, diffs, checks, comments) stored in a Durable Object. The local sf daemon wraps the agent's own CLI (Claude Code, Codex, OpenCode) and streams its events up; a cloud Sandbox does the same. Any surface reads and writes the same log.
What that buys engineers:
- 
sf run in the terminal shows up live in the GUI within a quarter second; a teammate can comment on the diff while you work
- 
sf push moves a run to a cloud Sandbox with the branch, uncommitted changes and transcript; your laptop is free
- 
sf pull <run> brings it back into a local worktree and resumes the agent with a generated context pack
- 
sf open jumps from the terminal to the exact run in the browser, and every GUI action shows its CLI command to copy
- 
Switching agents mid-task (Claude Code to Codex) works because the context pack, not the vendor transcript, is the handoff format
This is the one thing we must make feel magical; everything else in the plan supports it.

## Principles and the small feature set
Seven rules decide every feature argument; anything that breaks one is cut.
- 
Local first. The engineer's machine, agent, MCP servers and dotfiles are the default runtime. Cloud is an option, never a requirement.
- 
Three equal surfaces. CLI, MCP and GUI are generated from one contract. If a verb exists in one, it exists in all three.
- 
Bring your own agent. We orchestrate Claude Code, Codex and OpenCode; we never ship a competing harness or resell tokens.
- 
The home screen is "needs you", not a chat box. Reviews awaiting you, runs blocked on a question, failed checks.
- 
Review is the product. Every run ends in evidence: diff, checks, preview URL, screenshots, cost.
- 
Fast is a feature. A budget is set per interaction and enforced in CI (see Performance budget).
- 
Git is the source of truth. Skills, plugins and run workspaces live in git, so engineers can diff, PR and revert them.
|  | 
Capability | 
v1 | 
Later | 
Never
|  | 
Tasks with branch and worktree per task | 
✓ | 
 | 

|  | 
Runs: local daemon, cloud Sandbox, two-way handoff | 
✓ | 
 | 

|  | 
Live run view: transcript, diff, terminal, preview | 
✓ | 
 | 

|  | 
Review queue and final-review gate | 
✓ | 
 | 

|  | 
Brain: chat, search, context packs | 
✓ | 
 | 

|  | 
Skill and plugin registry with sf skills sync | 
✓ | 
 | 

|  | 
Remote MCP server and sf CLI | 
✓ | 
 | 

|  | 
GitHub PRs and checks | 
✓ | 
 | 

|  | 
Slack: notify, start a task, approve | 
✓ | 
 | 

|  | 
Presence, comments, @mentions | 
✓ | 
 | 

|  | 
Linear and Jira intake | 
 | 
✓ | 

|  | 
Scheduled and triggered runs | 
 | 
✓ | 

|  | 
SSO, SCIM, audit export | 
 | 
✓ | 

|  | 
GitLab and Bitbucket | 
 | 
✓ | 

|  | 
Mobile review app | 
 | 
✓ | 

|  | 
Our own coding agent | 
 | 
 | 
✓
|  | 
Docs, sheets, slides, galleries, timelines | 
 | 
 | 
✓
|  | 
Meeting transcription, support agents | 
 | 
 | 
✓

## Architecture
Everything runs on Cloudflare: TanStack Start on Workers for the GUI, Durable Objects for every live thing, Sandboxes for cloud runs, Artifacts for git, AI Search for the brain. TanStack lists Cloudflare Workers as an official deploy partner via @cloudflare/vite-plugin (TanStack), and Cloudflare's April 2026 Agents Week shipped most of the remaining primitives (Cloudflare blog).
Every surface talks to the same Workers; every Run writes to one RunLog Durable Object, which is why a session started in the terminal can be watched in the browser and resumed in a cloud Sandbox.
|  | 
Need | 
Cloudflare primitive | 
Why it fits
|  | 
GUI and server functions | 
Workers + TanStack Start | 
Edge SSR, one deploy
|  | 
Live state per project and per run | 
Durable Objects (Agents SDK) | 
Single-writer ordering, local SQLite, WebSocket hibernation
|  | 
Org, user, project, task records | 
D1 | 
Relational, cheap; Hyperdrive to Postgres if analytics outgrow it
|  | 
Cloud runs | 
Sandboxes (GA April 2026) | 
PTY over WebSocket, background processes, preview URLs, egress credential injection so agents never see tokens (lilting)
|  | 
Run workspaces, skill registry | 
Artifacts | 
Git-compatible repos, forks, short-lived tokens, any git client (Cloudflare)
|  | 
Brain retrieval | 
AI Search | 
Hybrid vector + BM25, per-instance namespaces, built-in MCP endpoint (AI/TLDR)
|  | 
Durable pipelines | 
Workflows, Queues | 
Retries for indexing, checks, PR sync
|  | 
Logs, screenshots, transcripts | 
R2 | 
Cheap blobs, zero egress
|  | 
Brain chat models | 
AI Gateway | 
Routing, caching, per-org cost tracking
|  | 
MCP server | 
McpAgent + OAuth | 
Remote MCP over streamable HTTP
Monorepo (pnpm workspaces + Turborepo):
The contract package is the key decision. Each command (task.create, run.push, review.approve) is a zod schema plus a handler; build steps generate the REST routes, CLI subcommands with --json, and MCP tools from it. Cloudflare took the same approach for its unified cf CLI to stop naming drift across 3,000 operations (lilting). Tooling: Biome, Vitest, Playwright, Changesets for CLI releases, wrangler environments per PR.

## Org brain and the shared registry
The brain answers one question for any agent or person: "given where I am right now, what do I need to know and which skills should load?" It returns a context pack, not a chat transcript.
Three layers, merged most-specific-wins:
|  | 
Layer | 
Holds | 
Source
|  | 
Org | 
Standards, security policy, architecture decisions, glossary | 
Registry repo org/
|  | 
Project | 
Code index, ADRs, runbooks, recent merged PRs and review comments | 
Repo + GitHub sync
|  | 
Personal | 
Your preferences, shortcuts, private notes | 
Per-user AI Search instance
Context resolution is automatic. The daemon reads cwd, git remote and branch: remote maps to a Project, branch maps to a Task, and the Task's linked issue, prior runs and review threads become part of the pack. In the GUI, the open Project and Task do the same job.
The registry is one git repo in Artifacts (mirrored to GitHub if preferred) with skills/, plugins/, prompts/ and org/. Skills use the Agent Skills SKILL.md format so Claude Code, Codex and Cursor load them natively. sf skills sync writes the right subset into .claude/, .codex/ or .cursor/ for the current project; changes go through normal PRs, so skills get reviewed and versioned like code.
Exposed everywhere through the same contract:
- 
MCP tools: brain.search, brain.context_for_task, skills.resolve, decisions.record
- 
CLI: sf ask "how do we do feature flags here?", sf context (prints the pack), sf skills sync
- 
GUI: a brain chat docked to the current Project, citing the files and PRs it used
Indexing: Queues feed a Workflow that chunks code by symbol, embeds into per-project AI Search instances, and reindexes changed files on each push. Merged-PR review comments are indexed too, so "we don't do it that way" feedback becomes retrievable knowledge.
Open question: do we want Cloudflare's managed Agent Memory (beta) for durable facts, or keep facts as markdown in the registry where engineers can see and edit them? Recommendation: markdown first.

## Builds, final review and Slack
One list of Runs replaces Obvious's board, PR page and issues tabs: every Run has a state, an owner, evidence, and a single next action.
Run lifecycle:
- 
Queued — created from CLI, MCP, GUI or Slack; picks local or cloud
- 
Running — live transcript, diff and terminal; can push or pull between local and cloud at any time
- 
Blocked — the agent asked a question; it lands in the asker's "needs you" list and Slack DM
- 
Checks — CI, type check, tests, preview deploy and screenshots attached as evidence
- 
Review — engineer approves the code; reviewers comment inline; "changes requested" sends it back to Running with the comments in the context pack
- 
Final review — business sign-off on the preview, not the diff
- 
Merged or Abandoned — the outcome and review comments feed the brain
Builds view (GUI): one table with filters for mine, my team, blocked, failing; columns for state, agent, local or cloud, age, cost, checks. Keyboard: j/k to move, enter to open, a to approve, p to push to cloud. The same query works as sf runs --mine --blocked --json.
Final review is the business surface. A PM, designer or stakeholder sees a plain-language summary the agent writes, the preview URL, before and after screenshots, and a checklist the Project defines. They approve or request changes without opening GitHub. Approvals are recorded on the Run and posted to the PR.
Slack, kept small:
- 
One channel per Project receives run state changes, threaded per Run
- 
/sf task "fix the flaky checkout test" creates a Task and starts a cloud Run
- 
Approve, request changes and "take it local" buttons on review messages
- 
Agent questions arrive as DMs; replying in Slack answers the agent
Cost shows per Run and per Project because we know the agent and the minutes; no credit pool to guess at.

## Real-time and collaboration
Two Durable Object classes carry all real-time traffic: a ProjectRoom per Project and a RunLog per Run. Both use WebSocket hibernation, so idle rooms cost nothing.
- 
ProjectRoom — presence (who is in which Task or Run), the Builds list deltas, Slack fan-out, typing and cursor hints
- 
RunLog — the ordered event stream for one Run: agent output, tool calls, diff snapshots, comments, approvals, handoff markers; replays from any sequence number so a reconnecting CLI or tab catches up instantly
Collaboration features in v1:
- 
Live follow: open a teammate's Run and watch the agent work, in the GUI or with sf watch <run>
- 
Inline comments on diff lines, visible to the agent on its next turn
- 
@mentions in comments and brain chat, routed to Slack DMs
- 
Take over: request control of a Run; the owner approves and the daemon on your machine resumes it
- 
Steer: send a message into someone else's running agent, with the owner's permission
Client data layer: TanStack Query holds server state; one WebSocket per tab subscribes to the ProjectRoom and any open RunLog and writes patches straight into the query cache. No polling anywhere. The CLI uses the same subscription protocol, so terminal and browser see identical state.

## Performance budget and UX bar
"Fast as hell" becomes numbers checked in CI on every PR; a regression past budget blocks merge. These are proposed targets to validate in Phase 1.
|  | 
Interaction | 
Budget (p95) | 
How
|  | 
Command palette open | 
50 ms | 
Client-only, preloaded index
|  | 
Route change within app | 
100 ms | 
TanStack Router preloading on hover, cached queries
|  | 
GUI first load, warm | 
1 s | 
Edge SSR, streamed, code-split by route
|  | 
Local agent event to GUI | 
250 ms | 
Daemon WebSocket to RunLog DO, direct cache patch
|  | 
sf CLI cold start | 
150 ms | 
Bun-compiled single binary, lazy imports
|  | 
MCP tool call (non-search) | 
300 ms | 
Worker reads DO SQLite on the same machine
|  | 
Brain search | 
800 ms | 
AI Search hybrid, per-project instance
|  | 
Cloud run start | 
15 s | 
Sandbox backup/restore of node_modules and build cache
|  | 
Local to cloud handoff | 
10 s | 
Push worktree delta to Artifacts, resume in Sandbox
UX bar, borrowed from T3 Code and tightened:
- 
Three panes: Projects, Tasks, the open Run; nothing else on the main screen
- 
Home is "needs you": reviews, blocked runs, failing checks, in that order
- 
Keyboard for everything, shown in tooltips; cmd-k reaches every verb
- 
Every GUI action has a "copy as CLI" affordance, so the GUI teaches the CLI
- 
Diff viewer per agent turn, split or unified, with inline comments
- 
Embedded xterm for cloud runs, using Sandbox PTY over WebSocket
- 
shadcn components with one token set; dark and light; dense by default
- 
No spinners over 300 ms without progress text; no modal for anything reversible

## Roadmap
Each phase ships to our own team before the next starts; a phase is done only when its gate passes, not when its scope is coded. Durations are estimates for a small senior team and assume the Phase 0 contract package lands first. Metrics to track from Phase 1: weekly active engineers, runs per engineer per day, share of runs started from CLI or MCP versus GUI, median review wait, and handoff latency.

## Risks and open questions
|  | 
Risk | 
Impact | 
Mitigation
|  | 
Agent CLIs change output formats or terms of use | 
Adapters break | 
Thin adapters per agent, contract tests against each CLI release; prefer official SDKs (Claude Agent SDK, Codex SDK) over screen-scraping
|  | 
Vendors ship their own two-way handoff | 
Wedge narrows | 
Our handoff is cross-agent and team-visible; vendors only solve it for their own agent
|  | 
Sandboxes snapshots still "coming soon" | 
Slow cloud start | 
Use backup and restore now; budget assumes it
|  | 
D1 limits for analytics | 
Slow dashboards | 
Hyperdrive to Postgres when needed; keep hot state in DOs
|  | 
Secrets in cloud runs | 
Leak | 
Sandbox egress credential injection; agents never hold tokens
|  | 
Scope creep toward Obvious's breadth | 
Slow, mediocre product | 
The "Never" column is a written commitment
Open questions for you:
- 
Is this an internal tool first, a product for sale, or both? It changes how much we invest in multi-tenant billing in v1.
- 
GitHub only in v1, or do we need GitLab or Bitbucket from day one?
- 
Which three Obvious workflows does the team use most today? Those become Phase 5 acceptance tests.
- 
Working name and CLI binary (sf is a placeholder).

## Sources
- 
Obvious: home, LLM info, pricing, billing, How Autobuild works, What is Autobuild, Connecting MCP servers, Orchestration layer
- 
Factory Droids
- 
Cursor cloud agents guide, Cursor CLI cloud handoff, Cursor CLI resume request
- 
Claude Code teleport tutorial, Claude Code surface silo issue
- 
Codex vs Cursor (OpenHands)
- 
T3 Code guide (Better Stack), Superset vs T3 Code
- 
Software factory guide (TrueFoundry), Buyer's guide (Unblocked)
- 
Cloudflare Agents Week roundup, Sandboxes GA and unified CLI, Artifacts, AI Search, Cloudflare Skills
- 
TanStack Start hosting