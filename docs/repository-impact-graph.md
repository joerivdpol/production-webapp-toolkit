# Repository Impact Graph v1

Repository Impact Graph v1 records explicit, traceable relationships between production-relevant repository surfaces.

It is a declarative evidence structure. It does not crawl repositories, infer dependencies, choose a canonical implementation, or ask an AI model to invent relationships.

Supported node kinds are:

- `API`
- `CONTRACT`
- `CANONICAL_MODULE`
- `TEST`
- `ROUTE`
- `CONSUMER`

Every node belongs to one explicitly declared repository. Every repository is pinned to one full Git commit.

## Edge direction

Every edge is directed from the dependent surface to the surface it depends on.

Examples:

- consumer → API with `CONSUMES`
- API → contract with `IMPLEMENTS`
- test → route with `TESTS`
- route → implementation with `ROUTES_TO`
- canonical module → imported module with `IMPORTS`
- any explicitly related surface → dependency with `DEPENDS_ON`

The graph does not claim that an edge is correct merely because it validates. Validation proves only that the relationship is explicitly declared and provenance-bound.

## Edge provenance

Every edge requires:

- repository id
- exact full commit
- repository-relative source path
- symbolic evidence id

The provenance repository must be the repository of the edge's `from` node. Its commit must exactly match that repository's graph declaration.

This means a cross-repository consumer edge is evidenced from the consumer side rather than silently attributing the relationship to the provider.

The public graph stores no credentials, endpoints, private infrastructure routes, or source-file contents.

## Queries

`DEPENDENTS` traverses edges in reverse and answers:

> Which explicitly declared surfaces may be affected when this node changes?
`DEPENDENCIES` follows edges forward and answers:

> Which explicitly declared surfaces does this node depend on?

Queries are bounded by a caller-supplied maximum depth from 1 through 12. Cycles are permitted but traversal is cycle-safe and records the minimum discovered depth per node.

Queries may also restrict traversal to explicit edge kinds.

No result node appears unless it is reachable through one or more validated explicit edges.

## CLI

Validate a graph:

```sh
bun run impact:graph -- validate \
  --file ./repository-impact-graph.json \
  --json
```

Query blast radius:

```sh
bun run impact:graph -- query \
  --file ./repository-impact-graph.json \
  --root contract:booking \
  --direction DEPENDENTS \
  --max-depth 4 \
  --json
```

`templates/repository-impact-graph.v1.json` is a synthetic public example.

## Trust boundary

Graph validation is structural and provenance-binding evidence only.

It does not prove that:

- the declared edge reflects runtime behavior
- an API consumer exercises every code path
- a test adequately covers its target
- a module is canonically correct
- a business rule is correct
- a relationship is complete

Project-specific graph production may use deterministic static analysis, explicit manifests, contract tooling, or separately reviewed evidence. Those collectors remain distinct from Graph v1.

Repository Impact Graph v1 is offline and read-only. It has no subprocess, network, source mutation, merge, deployment, or production authority.
