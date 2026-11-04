import { defineComponent, getCurrentInstance, h, onMounted, ref } from "vue"
import { Button, getConfig, setConfig } from "frappe-ui"
import { NativeModuleLoader } from "@/runtime/nativeModuleLoader"
import { AppModuleRegistry, clearAppStyles } from "@/runtime/moduleRegistry"
import { compileFile } from "@/runtime/compiler"
import {
	loadAppRuntime,
	loadAppPageScriptModule,
	reloadAppRuntime,
	unloadAppRuntime,
} from "@/runtime/compiledApp"

const loaders: NativeModuleLoader[] = []

function createLoader(files: Record<string, string>): NativeModuleLoader {
	const loader = new NativeModuleLoader(files)
	loaders.push(loader)
	return loader
}

describe("native ESM prototype", () => {
	afterEach(() => {
		for (const loader of loaders.splice(0)) loader.dispose()
		clearAppStyles()
	})

	it("keeps renderer function and component identity", () => {
		const loader = createLoader({
			"identity.ts": `export { ref, onMounted, getCurrentInstance } from "vue"; export { Button } from "frappe-ui"`,
		})
		cy.wrap(loader.loadModule("identity.ts")).then((module: any) => {
			expect(module.ref).to.equal(ref)
			expect(module.onMounted).to.equal(onMounted)
			expect(module.getCurrentInstance).to.equal(getCurrentInstance)
			expect(module.Button).to.equal(Button)
		})
	})

	it("mounts an SFC with lifecycle hooks, extension probing, scoped CSS, JSON and @app imports", () => {
		const loader = createLoader({
			"utils/index.ts": `export const label: string = "native"`,
			"theme.json": `{"color":"rgb(12, 34, 56)"}`,
			"theme.css": `.native-card { font-weight: 700 }`,
			"Card.vue": `<script setup lang="ts">
import { ref, onMounted } from "vue"
import { label } from "@app/utils"
import theme from "./theme.json"
import "./theme.css"
const value = ref("pending")
onMounted(() => value.value = label + " mounted")
</script><template><div class="native-card" :style="{ color: theme.color }">{{ value }}</div></template>
<style scoped>.native-card { text-decoration: underline }</style>`,
		})
		cy.wrap(loader.loadModule("Card.vue")).then((module: any) => {
			cy.mount(module.default)
				.get(".native-card")
				.should("have.text", "native mounted")
				.should("have.css", "color", "rgb(12, 34, 56)")
				.should("have.css", "font-weight", "700")
				.should("have.css", "text-decoration-line", "underline")
		})
	})

	it("mounts an options API component and a page setup module", () => {
		const loader = createLoader({
			"Card.vue": `<template><b>{{ label }}</b></template><script>export default { data() { return { label: "options" } } }</script>`,
			"utils.ts": `export const label = "page"`,
		})
		cy.wrap(loader.loadModule("Card.vue")).then((module: any) =>
			cy.mount(module.default).get("b").should("have.text", "options"),
		)
		cy.wrap(
			loader.addFile(
				"studio_page/board/board.ts",
				`
import { ref, onMounted } from "vue"
import { label } from "../../utils"
export default function setup() { const value = ref(label); onMounted(() => value.value += " mounted"); return { value } }
`,
			),
		)
			.then(() => loader.loadModule("studio_page/board/board.ts"))
			.then((module: any) => {
				cy.mount(
					defineComponent({
						setup() {
							const { value } = module.default()
							return () => h("b", value.value)
						},
					}),
				)
					.get("b")
					.should("have.text", "page mounted")
			})
	})

	it("ignores import-shaped comments, strings and templates", () => {
		const loader = createLoader({
			"main.ts": `// import "./missing"
export const text = 'import "./also-missing"'
export const template = \`import "./missing-again"\`
export const value = 7`,
		})
		cy.wrap(loader.loadModule("main.ts")).its("value").should("equal", 7)
	})

	it("preserves live bindings through re-exports and executes once", () => {
		const loader = createLoader({
			"counter.ts": `export let count = 0; export function increment() { count++ }`,
			"barrel.ts": `export { count, increment } from "./counter"`,
			"reader.ts": `import { count } from "./barrel"; export const read = () => count`,
		})
		cy.wrap(
			(async () => {
				const reader = await loader.loadModule("reader.ts")
				const counter = await loader.loadModule("counter.ts")
				expect(reader.read()).to.equal(0)
				counter.increment()
				expect(reader.read()).to.equal(1)
				expect(await loader.loadModule("counter.ts")).to.equal(counter)
			})(),
		)
	})

	it("runs top-level await through native dependency ordering", () => {
		const loader = createLoader({
			"async.ts": `export const value = await Promise.resolve(42)`,
			"main.ts": `import { value } from "./async"; export const answer = value + 1`,
		})
		cy.wrap(loader.loadModule("main.ts")).its("answer").should("equal", 43)
	})

	it("supports cycles with deferred reads and rejects early reads with native TDZ errors", () => {
		const loader = createLoader({
			"a.ts": `import { b } from "./b"; export const a = "a"; export const readB = () => b`,
			"b.ts": `import { a } from "./a"; export const b = "b"; export const readA = () => a`,
		})
		cy.wrap(loader.loadModule("a.ts")).then((module: any) => expect(module.readB()).to.equal("b"))
		const early = createLoader({
			"a.ts": `import { b } from "./b"; export const a = "a"; export const value = b`,
			"b.ts": `import { a } from "./a"; export const b = a`,
		})
		cy.wrap(
			early.loadModule("a.ts").then(
				() => {
					throw new Error("expected TDZ failure")
				},
				(error) => {
					expect(error.name).to.equal("ReferenceError")
					expect(error.message).to.include("initialization")
				},
			),
		)
	})

	it("lets the browser reject missing named exports before module side effects", () => {
		const key = `native-link-${crypto.randomUUID()}`
		const loader = createLoader({
			"dependency.ts": `globalThis[${JSON.stringify(key)}] = true; export const valid = 1`,
			"main.ts": `import { missing } from "./dependency"; export const result = missing`,
		})
		cy.wrap(
			loader.loadModule("main.ts").then(
				() => {
					throw new Error("expected linking failure")
				},
				(error) => {
					expect(error.name).to.equal("SyntaxError")
					expect(error.message).to.include("missing")
					expect((globalThis as any)[key]).to.equal(undefined)
				},
			),
		)
	})

	it("validates missing exports from renderer libraries with the native linker", () => {
		const loader = createLoader({
			"main.ts": `import { doesNotExist } from "vue"; export const value = doesNotExist`,
		})
		cy.wrap(
			loader.loadModule("main.ts").then(
				() => {
					throw new Error("expected linking failure")
				},
				(error) => {
					expect(error.name).to.equal("SyntaxError")
					expect(error.message).to.include("doesNotExist")
				},
			),
		)
	})

	it("keeps literal and computed dynamic imports lazy", () => {
		const key = `native-lazy-${crypto.randomUUID()}`
		const loader = createLoader({
			"main.ts": `export const literal = () => import("./lazy"); export const computed = (name: string) => import("./" + name)`,
			"lazy.ts": `globalThis[${JSON.stringify(key)}] = true; export const answer = 42`,
		})
		cy.wrap(
			(async () => {
				const module = await loader.loadModule("main.ts")
				expect((globalThis as any)[key]).to.equal(undefined)
				const lazy = await module.literal()
				expect(lazy.answer).to.equal(42)
				expect((globalThis as any)[key]).to.equal(true)
				expect(await module.computed("lazy")).to.equal(lazy)
				delete (globalThis as any)[key]
			})(),
		)
	})

	it("supports computed imports of allowed libraries and rejects other dependencies", () => {
		const loader = createLoader({ "main.ts": `export const load = (name: string) => import(name)` })
		cy.wrap(
			(async () => {
				const module = await loader.loadModule("main.ts")
				expect((await module.load("vue")).ref).to.equal(ref)
				try {
					await module.load("not-allowed")
					throw new Error("expected dependency error")
				} catch (error: any) {
					expect(error.message).to.include("not importable")
				}
			})(),
		)
	})

	it("retains unchanged module state when adding page scripts", () => {
		const loader = createLoader({ "shared.ts": `export const state = { count: 0 }` })
		cy.wrap(
			(async () => {
				const shared = await loader.loadModule("shared.ts")
				shared.state.count = 12
				await loader.addFile(
					"page.ts",
					`import { state } from "./shared"; export const read = () => state.count`,
				)
				expect((await loader.loadModule("page.ts")).read()).to.equal(12)
				expect(await loader.loadModule("shared.ts")).to.equal(shared)
			})(),
		)
	})

	it("invalidates transitive importers after edits without rerunning unrelated modules", () => {
		const loader = createLoader({
			"value.ts": `export const value = 1`,
			"middle.ts": `export { value } from "./value"`,
			"main.ts": `import { value } from "./middle"; export const read = () => value`,
			"untouched.ts": `export const state = {}`,
		})
		cy.wrap(
			(async () => {
				const old = await loader.loadModule("main.ts")
				const untouched = await loader.loadModule("untouched.ts")
				await loader.addFile("value.ts", `export const value = 2`)
				expect((await loader.loadModule("main.ts")).read()).to.equal(2)
				expect(old.read()).to.equal(1)
				expect(await loader.loadModule("untouched.ts")).to.equal(untouched)
			})(),
		)
	})

	it("isolates module caches between two apps using identical paths", () => {
		const first = createLoader({ "main.ts": `export const value = "first"` })
		const second = createLoader({ "main.ts": `export const value = "second"` })
		cy.wrap(Promise.all([first.loadModule("main.ts"), second.loadModule("main.ts")])).then(([a, b]: any) => {
			expect(a.value).to.equal("first")
			expect(b.value).to.equal("second")
		})
	})

	it("keeps old lazy imports on their original graph after an edit", () => {
		const loader = createLoader({
			"main.ts": `export const literal = () => import("./value"); export const computed = (name: string) => import("./" + name)`,
			"value.ts": `export const value = 1`,
		})
		cy.wrap(
			(async () => {
				const old = await loader.loadModule("main.ts")
				await loader.addFile("value.ts", `export const value = 2`)
				const current = await loader.loadModule("main.ts")
				expect((await current.literal()).value).to.equal(2)
				expect((await current.computed("value")).value).to.equal(2)
				expect((await old.literal()).value).to.equal(1)
				expect((await old.computed("value")).value).to.equal(1)
			})(),
		)
	})

	it("demonstrates that revoking blobs does not unload evaluated native modules", () => {
		const loader = createLoader({ "main.ts": `export const value = {}` })
		cy.wrap(
			(async () => {
				const module = await loader.loadModule("main.ts")
				const url = (loader as any).urls.get("main.ts")
				loader.dispose()
				expect(await import(/* @vite-ignore */ url)).to.equal(module)
			})(),
		)
	})

	it("executes modules without calling the Function constructor", () => {
		const loader = createLoader({ "main.ts": `export const value = await Promise.resolve(42)` })
		cy.wrap(
			(async () => {
				await compileFile("main.ts", `export const value = await Promise.resolve(42)`)
				const OriginalFunction = globalThis.Function
				globalThis.Function = (() => {
					throw new Error("Function constructor disabled")
				}) as any
				try {
					expect((await loader.loadModule("main.ts")).value).to.equal(42)
				} finally {
					globalThis.Function = OriginalFunction
				}
			})(),
		)
	})

	it("loads and reloads page scripts through the integrated app runtime", () => {
		cy.wrap(
			(async () => {
				const previous = getConfig("resourceFetcher")
				let label = "first"
				setConfig("resourceFetcher", async (options: any) => {
					expect(options.url).to.equal("frappe.studio.api.get_app_files")
					return [{ path: "utils.ts", content: `export const label = ${JSON.stringify(label)}`, hash: label }]
				})
				try {
					await loadAppRuntime("native-prototype")
					const page = {
						page_title: "Board",
						script: `import { label } from "../../utils"; export default () => ({ label })`,
					}
					expect((await loadAppPageScriptModule(page))!.default().label).to.equal("first")
					label = "updated"
					await reloadAppRuntime()
					expect((await loadAppPageScriptModule(page))!.default().label).to.equal("updated")
				} finally {
					unloadAppRuntime()
					setConfig("resourceFetcher", previous || undefined)
				}
			})(),
		)
	})

	it("keeps module paths in execution stack traces", () => {
		const loader = createLoader({
			"errors/example.ts": `export const fail = () => { throw new Error("intentional") }`,
		})
		cy.wrap(loader.loadModule("errors/example.ts")).then((module: any) => {
			try {
				module.fail()
			} catch (error: any) {
				expect(error.stack).to.include("studio-app:///errors/example.ts")
			}
		})
	})

	it("reports invalid syntax, unresolved imports and root escapes", () => {
		cy.wrap(
			(async () => {
				for (const source of [`import "./missing"`, `import "../outside"`, `export const =`]) {
					try {
						await createLoader({ "main.ts": source }).loadModule("main.ts")
						throw new Error("expected error")
					} catch (error: any) {
						expect(error.message).to.include("main.ts")
					}
				}
			})(),
		)
	})

	it("compares warm-compiler module loading and replacement against CommonJS", () => {
		cy.wrap(
			(async () => {
				const results: Record<string, any>[] = []
				for (const count of [25, 100, 250]) {
					const files: Record<string, string> = {}
					for (let index = 0; index < count; index++)
						files[`bench/${count}/file${index}.ts`] = `export const value = ${index}`
					files[`bench/${count}/main.ts`] =
						Array.from(
							{ length: count },
							(_, index) => `import { value as v${index} } from "./file${index}"`,
						).join("\n") +
						`\nexport const sum = ${Array.from({ length: count }, (_, index) => `v${index}`).join(" + ")}`
					await Promise.all(Object.entries(files).map(([path, source]) => compileFile(path, source)))
					for (const kind of ["commonjs", "native"]) {
						const loadTimes: number[] = [],
							editTimes: number[] = [],
							cacheTimes: number[] = []
						for (let run = 0; run < 5; run++) {
							const loader = kind === "native" ? createLoader(files) : new AppModuleRegistry(files)
							const entry = `bench/${count}/main.ts`
							let start = performance.now()
							const module = await loader.loadModule(entry)
							loadTimes.push(performance.now() - start)
							expect(module.sum).to.equal((count * (count - 1)) / 2)
							start = performance.now()
							for (let cached = 0; cached < 100; cached++) await loader.loadModule(entry)
							cacheTimes.push(performance.now() - start)
							start = performance.now()
							await loader.addFile(
								`bench/${count}/page.ts`,
								`import { sum } from "./main"; export default () => sum`,
							)
							expect((await loader.loadModule(`bench/${count}/page.ts`)).default()).to.equal(module.sum)
							editTimes.push(performance.now() - start)
							if (loader instanceof NativeModuleLoader) loader.dispose()
						}
						const median = (values: number[]) => Number(values.sort((a, b) => a - b)[2].toFixed(2))
						results.push({
							modules: count + 1,
							kind,
							loadMs: median(loadTimes),
							addPageMs: median(editTimes),
							cached100Ms: median(cacheTimes),
						})
					}
				}
				return {
					browser: navigator.userAgent,
					warmCompiler: true,
					runs: 5,
					results,
				}
			})(),
			{ timeout: 60000 },
		).then((results) => cy.writeFile("cypress/results/native-esm-benchmark.json", results))
	})
})
