# Production Webapp Toolkit Roadmap

This roadmap defines the planned evolution from repository quality toolkit to a generic production readiness control plane.

## Product boundary

The toolkit stays generic and public. Application business rules, credentials, private infrastructure, customer data, and organization specific canonical truth do not belong here.

The toolkit may inspect and enforce engineering contracts, but it must not invent production truth or application business rules.

Core principles:

* Explicit configuration beats inference.
* Read only inspection is the default.
* Technical failure, warning, mismatch, and missing evidence remain distinct states.
* Evidence validity is not the same as authenticity or correctness.
* Application specific policies live outside the public toolkit.
* Automated remediation is limited to deterministic, low risk changes.

## v1.1 Reporting and deployment truth

1. Add deployment as a fourth repository status dimension after quality, governance, and baseline.
2. Add deployment to ecosystem status with per repository aggregation.
3. Preserve direct commit and Runtime Evidence Contract input modes without duplicating validators.
4. Add evidence freshness semantics without silently generating collection timestamps.
5. Add explicit runtime identity binding so evidence cannot be accidentally applied to the wrong runtime.
6. Pin the toolchain used by CI and local development so package metadata and CI do not drift.
7. Expand release readiness to verify the full v1.1 capability surface and documentation.
8. Add clean checkout release validation and end to end evidence to ecosystem status tests.
9. Publish v1.1.0 with release notes that define status and trust semantics.

### Current v1.1 progress

* Repository status deployment dimension: merged.
* Ecosystem status deployment dimension: merged.
* Evidence freshness: merged.
* Runtime identity binding: merged.
* Reproducible toolchain and v1.1 release-readiness gate: merged.
* v1.1.0 released and published.

## v1.2 Production readiness

### Current v1.2 progress

* CI Evidence Contract v1 and explicit CI verification: merged.
* Repository CI status integration: merged.
* Ecosystem CI status integration: merged.
* GitHub Actions CI Evidence adapter: merged.
* Authenticated read-only GitHub Actions CI Evidence collector: merged.
* Read-only GitHub branch protection and ruleset audit: merged.
* Environment Contract v1 audit: merged.
* Client environment exposure and unsafe public naming audit: merged.
* Public safety expansion for credentials, frontend artifacts, and CI leakage: merged.
* Database migration safety audit: merged.
* Database Schema Snapshot v1, schema drift comparator, and read-only PostgreSQL observed catalog collector: merged.
* PostgreSQL Security Snapshot v1, explicit security policy audit, and read-only catalog collector: merged.
* API Contract Snapshot v1, provider-neutral compatibility comparator, and bounded OpenAPI JSON adapter: merged.
* Cross-repository Contract Inventory v1 and explicit version/consensus policy audit: merged.
* Dependency/runtime drift expansion with runtime policy and ecosystem version matrix: merged.
* Provider-neutral vulnerability evidence, OSV and GitHub Dependabot collectors, and explicit vulnerability policy audit: merged.
* CycloneDX SBOM generation from explicit release identity and Bun lockfile evidence: merged.
* Artifact-bound dependency license evidence, installed-manifest collector, and explicit exact-expression policy audit: merged.
* Build Reproducibility Policy v1 with lockfile, runtime, package-manager, frozen-install, and explicit generated-input hash checks: merged.
* Artifact Provenance Contract v1 with explicit source, exact CI build, artifact SHA256, deployment artifact identity, and runtime binding: merged.
* Explicit Change Surface Evidence v1 and policy-driven LOW/MEDIUM/HIGH release risk classification with concrete drivers: merged.
* Read-only Git changed-surface analyzer with explicit path policy, diff metrics, test/environment detection, and bounded npm major-upgrade detection: merged.
* Policy-driven test selection with an always-selected blocking baseline and surface/flag-triggered additional tests: merged.
* Policy-driven flaky check detection from repeated canonical CI Evidence v1 with explicit observation thresholds and blocking/advisory severity: merged.
* Coverage Comparison Evidence v1 with changed-file minimum/regression gates and aggregate critical-module coverage policy: merged.
* Provider-neutral Orphan Evidence v1, local TypeScript/JSON static collector, and explicit dead-code/orphan policy audit covering exports, routes, feature flags, translations, and handlers: merged.
* Repository Hygiene Policy v1 with stale configuration, duplicate configuration, generated artifact, duplicate workflow, and oversized tracked-file checks: merged.
* Documentation Drift Policy v1 with package command, environment contract, repository path, and generated-document source binding checks: merged.
* CODEOWNERS Ownership Policy v1 with GitHub-compatible location precedence, syntax checks, last-match assignment, and explicit critical-path owner requirements: merged.
* v1.2 production-readiness capabilities are complete.

10. Add CI evidence for the exact commit being evaluated, including tests, typecheck, lint, and build outcomes.
11. Add read only GitHub branch protection and ruleset auditing.
12. Add environment contract auditing without reading secret values.
13. Detect client exposed server secrets and unsafe public environment naming.
14. Expand public safety for private keys, credentials, frontend bundle exposure, and CI leakage patterns.
15. Add database migration safety checks for destructive changes, ordering, locking, and irreversibility.
16. Add database schema drift detection between migrations, expected schema snapshots, and observed schema.
17. Add optional PostgreSQL and Supabase security policy checks, including RLS and grants.
18. Add API contract compatibility auditing using explicit schemas or generated contract snapshots.
19. Add cross repository contract version checks without embedding private business rules.
20. Expand dependency drift to cover runtime, package manager, framework, and client library versions.
21. Add security vulnerability evidence from supported advisory sources.
22. Add SBOM generation for releases.
23. Add dependency license compliance checks.
24. Add build reproducibility checks for lockfiles, pinned runtimes, and deterministic generated inputs.
25. Add artifact provenance from source commit through CI build to deployment artifact identity.
26. Add release risk classification based on explicit changed surfaces and policy inputs.
27. Add changed surface analysis for frontend, database, auth, payment, deployment, API, and infrastructure changes.
28. Add policy driven test selection while retaining required blocking checks.
29. Add flaky test detection from repeated CI evidence.
30. Add coverage regression checks focused on changed and critical modules.
31. Add dead code and orphan detection for exports, routes, feature flags, translations, and obsolete handlers.
32. Add repository hygiene checks for stale configuration, generated artifacts, duplicate workflows, and oversized tracked files.
33. Add documentation drift checks for commands, environment contracts, architecture references, and generated documentation.
34. Add CODEOWNERS and ownership policy checks for critical paths.

## v1.3 Runtime assurance

### Current v1.3 progress

* Runtime Collector Observation v1 and shared adapter to canonical Runtime Evidence Contract v1 with explicit checkout, application-reported, container, and process identity scopes: merged.
* Clean local Git checkout Runtime Evidence collector with explicit checkout-only identity scope: merged.
* Application-reported build identity collector for bounded local JSON files and explicit no-redirect version endpoints: merged.
* Running Docker container revision-label collector and live local process socket collector: merged.
* Runtime evidence freshness policy with stale and future-evidence warnings: merged and active in deployment, repository, and ecosystem status flows.
* Provider-neutral Runtime Health Evidence v1 and explicit freshness/check policy audit, intentionally separate from deployment identity: merged.
* HTTPS-first synthetic production smoke runner with GET/HEAD-only requests, no redirects or credentials, bounded JSON assertions, and explicit read-only endpoint ownership boundary: merged.
* Browser-based frontend runtime checks for route status, console/page errors, failed requests/assets, hydration markers, CSP violations, and blocked mutation attempts: merged.
* Provider-neutral Performance Evidence v1 with exact commit/freshness binding and explicit bundle, LCP, CLS, and INP budget audit: merged.
* Browser-based axe-core accessibility gates for explicitly configured critical routes with bounded impact thresholds and non-destructive request controls: merged.
* Browser-based SEO production checks for metadata, canonical URLs, robots, sitemap membership, hreflang, JSON-LD types, noindex and bounded internal-link health: merged.
* Static localization completeness audit for catalog key parity, placeholder parity, bounded exact-reference fallback leakage, HTML policy, and explicit currency-formatting rules: merged.
* Route Inventory v1 and explicit route coverage audit for route identity, auth-policy binding, test-file binding, and Synthetic Smoke Policy probe binding: merged.
* TypeScript-AST authorization policy audit for policy-bound admin routes, server guard calls, centralized middleware guards, and client-only authorization patterns: merged.
* Policy-driven webhook safety audit covering signature verification, idempotency, replay handling, event ordering, retry safety, and unknown-event handling using shared TypeScript AST call evidence: merged.
* Optional payment integrity profile for idempotency, provider binding, amount and currency pre-provider ordering, webhook signature verification, refund linkage, capture state, and reconciliation hooks: merged.
* Booking Integrity Evidence v1 plus optional booking integrity profile for atomic-claim structure, duplicate prevention, expiry, release, timezone and retry controls with commit-bound concurrency outcomes: merged.
* Policy-driven scheduled job audit for explicit timezone, scheduler registration, locking/overlap posture, timeout, retries, and dead-letter handling: merged.
* Backup Readiness Evidence v1 plus deterministic backup/restore readiness audit for recency, encryption policy, restore instructions, and restore-test evidence: merged.
* Disaster Recovery Contract v1 and deterministic readiness audit for source, database, secrets, DNS, deployment, rollback, and restore ownership/runbook coverage: merged.
* Rollback Readiness Contract v1 and deterministic release rollback audit binding current/previous artifact provenance, exact Change Surface Evidence, prior artifact SHA256 availability, documented rollback command, and canonical migration safety: implementation complete on the active capability branch.
* v1.3 runtime-assurance capabilities are complete pending merge of the active rollback-readiness capability.

35. Add runtime evidence collectors as separate adapters that emit Runtime Evidence Contract documents.
36. Support local Git checkout evidence while clearly labeling it as checkout evidence, not process identity.
37. Support application reported build identity from an explicit version endpoint or equivalent local interface.
38. Support container and process deployment identity where the runtime can expose it safely.
39. Add runtime evidence freshness policy and stale evidence warnings.
40. Add runtime health checks that remain distinct from deployment identity.
41. Add synthetic production smoke tests with explicit non destructive boundaries.
42. Add frontend runtime checks for broken routes, console errors, failed assets, hydration errors, and security policy violations.
43. Add performance budgets for bundle size and selected user experience metrics.
44. Add accessibility gates for critical routes.
45. Add SEO production checks for metadata, canonical URLs, sitemap, robots, hreflang, and structured data.
46. Add localization completeness checks for missing keys, placeholder mismatches, fallback leakage, and formatting drift.
47. Add route inventory and route coverage checks for auth, tests, and smoke coverage.
48. Add authorization policy checks for unguarded admin routes, server endpoints, and client only authorization patterns.
49. Add webhook safety profiles for signature verification, idempotency, replay handling, ordering, retries, and unknown events.
50. Add optional payment integrity policy packs for idempotency, persisted provider binding, amount and currency integrity, webhook verification, refunds, capture state, and reconciliation hooks.
51. Add optional booking integrity policy packs for atomic inventory claims, concurrency, duplicate prevention, expiry, release, timezone consistency, and retry safety.
52. Add scheduled job checks for locking, overlap, timeout, retries, dead letter handling, and timezone ambiguity.
53. Add backup readiness evidence covering recency, encryption policy, restore instructions, and restore test evidence.
54. Add disaster recovery readiness contracts for source, database, secrets, DNS, deployment, rollback, and restore procedures.
55. Add rollback readiness checks for prior artifacts, migration compatibility, destructive changes, and documented rollback paths.

## v1.4 Multi project control

### Current v1.4 progress

* Repository Manifest v1 for explicit repository identity, profile, runtime, database, capabilities, and required/advisory check declarations: merged.
* Versioned public policy-pack registry and monotone resolver for service, webapp, Python service, database-backed webapp/service, payment service, booking service, worker, and bot profiles: merged.
* Private Organization Policy v1 inheritance with monotone global, profile, and repository layers above the public policy-pack engine: merged.
* Repository Check Evidence v1 plus policy-aware cross-repository Ecosystem Dashboard v1 with stable machine-readable summaries: merged.
* Validated Ecosystem Dashboard v1 snapshot history comparison with descriptive repository/check transitions that preserve prior/current audit truth: merged.
* Scheduled Reporting Policy v1 and deterministic notification planner with declarative cadence, symbolic sink ids, current-state/history triggers, and no dispatch surface: merged.
* Severity Policy v1 with monotone required/advisory promotion, non-pass impact escalation, and Ecosystem Dashboard integration without silent weakening: merged.
* v1.4 multi-project-control capabilities are complete.

56. Introduce a versioned repository manifest so projects can declare profile, runtime, database, capabilities, and required checks.
57. Introduce policy packs such as webapp, Python service, database backed webapp, payment service, booking service, worker, and bot.
58. Support private organization policy inheritance layered above the public generic engine.
59. Add cross repository ecosystem dashboards and machine readable summaries.
60. Add historical comparison between current and previous status reports without changing audit truth.
61. Add scheduled reporting and notifications only after report semantics are stable.
62. Add configurable severity and required versus advisory policy without allowing silent policy weakening.

## v2.0 Controlled automation

### Current v2.0 progress

* Remediation Plan v1 expands existing remediation output with automation posture, remediation risk, ownership, repository-relative file targets, and canonical validation requirements while preserving the existing safe/manual executor contract: merged.
* Safe Autofix v1 hardens automatic remediation to explicit low-risk toolkit-owned allowlisted actions with symlink/path containment, exclusive creation, exact-copy verification, and canonical post-apply validation: merged.
* Agent Safety Policy v1 binds AGENTS.md to explicit canonical sources, exact fenced test commands, and secrets/migration/deployment boundary policy files without interpreting private policy contents: merged.
* Diff-aware Architecture Policy v1 selects private rule packs from Repository Manifest profile/capabilities and evaluates only commit-bound changed files with forbid-change, forbid-import, and require-import rules: merged.
* Controlled Agent Workflow v1 composes remediation planning, Agent Safety evidence, and private protected-path policy into proposal-only autofix/propose/human/blocked dispositions with execution explicitly unauthorized: merged.
* Release Evidence Bundle v1 hashes and cross-validates canonical CI, dependency, vulnerability, artifact provenance, runtime deployment, runtime health, baseline, and optional private policy evidence without copying underlying payloads: merged.
* Generic Control Evidence Export v1 validates standalone release bundles and emits optional JSON/CSV evidence-coverage exports with explicit `complianceClaim: false` and no built-in standards claims: merged.
* Deployment Gate v1 combines validated release and rollback evidence with explicit trust, CI, runtime-health, vulnerability, and rollback policy into ALLOW/BLOCK/UNVERIFIED decisions while retaining no execution surface: merged.
* v2.0 controlled-automation roadmap capabilities are complete in the current source tree.
* v2.0.0 release closeout includes current-version release readiness and release notes; publication is performed only after a green release PR.

63. Expand machine readable remediation plans with risk, ownership, files, and validation requirements.
64. Add safe autofix only for deterministic low risk repository configuration changes.
65. Add AI agent safety profiles covering AGENTS.md, canonical source references, test commands, secret policy, migration policy, and deployment boundaries.
66. Add diff aware architecture policy evaluation driven by project manifests and private policy packs.
67. Add controlled agent workflows that can propose fixes but cannot silently cross production or business truth boundaries.
68. Add release evidence bundles containing source commit, CI evidence, dependency snapshot, security results, baseline, deployment evidence, and runtime health.
69. Add optional compliance export formats without turning the toolkit into a compliance product by default.
70. Add policy driven deployment gates only after evidence authenticity and rollback readiness are mature.

## Explicit non goals until justified

The toolkit does not become a deployment platform, secret store, database control plane, business rules engine, or general SSH orchestrator.

It does not automatically change production infrastructure, GitHub protection settings, databases, payment providers, or runtime services unless a future capability is separately designed with explicit mutation boundaries.

## Immediate build order

1. Repository status deployment dimension.
2. Ecosystem status deployment dimension.
3. Evidence freshness and runtime identity binding.
4. Toolchain pinning and reproducible release checks.
5. v1.1 release readiness update and v1.1.0 release.
6. Repository manifest and initial policy pack design.
7. Environment contract, CI evidence, GitHub policy, migration safety, security, and API contract capabilities.
8. Runtime collectors and runtime health only after the reporting chain is stable.

Each capability should land in a focused pull request with synthetic tests, public repository safety, typecheck, lint, full tests, build validation, and explicit documentation of trust and side effect boundaries.

## v2.1 Agent control plane

This phase adds a generic agent orchestration layer above the deterministic toolkit. The toolkit remains the independent source of engineering checks and policy decisions. Agent output never replaces canonical evidence.

### Current v2.1 progress

* Agent Task v1, Agent Worker v1, and deterministic Agent Route v1 foundation: merged.
* Agent Task Registry v1 using local SQLite, immutable task identity, optimistic state/revision transitions, append-only event history, explicit retries, and caller-supplied timestamps: merged.
* Worker Lease v1 with task-derived read/write mode, repository-level writer exclusivity, bounded TTL, revision/owner checks, explicit expiration, and append-only lease history: merged.
* Agent Role Policy v1 with monotone authority/risk caps, leased-worktree-only write posture, all eight canonical roles, and optional stricter routing composition: merged.
* Local Model Adapter v1 with explicit worker-local loopback backends, bounded file inputs/responses, symbolic model ids, and no implicit fallback or cloud path: merged.
* Worker Observer v1 and local Worker Registry v1 with local resource observation, symbolic model cross-checks, schema v3 heartbeat history, SHA256 integrity, explicit freshness discovery, and no built-in transport: merged.
* Diagnosis Agent v1 with exact task/repository binding, explicit evidence input, evidence-id-cited hypotheses, read-only verification proposal classes, and no root-cause/execution authority: merged.
* Reproduction Agent v1 with linked-worktree identity checks, active WRITE lease enforcement, one-new-test-only mutation, skip/bypass guards, and separate hash-bound run evidence: merged.
* Independent Review Agent v1 with hash-bound untrusted proposals, separate evidence citations, deterministic descriptive disposition, counterexample/regression-gap output, and no approval/merge authority: merged.
* Agent Evaluation Corpus v1 with fixed synthetic diagnose/reproduce/review cases, explicit evidence and scope expectations, deterministic per-criterion PASS/FAIL, and no artificial model score: merged.
* v2.1 Agent control plane implementation is complete and merged.
* Repair Agent v1 with proposal-first output, exact context hashes, linked-worktree checks, private path/check policy, and LOW-risk leased worktree apply only when explicitly enabled: merged.
* Documentation Agent v1 with document-only proposal scope, hard human-review protection for AGENTS/governance/policy/security/.github paths, proposal-first behavior, and LOW-risk leased worktree apply for ordinary docs: merged.
* Cross Repository Contract Impact Agent v1 with canonical contract-audit composition, explicit provider-consumer edges, evidence/path binding, deterministic mismatch/drift/missing kinds, and no canonical-version inference: merged.
* Dependency Maintenance Agent v1 with deterministic exact-version classification, full change/evidence coverage, read-only model analysis, and no package-manager or update execution authority: merged.
* Bounded MCP Server v1 with official MCP v2 stdio transport, a fixed read-only toolkit operation allowlist, strict Zod inputs, bounded payloads, and no generic shell/filesystem/network passthrough: merged.
* Task Worktree Sandbox v1 with Bubblewrap filesystem/network containment, exact policy-command allowlists, prlimit resource bounds, write-lease enforcement, hashed output evidence, and metadata-bound deterministic cleanup: merged.
* Signed Evidence Verification v1 with Ed25519 exact-byte authentication, signer/key/domain/kind policy binding, explicit freshness, and cryptographic Release Evidence Bundle trust integration: merged.
* Agent Research Bundle v1 with exact task/commit binding, explicit tool versions, caller-sanitized structurally checked JSON evidence, declarative non-executed commands, canonical reproduction metadata, SHA256 file bindings, and deterministic verification: merged.
* Repository Impact Graph v1 with exact repository commit declarations, API/contract/canonical-module/test/route/consumer nodes, source-and-commit-bound explicit edges, and deterministic dependency/blast-radius queries: merged.
* Operator Task Dashboard v1 with read-only Task Registry/Worker Lease projection, derived leased/review-required states, expired-lease visibility, consistency findings, and no second persisted truth model: merged.
* v2.2 Safe coding automation is complete and merged.
* Incident Analysis Agent v1 with exact release/runtime binding, sanitized bounded errors and metrics, evidence-cited hypotheses, read-only verification proposals, and no operational recovery authority: merged.
* OpenTelemetry Evidence v1 with offline bounded OTLP JSON traces/metrics/logs, Runtime Evidence identity binding, explicit signal limits, and privacy-preserving projection that drops raw bodies and arbitrary attributes: merged.
* Incident Correlation Evidence v1 with deterministic release-window, exact dependency-commit, explicit contract-edge, and prior-failure signature correlations with source references and no causality claim: merged.
* Agent Resource & Model Quality Telemetry v1 with exact run timing, symbolic worker/model identity, CPU/GPU time, token usage, proposal outcomes, review effort, reopened defects, optional corpus status, and deterministic grouping without an artificial quality score: merged.
* Model Routing Evaluation v1 with exact-model evidence qualification, conservative small-first recommendation, explicit measured-quality escalation, freshness handling, and no automatic route-policy mutation: merged.
* Playwright Planner/Generator Integration v1 with exact worktree/version binding, planner-generator-only authorization, bounded plan validation, AST test auditing, and hard rejection of skip/fixme/only/fail constructs: merged.
* fast-check Property Based Testing v1 with deterministic seed/replay policy, explicit validator/policy/state/numeric/custom adapters, no JSON code loading, and no inferred business properties: merged.
* StrykerJS Mutation Testing v1 with pinned Stryker 10.0.0, exact source-file mutation scope, bounded test-only command policy, deterministic mutation-score evidence, privacy-preserving report adaptation, and real integration smoke coverage: implementation complete on the active capability branch.
* Remaining v2.4+ phases remain open.

71. Add Agent Task Contract v1 with explicit repository commit, role, risk, scope, required checks, and bounded authority.
72. Add Agent Worker Contract v1 with explicit heartbeat time, resources, model inventory, capabilities, load, and read/write capacity.
73. Add deterministic Agent Route v1 selection using explicit evaluation time, heartbeat freshness, task authority, role policy, worker capability, and model class preference.
74. Add a persistent SQLite task registry with task state transitions, append-only events, retries, and resumable task identity.
75. Add worker leases so only one writing agent owns a repository/worktree scope at a time and concurrent sessions cannot silently duplicate the same task.
76. Add versioned role policies for diagnose, reproduce, review, repair, docs, contract, dependency, and incident agents.
77. Add a local-model adapter with explicit provider endpoints and no implicit cloud fallback.
78. Add persistent-worker discovery and optional compute-worker registration without treating stale heartbeats as online truth.
79. Add a diagnosis agent that produces evidence-backed hypotheses and proposed verification steps without modifying source.
80. Add a reproduction agent that creates isolated failing regression tests without weakening or skipping existing checks.
81. Add an independent review agent that searches for counterexamples and regression gaps without inheriting another agent's conclusion as truth.
82. Add an agent evaluation corpus with known defects, expected evidence, scope boundaries, and measurable pass/fail outcomes.

## v2.2 Safe coding automation

83. Add a repair agent restricted to isolated worktrees, explicit allowed paths, required checks, and proposal-only output until policy authorizes low-risk writes.
84. Add a documentation agent for command, path, release-note, and architecture-reference drift; AGENTS and policy changes remain separately reviewed.
85. Add a cross-repository contract-impact agent that maps explicit consumers/providers and proposes coordinated compatibility work without inventing canonical business rules.
86. Add a dependency-maintenance agent that explains and validates mechanical update PRs while package updates remain delegated to deterministic tooling.
87. Add a bounded MCP server exposing typed toolkit operations instead of a general unrestricted shell.
88. Add task-scoped worktree sandboxes with filesystem containment, resource limits, and deterministic cleanup.
89. Add signed evidence verification so authentication is established cryptographically instead of trusting boolean metadata alone.
90. Add reusable research bundles containing exact commit, tool versions, sanitized evidence, commands, and reproduction metadata.
91. Add a traceable repository impact graph for APIs, contracts, canonical modules, tests, routes, and consumers with source/commit provenance for every edge.
92. Add an operator task dashboard for queued, leased, running, blocked, review-required, completed, and superseded work without creating a second audit truth model.

## v2.3 Runtime and ecosystem intelligence

93. Add an incident-analysis agent over explicitly supplied sanitized runtime evidence, release identity, errors, and health metrics; no restart, rollback, or provider mutation authority.
94. Add an OpenTelemetry evidence adapter for bounded traces, metrics, and logs while preserving runtime evidence identity and privacy boundaries.
95. Add automated correlation between incidents, releases, dependency changes, contract changes, and prior known failures as hypotheses with source references.
96. Add resource and model-quality telemetry for agent latency, accepted proposals, rejected proposals, reopened defects, review effort, CPU/GPU time, and token usage.
97. Add model-routing evaluation so small local models handle classification/summarization and stronger workers are used only when measured quality requires them.

## v2.4 Verification and maintenance integrations

98. Add Playwright planner/generator integration for isolated browser regression planning; generated tests cannot silently skip broken functionality.
99. Add fast-check property-based testing adapters for validators, policies, state transitions, numeric invariants, and other explicit properties.
100. Add StrykerJS mutation-testing integration to measure whether important tests actually detect code changes.
101. Add Testcontainers integration for disposable database/service integration environments with synthetic data only.
102. Add Pact consumer/provider contract testing as an executable complement to static API and cross-repository contract audits.
103. Add Renovate integration for deterministic dependency-update PR creation with agent explanation and policy-driven review.
104. Add Semgrep evidence adapters as an optional static-analysis source without replacing toolkit-native checks.
105. Add Promptfoo evaluation suites for comparing local models, prompts, agent roles, and tool policies against the fixed agent evaluation corpus.
106. Add Cosign/Sigstore verification adapters for signed release and agent evidence, binding trusted issuers/identities through explicit private policy.

### Agent product boundary

* The deterministic toolkit remains authoritative for checks, contracts, evidence validation, and deployment-gate decisions.
* Agents may investigate, reproduce, review, and propose. Write authority is separately scoped and never implies merge, deployment, payment, booking, migration, or production authority.
* Missing or stale evidence cannot be repaired by model confidence.
* Agents cannot weaken tests, policy, safety checks, or canonical business constraints merely to obtain a passing result.
* Public code remains provider-neutral; hostnames, credentials, private repositories, organization policy, and model endpoints stay in private deployment configuration.
* Always-on control-plane operation and optional compute workers are separate from repository truth. Worker availability is explicit heartbeat evidence, not an assumption.
