# Property Based Testing v1

Property Based Testing v1 integrates fast-check as deterministic test-time tooling.

The toolkit does not generate business properties. A repository author must write the property explicitly in code and choose the arbitrary values that may exercise it.

The adapter has five descriptive categories:

- VALIDATOR
- POLICY
- STATE_TRANSITION
- NUMERIC_INVARIANT
- CUSTOM

All categories use the same runner and result contract.
## Deterministic policy

The versioned policy controls only execution of the generated property cases:

- seed
- number of runs
- maximum skips per run
- optional fast-check replay path

No wall-clock timeout is part of the policy. This keeps a run reproducible from its seed and shrink path rather than making outcomes depend on machine speed.

See `templates/property-test-policy.v1.json`.

A failing result contains the seed and counterexample path required for replay. The adapter intentionally does not store the raw counterexample or raw thrown error.
## Explicit properties

Import the helpers from `scripts/property-based-testing.js`.

```js
import {
  fastCheck as fc,
  runValidatorProperty,
} from "./scripts/property-based-testing.js";

const result = runValidatorProperty(policy, {
  id: "example-validator-idempotence",
  arbitraries: [fc.jsonValue()],
  predicate: (value) => {
    const first = validate(value);
    if (!first.valid) return true;
    const second = validate(first.value);
    return second.valid && JSON.stringify(second.value) === JSON.stringify(first.value);
  },
});
```

The predicate may return boolean or use assertions and return undefined.
The toolkit does not load arbitrary JavaScript modules from JSON and it does not execute property definitions received from an agent or remote service.

Property code is ordinary reviewed test code.

## State transitions

State-transition properties should define the accepted state graph explicitly in the test and compare it with the canonical implementation.

This is useful for persistent state machines such as Agent Task Registry transitions. The property does not infer which transitions should exist.

## Numeric invariants

Numeric properties are suitable for explicitly defined limits such as:

- active load must not exceed declared worker capacity
- calculated totals must stay within an explicitly supplied bound
- counters must remain non-negative
- deterministic transformations must preserve a stated numeric relation
Do not use a generated numeric property to invent pricing, booking, payment, inventory, or other product rules. Those rules must come from the application's canonical business truth.

## Result semantics

A PASS means fast-check did not find a counterexample to the explicit predicate in the configured generated cases.

It does not prove the property for all possible values.

A FAIL means fast-check found a counterexample or the predicate threw. The result reports seed and shrink path for deterministic replay while omitting raw generated values and error text.

The adapter itself has no filesystem, subprocess, network, environment-variable, or implicit-clock surface.

## Toolkit integration tests

The toolkit's own property suite exercises:

- Agent Task validator totality and normalized idempotence
- Agent Role Policy normalized idempotence
- Agent Task Registry transition rules
- Agent Worker read/write load capacity invariants
- deterministic failure replay

Run it with:

```sh
bun run test:property
```
