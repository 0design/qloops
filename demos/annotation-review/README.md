# Annotation review queue

Value: preserve the link between website feedback and the next action, without pretending that an unverified change is resolved.

Run from the repository root:

```sh
node demos/annotation-review/run.mjs
```

The synthetic input follows the shape illustrated in https://www.agentation.com/mcp. The first annotation becomes an inspection task; the ambiguous placement asks for clarification. Both remain pending and have no fabricated evidence.

This is an executable offline demonstration of queue normalization, not a Registry template execution, live Agentation integration, CLI inference test, or website acceptance. The target `annotation-fix` contract is in `registry/composition.json`; its missing components block acceptance.

The live path must read a real session, preserve IDs, clarify, apply the change, verify the affected browser scenario, and only then resolve through MCP with evidence. Errors and cancellation must leave unfinished annotations unresolved.

This demo is first-party code. Agentation is an external dependency; it is not bundled or relicensed here.
