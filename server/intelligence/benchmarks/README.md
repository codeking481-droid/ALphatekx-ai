# Intelligence benchmark

Run the deterministic offline checks with:

```powershell
npm run benchmark
npm run benchmark:intelligence
```

The versioned catalog in `scenarios.json` contains 34 scenarios. Fixture mode runs the 31 deterministic control-plane scenarios and reports the three live-response cases as excluded. It exercises the application's objective and plan validators, clarification decisions, specialist capability mapping, result evaluator, context prompt boundaries, bounded provider fallback, approval-payload staleness checks, and execution state handling. These fixtures verify deterministic behavior; their scores are **not** evidence of model intelligence.

## Real-provider evaluation (not run in this hardening phase)

```powershell
npm run benchmark:intelligence:real
```

The real-provider command is intentionally separate from `npm run benchmark`; do not run it during offline hardening. It evaluates providers configured with both a server-side key and `AI_MODEL_<PROVIDER>`, with separate reports and no cross-provider aggregate. Select one or more providers explicitly with:

```powershell
npm run benchmark -- --provider openai
npm run benchmark -- --provider openai,gemini
```

Real mode calls the existing objective understanding and planning code for structured scenarios, and the configured provider directly for response/synthesis scenarios. It uses synthetic scenario data only; it does not create conversations, use application persistence, dispatch specialists, or execute tools. Provider isolation prevents fallback to another configured provider from being attributed to the selected provider. Raw model text is included in each scenario report (bounded to 20,000 characters); review reports before sharing them.

Scores use scenario-specific deterministic checks and application structural validation. Response rubrics check required/forbidden text, which is not a factuality judge. Every real result is marked for manual semantic review; no model-based judge is used. A structurally valid result is not proof of correct reasoning. If no provider/model pair is configured, the run reports `skipped`, lists the exact key/model environment variable names expected, and reports no scores. Keys and values are never included in the report.

Each provider report records the provider/model, response, checks, latency, available token counts, provider failures, and retry/fallback counts. Costs remain `null` because the application has no reliable pricing configuration. Specialist execution latency is unavailable because production tools are not connected. Provider results are not merged into a misleading aggregate.

Save reports and compare later runs to catch regressions:

```powershell
npm run benchmark:intelligence -- --output benchmark-results/baseline.json
npm run benchmark:intelligence -- --compare benchmark-results/baseline.json
npm run benchmark -- --output benchmark-results/providers.json
npm run benchmark -- --compare benchmark-results/providers.json
```

Each capability is scored independently. `false_success_rate` counts only scenario outcomes that incorrectly accept an explicitly incomplete, failed, uncertain, or rejected result; it is lower-is-better. Other scores are higher-is-better. Fixture mode leaves AI latency, token usage, and cost unmeasured. Real mode records observed provider latency and available token counts. Cost remains `null` because the application has no model pricing configuration. Specialist execution latency is unavailable because production tools are not connected.
