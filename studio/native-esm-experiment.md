# Studio native ESM experiment and verdict

Date: 4 November 2026  
Status: Experimental; recommendation is to retain the current browser registry  
Baseline: `26ab7e7042` on `custom-apps`  
Prototype: `370a5ad78c` on `codex/native-esm-prototype`

## Verdict

Native ESM can execute Studio's database-backed application modules. The experiment preserved internal imports, reused the renderer's Vue instance, mounted Vue components and page scripts, and supported native module linking and top-level `await`.

However, this implementation using Blob URLs and incrementally registered import maps is not a compelling replacement for the current CommonJS registry in the browser editor. It still needs custom resolution, import rewriting and update tracking. It was slower in the synthetic loader benchmark, and evaluated native modules cannot be explicitly unloaded when a source revision is discarded.

**Recommendation: retain CommonJS for browser source execution for now; continue using built ESM assets for published apps; evaluate shared dependencies for Desk islands separately.**

This verdict applies to the implementation tested here. It is not a claim that native ESM, import maps or built ESM applications are generally slower than CommonJS.

## Question and scope

The question was whether Studio could replace its in-memory CommonJS module execution with native ESM while retaining the current authoring experience.

Two decisions need to remain separate:

| Decision                  | Responsibility                                                     |
| ------------------------- | ------------------------------------------------------------------ |
| Application module loader | Links and executes an app's own compiled source modules            |
| Shared dependency layer   | Supplies libraries such as Vue and Frappe UI to multiple consumers |

This experiment replaced the application module loader. Library dependencies continued to come from the renderer's existing instances, exposed through generated ESM bridge modules. It did not implement a framework-wide shared dependency build or measure savings across Desk islands.

The work was isolated in a separate Git worktree. The prototype changes the database source runtime; it does not change the standard app build pipeline or the production publishing model.

## Existing implementation

The baseline browser runtime performs these steps:

1. Fetch application source text from Frappe.
2. Compile Vue SFCs and strip TypeScript using the existing compiler.
3. Discover imports with the Babel parser already available through `vue/compiler-sfc`.
4. Resolve local imports and obtain allowed library namespaces from the renderer.
5. Transform compiled ESM into CommonJS using Sucrase.
6. Execute module factories with `new Function(exports, require, module, ...)` and cache their exports.

The historical regex import-discovery bug was already fixed in the baseline. Replacing CommonJS is a separate decision from using a proper parser.

Published builds take another path: both standard and custom DB apps can produce Vite-built JavaScript and CSS. Those builds exclude the browser compiler and source registry.

## Prototype implementation

The prototype adds `NativeModuleLoader`, integrated through the existing `compiledApp.ts` entry point.

Its loading sequence is:

1. Compile source with the existing Vue SFC and TypeScript compiler, preserving ESM syntax.
2. Parse compiled JavaScript with Babel and record import locations.
3. Resolve relative imports, the `@app/` alias and extension candidates.
4. Assign virtual module URLs and rewrite import specifiers to those URLs.
5. Create Blob URLs containing the compiled ESM modules.
6. Register an import map from virtual module URLs to Blob URLs before importing the entry.
7. Let native `import()` link and execute the graph.

Assigning virtual URLs before execution allows cyclic imports without needing to create Blob URLs recursively through the cycle.

Library bridge modules export the renderer's existing values. Identity tests compare `ref`, `onMounted`, `getCurrentInstance` and Frappe UI's `Button` directly with the renderer's imports. The experiment therefore does not create a second Vue instance.

CSS and JSON retain Studio's existing authoring conventions through generated JavaScript modules. Literal dynamic imports use rewritten module URLs. Computed imports use a runtime resolver that delegates execution to native `import()` and retains the dependency allowlist.

For edits, the loader assigns new URLs to changed modules and their affected importers. Unchanged modules retain their identities. Older module references continue to see their previous graph; consumers must load the new entry and remount to use its replacement. This is not automatic component hot replacement.

## Validation

The complete run passed **36 browser checks**: 21 prototype checks, including the benchmark, and 15 existing runtime, dependency and lifecycle checks.

| Area                | Observed result                                                                 |
| ------------------- | ------------------------------------------------------------------------------- |
| Library identity    | Renderer functions and Frappe UI components retain exact identity               |
| Vue components      | Script setup and Options API components mount successfully                      |
| Page scripts        | Repository-style companion paths resolve imports and execute setup              |
| Lifecycle           | Mounted hooks run in the expected Vue component instance                        |
| Imports             | Relative paths, `@app`, extension probing and re-exports work                   |
| Assets              | JSON defaults, CSS imports and scoped SFC styles work                           |
| Import discovery    | Import-like text in comments, strings and templates is ignored                  |
| Native semantics    | Top-level `await`, live bindings and deferred reads through cycles work         |
| Linking failures    | Missing exports fail before dependency side effects execute                     |
| Cycle failures      | Reading an uninitialized cyclic binding produces a native initialization error  |
| Lazy imports        | Literal and computed dynamic imports defer module execution                     |
| Source changes      | Affected importers reload; unrelated module state survives                      |
| Older references    | Literal and computed lazy imports retain the older graph after an edit          |
| App separation      | Two loader instances can use identical file paths without sharing module caches |
| Diagnostics         | Execution stack traces retain `studio-app:///...` source paths                  |
| Module execution    | A fixture executes while the global `Function` constructor is disabled          |
| Runtime integration | Loading and reloading page scripts works through `compiledApp.ts`               |
| Cleanup             | Evaluated modules remain importable after their Blob URLs are revoked           |

The production frontend build also succeeded. A TypeScript diagnostic check found no errors in the four changed runtime files. Formatting and applicable pre-commit checks passed.

Browser behavior was exercised through Cypress component tests. The integrated source-fetch test supplied fixture data at the resource-fetch boundary. This was not an end-to-end test against a persisted live-site application, and the built production assets were not separately exercised in a production browser session.

The module-cache separation check does not establish complete island isolation. Existing document-level style and application-runtime state still require separate work before multiple Studio apps can safely coexist in Desk.

## Performance results

Environment: Node 24.13.0, Cypress 15.20.1 and Chromium 138 inside Electron 37.6.0 on the local Mac.

The benchmark used graphs containing 25, 100 or 250 small TypeScript dependencies plus one entry module. The entry imported every dependency. Both implementations received the same sources, and compilation results were populated before timing. Each result below is the median of five runs.

### Initial graph preparation and entry execution

| Total modules, including entry | CommonJS registry | Native ESM prototype |
| ------------------------------ | ----------------: | -------------------: |
| 26                             |            1.3 ms |               7.7 ms |
| 101                            |            3.4 ms |              23.1 ms |
| 251                            |            3.8 ms |              50.4 ms |

### Adding and loading a page script

The added page imported the graph's existing entry. This measures adding a module while retaining the existing graph, rather than replacing a widely used dependency.

| Existing graph modules | CommonJS registry | Native ESM prototype |
| ---------------------- | ----------------: | -------------------: |
| 26                     |            0.4 ms |               2.2 ms |
| 101                    |            0.3 ms |               7.1 ms |
| 251                    |            0.2 ms |              15.0 ms |

After caching the native import promises, 100 repeated loads of an already loaded entry took 0.2–0.4 ms across these cases. Those small measurements are not a useful basis for choosing an architecture.

The loader benchmark favored the current registry. It does not isolate which portion of the native result came from Blob loading, import-map registration, import rewriting or browser linking.

### Measurement limits

- These are synthetic loader timings, not application startup or interaction timings.
- They exclude HTTP source downloads, cold compiler startup and application rendering.
- Loader-specific processing remains included: CommonJS transformation for the registry, and parsing, rewriting and native module preparation for the prototype.
- The benchmark uses one browser and small source modules. It does not represent all application sizes or target devices.
- Runs execute sequentially in one document, with CommonJS measured before native ESM for each graph size. Native import mappings and evaluated module identities accumulate across runs. Fresh-document measurements and randomized ordering would be needed for a stronger performance comparison.
- No cross-app dependency-cache savings, production bundle-size changes or long-session heap growth were measured.

The results support retaining the current implementation over this prototype. They do not establish an inherent performance disadvantage for native ESM or import maps.

## Architectural findings

### Native execution works without giving up internal imports

Database storage, relative imports and `@app` do not prevent native ESM. They require a way to turn source identities into module URLs. The prototype supplies that mapping.

Readable source paths also survive through `sourceURL` annotations in the tested browser. Blob UUIDs are therefore not an unavoidable limitation for execution stack traces.

### Native linking removes some custom semantic checks

The browser validates named exports and controls native module initialization and top-level `await`. These are useful correctness benefits, especially for missing exports from local modules.

The native live-binding test passed. This should not be read as evidence that the existing Sucrase-based implementation loses every live binding; CommonJS transformation can preserve some imported-binding behavior.

### Mutable source still requires a loader

The prototype retains path resolution, AST traversal, import rewriting, CSS and JSON adaptation, dependency bridges, revision tracking and importer invalidation. Computed imports also require resolution code.

Some CommonJS-specific code disappears, but the overall implementation does not become substantially simpler. Importer invalidation is explicitly implemented in the prototype; native ESM does not update an already imported graph automatically.

### Module lifetime is a material editor concern

A native module is cached by its resolved identity. Executing a changed revision requires a new identity. Revoking its Blob URL releases that URL resource but does not unload an evaluated module.

The cleanup test confirmed that an already evaluated module could still be imported after disposal and Blob revocation. Registered import mappings also remain part of the document after their script element is removed.

This creates a lifetime problem for an editor that continually generates revisions in one document. A disposable preview iframe is one possible way to bound that lifetime. This experiment did not implement such a preview architecture or quantify retained heap size.

### Browser and CSP compatibility remain open

The implementation incrementally registers multiple import maps. It needs verification against Studio's supported Safari and Firefox versions as well as Chromium.

The module execution test avoids the `Function` constructor. It does not prove that the whole Studio application can run without eval-related CSP allowances: expression and event execution elsewhere still uses `new Function`. Blob loading and dynamically inserted import maps also need verification under the intended CSP.

## Implications for standard apps and Desk islands

Standard and custom DB apps can both continue producing optimized standalone builds. Source ownership and storage do not need to determine dependency-sharing policy.

For Desk, a shared ESM dependency layer could let participating islands use one copy of Vue and Frappe UI. That remains compatible with either native ESM application modules or the current CommonJS registry receiving those library namespaces.

The existing registry already reuses the renderer's library instances. Import maps would extend sharing across participating bundles; they are not required to achieve sharing within one renderer.

A standalone app can retain bundled dependencies. An independent island can retain its own dependencies when it mounts a separate Vue application. Components intended to participate in the same Vue application must use compatible shared dependency instances and context.

This experiment provides no basis for requiring all standard apps to consume a shared runtime. That decision needs production bundle and loading measurements, including the effect of losing per-app tree shaking when a large library is externalized as one shared asset.

## Recommendation

1. **Retain the current CommonJS registry for browser editing and in-memory source execution.** The tested replacement adds startup overhead and a module-lifetime problem without a clear reduction in implementation complexity.
2. **Continue using compiled ESM assets for published applications.** The experiment does not challenge the existing production build path.
3. **Evaluate shared dependencies for Desk islands independently.** Measure several consumers in one document and compare standalone cold-load performance before choosing a default.
4. **Revisit native source execution if its semantic benefits become a concrete requirement.** A follow-up should compare compiled HTTP module URLs or a disposable preview environment against this Blob approach, rather than assuming every native ESM design has the same costs.

Before adopting a native replacement, require tests across supported browsers, explicit module-lifetime management, production CSP checks, realistic cold and warm startup measurements, and a demonstrated simplification or product capability that justifies the change.

## Reproduction and implementation references

The prototype is available locally on `codex/native-esm-prototype` at commit `370a5ad78c`. The worktree used for the experiment is `apps/frappe-native-esm` under the bench.

| File, relative to `studio/`                                                                              | Purpose                                                                |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [frontend/src/runtime/nativeModuleLoader.ts](frontend/src/runtime/nativeModuleLoader.ts)                 | Native loader, URL publication, dependency bridges and update tracking |
| [frontend/src/runtime/compiledApp.ts](frontend/src/runtime/compiledApp.ts)                               | Integration with application sources and page scripts                  |
| [frontend/src/runtime/compiler.ts](frontend/src/runtime/compiler.ts)                                     | Existing compilation and exposed Babel program parser                  |
| [frontend/src/runtime/moduleRegistry.ts](frontend/src/runtime/moduleRegistry.ts)                         | CommonJS baseline and reused error/style helpers                       |
| [frontend/cypress/component/native-esm.cy.ts](frontend/cypress/component/native-esm.cy.ts)               | Prototype behavior checks and benchmark                                |
| [frontend/cypress/results/native-esm-benchmark.json](frontend/cypress/results/native-esm-benchmark.json) | Recorded benchmark values and browser metadata                         |

With dependencies available and a compatible Node version, run the checks from the prototype's `studio/frontend` directory:

```sh
env -u ELECTRON_RUN_AS_NODE node node_modules/cypress/bin/cypress run \
  --component \
  --spec cypress/component/native-esm.cy.ts,cypress/component/app-runtime.cy.ts,cypress/component/importable-modules.cy.ts,cypress/component/page-script-host.cy.ts \
  --config video=false,screenshotOnRunFailure=false
```

This command reruns the benchmark and rewrites its JSON results. Timings will vary by machine and browser load.

The production build was checked with output redirected outside the application's normal asset directory:

```sh
node --input-type=module -e '
import { build } from "vite";
await build({
  configFile: "vite.config.js",
  build: { outDir: "/tmp/studio-native-esm-build", emptyOutDir: true },
  logLevel: "warn"
});
'
```

## Platform references

- [MDN: import maps and merging multiple maps](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap#merging_multiple_import_maps) explains registration, compatibility differences and why existing mappings cannot simply be replaced.
- [MDN: dynamic imports and module caching](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import#module_namespace_object) explains module identity and the absence of an API to clear evaluated module namespaces.
