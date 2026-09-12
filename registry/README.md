# QFactory Registry

Registry has three content types: loop templates, components, and demos. Content type does not imply implementation or acceptance.

- `loops/`: existing executable YAML reference templates. Their catalog status is `reference-only`; they are not the requested CLI acceptance scenarios.
- `components/`: versioned building-block contracts. Registry names distinguish `llm-call/cli` and `llm-call/openrouter`; file IDs use hyphens. The existing YAML runtime kind `llm-call` maps to OpenRouter only.
- `demos/`: scenario descriptions and historical sample outputs. Historical output is not accepted user evidence. The previous Registry `examples/` directory has been consolidated here.
- `composition.json`: the machine-readable target composition for SDD, content-feed, digest, aindf-check and Unslop. These are contract-only templates until their declared components and route bindings are implemented and accepted. determined is a reusable loop-component.

Root `examples/` belongs to the npm Core API package, not the Registry catalog. It contains caller requests and integration samples needed to use the API; it is not a second product-demo category.

## Component-first acceptance

Each template resolves exact component IDs and versions. `node scripts/registry-readiness.mjs <template-id>` reports missing implementation and acceptance. A template cannot start acceptance while a required component is partial, planned, missing or unaccepted. A direct SDD/Content API call or alternate inference provider must not stand in for an absent Registry component.

Evidence must bind the component version. `components-ready` means prerequisites are ready; it does not mean the template or demo has passed. The currently declared target templates remain blocked.

Edit the asset and `catalog.source.json`, then run `node scripts/build-registry.mjs`. The builder validates dependency resolution and cycles, computes prerequisite readiness, and exports a versioned catalog and checksums. Core runtime and Registry share this repository but publish independently; the npm package excludes Registry.

Export with `node scripts/build-registry.mjs --export /absolute/output`. Website consumers pin the exact catalog digest and verify each artifact and Core pin. Retain attribution and licensing; MIT applies only to reviewed Registry material, not unrelated design, fonts or third-party skills.

## Built-in components

HTTP methods and control-flow operators are components, but are not public Registry listings. `composition.builtins` records their versioned capabilities and readiness. Dependency resolution includes this inventory. Existing runtime IDs remain explicit; planned `if`, `switch`, `loop` and `each` are not represented as implemented aliases.

Agentation is a planned discoverable integration. The first-party executable example in `../demos/annotation-review` demonstrates an offline review queue only. Live MCP, CLI execution and browser verification remain required before accepting `annotation-fix`.
