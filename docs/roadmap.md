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
* Database Schema Snapshot v1, schema drift comparator, and read-only PostgreSQL observed catalog collector: implementation complete; merge pending.
* PostgreSQL/Supabase security policy checks and the remaining production-readiness capabilities remain open.

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

56. Introduce a versioned repository manifest so projects can declare profile, runtime, database, capabilities, and required checks.
57. Introduce policy packs such as webapp, Python service, database backed webapp, payment service, booking service, worker, and bot.
58. Support private organization policy inheritance layered above the public generic engine.
59. Add cross repository ecosystem dashboards and machine readable summaries.
60. Add historical comparison between current and previous status reports without changing audit truth.
61. Add scheduled reporting and notifications only after report semantics are stable.
62. Add configurable severity and required versus advisory policy without allowing silent policy weakening.

## v2.0 Controlled automation

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