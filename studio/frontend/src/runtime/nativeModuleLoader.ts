import { compileFile, parseModuleProgram } from "@/runtime/compiler"
import { AppCompileError, applyStyles } from "@/runtime/moduleRegistry"
import { loadImportableModule } from "@/runtime/importableModules"

type ImportLocation = { specifier: string; start: number; end: number }
type SourceModule = {
	code: string
	imports: ImportLocation[]
	computed: { start: number; end: number }[]
}

const extensionCandidates = ["", ".ts", ".js", ".json", "/index.ts", "/index.js"]
const bridgeKey = "studio:native-esm-prototype"
const bridgeExpression = `globalThis[Symbol.for(${JSON.stringify(bridgeKey)})]`

type Bridge = {
	dependencies: Map<string, Record<string, any>>
	urls: Map<string, Promise<string>>
	importers: Map<string, (from: string, specifier: string) => Promise<any>>
	applyStyles: typeof applyStyles
}

export class NativeModuleLoader {
	private id = crypto.randomUUID()
	private revision = 0
	private files: Record<string, string>
	private modules = new Map<string, SourceModule>()
	private urls = new Map<string, string>()
	private blobs = new Set<string>()
	private importers = new Set<string>()
	private loaded = new Map<string, Promise<any>>()
	private prepared: Promise<void> | null = null
	private disposed = false

	constructor(files: Record<string, string>) {
		this.files = { ...files }
	}

	async loadModule(path: string): Promise<any> {
		await this.prepare()
		return this.importURL(path)
	}

	async addFile(path: string, source: string): Promise<void> {
		await this.prepare()
		if (this.files[path] === source && this.modules.has(path)) return
		const compiled = await compileModule(path, source)
		const previousSource = this.files[path]
		const previousModule = this.modules.get(path)
		this.files[path] = source
		this.modules.set(path, compiled)
		try {
			await this.publish(this.findImporters(path))
		} catch (error) {
			if (previousSource === undefined) delete this.files[path]
			else this.files[path] = previousSource
			if (previousModule) this.modules.set(path, previousModule)
			else this.modules.delete(path)
			throw error
		}
	}

	hasFile(path: string): boolean {
		return this.files[path] !== undefined
	}

	dispose(): void {
		this.disposed = true
		for (const url of this.blobs) URL.revokeObjectURL(url)
		this.blobs.clear()
		for (const id of this.importers) getBridge().importers.delete(id)
		this.importers.clear()
		this.loaded.clear()
	}

	private prepare(): Promise<void> {
		if (this.disposed) throw new Error("This app module loader was disposed.")
		this.prepared ??= this.compileAll()
		return this.prepared
	}

	private async compileAll(): Promise<void> {
		for (const [path, source] of Object.entries(this.files)) {
			this.modules.set(path, await compileModule(path, source))
		}
		await this.publish(new Set(this.modules.keys()))
	}

	private async publish(changed: Set<string>): Promise<void> {
		const urls = new Map(this.urls)
		const revision = ++this.revision
		const importer = `${this.id}/${revision}`
		for (const path of changed) {
			urls.set(path, new URL(`/__studio_esm__/${this.id}/${revision}/${path}`, location.href).href)
		}
		const imports: Record<string, string> = {}
		try {
			for (const path of changed) {
				const code = await this.rewrite(path, this.modules.get(path)!, urls, importer)
				imports[urls.get(path)!] = createModuleURL(`${code}\n//# sourceURL=studio-app:///${path}`)
			}
		} catch (error) {
			for (const blob of Object.values(imports)) URL.revokeObjectURL(blob)
			throw error
		}
		const map = document.createElement("script")
		map.type = "importmap"
		map.textContent = JSON.stringify({ imports })
		document.head.append(map)
		map.remove()
		getBridge().importers.set(importer, async (from, specifier) => {
			if (isLocal(specifier)) return this.importURL(this.resolve(from, specifier, urls), urls)
			return import(/* @vite-ignore */ await dependencyURL(specifier))
		})
		this.importers.add(importer)
		for (const blob of Object.values(imports)) this.blobs.add(blob)
		this.urls = urls
	}

	private async rewrite(
		path: string,
		module: SourceModule,
		urls: Map<string, string>,
		importer: string,
	): Promise<string> {
		const replacements: { start: number; end: number; value: string }[] = []
		for (const item of module.imports) {
			const url = isLocal(item.specifier)
				? urls.get(this.resolve(path, item.specifier))!
				: await dependencyURL(item.specifier)
			replacements.push({ ...item, value: JSON.stringify(url) })
		}
		for (const item of module.computed) {
			replacements.push({
				...item,
				value: `${bridgeExpression}.importers.get(${JSON.stringify(importer)}).bind(null, ${JSON.stringify(path)})`,
			})
		}
		let code = module.code
		for (const { start, end, value } of replacements.sort((a, b) => b.start - a.start)) {
			code = code.slice(0, start) + value + code.slice(end)
		}
		return code
	}

	private findImporters(path: string): Set<string> {
		const changed = new Set([path])
		let size: number
		do {
			size = changed.size
			for (const [candidate, module] of this.modules) {
				if (
					module.computed.length ||
					module.imports.some(
						(item) => isLocal(item.specifier) && changed.has(this.resolve(candidate, item.specifier)),
					)
				)
					changed.add(candidate)
			}
		} while (changed.size !== size)
		return changed
	}

	private resolve(from: string, specifier: string, modules: Map<string, unknown> = this.modules): string {
		const parts = specifier.startsWith("@app/") ? [] : from.split("/").slice(0, -1)
		const relative = specifier.startsWith("@app/") ? specifier.slice(5) : specifier
		for (const segment of relative.split("/")) {
			if (segment === "." || segment === "") continue
			if (segment === "..") {
				if (!parts.length) throw compileError(from, `Cannot resolve "${specifier}"`)
				parts.pop()
			} else parts.push(segment)
		}
		const base = parts.join("/")
		for (const extension of extensionCandidates) {
			if (modules.has(base + extension)) return base + extension
		}
		throw compileError(from, `Cannot resolve "${specifier}"`)
	}

	private importURL(path: string, urls = this.urls): Promise<any> {
		if (this.disposed) throw new Error("This app module loader was disposed.")
		const url = urls.get(path)
		if (!url) throw new Error(`${path} is not a module in this app.`)
		let module = this.loaded.get(url)
		if (!module) {
			module = import(/* @vite-ignore */ url)
			this.loaded.set(url, module)
		}
		return module
	}
}

async function compileModule(path: string, source: string): Promise<SourceModule> {
	if (path.endsWith(".json")) {
		try {
			JSON.parse(source)
		} catch (error: any) {
			throw compileError(path, error.message)
		}
		return { code: `export default JSON.parse(${JSON.stringify(source)})`, imports: [], computed: [] }
	}
	if (path.endsWith(".css")) {
		return {
			code: `${bridgeExpression}.applyStyles(${JSON.stringify({ [path]: source })}); export default ${JSON.stringify(path)}`,
			imports: [],
			computed: [],
		}
	}
	const compiled = await compileFile(path, source)
	if (compiled.errors.length) throw new AppCompileError(compiled.errors)
	try {
		const program = await parseModuleProgram(compiled.code)
		const module: SourceModule = { code: compiled.code, imports: [], computed: [] }
		collectImports(program, module)
		if (compiled.css)
			module.code += `\n${bridgeExpression}.applyStyles(${JSON.stringify({ [path]: compiled.css })})`
		return module
	} catch (error: any) {
		throw compileError(path, error.message)
	}
}

function collectImports(node: any, module: SourceModule): void {
	if (!node || typeof node !== "object") return
	if (Array.isArray(node)) {
		for (const item of node) collectImports(item, module)
		return
	}
	if (
		["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) &&
		node.source
	) {
		module.imports.push({ specifier: node.source.value, start: node.source.start, end: node.source.end })
	}
	if (node.type === "CallExpression" && node.callee.type === "Import") {
		const argument = node.arguments[0]
		if (argument.type === "StringLiteral") {
			module.imports.push({ specifier: argument.value, start: argument.start, end: argument.end })
		} else module.computed.push({ start: node.callee.start, end: node.callee.end })
	}
	for (const value of Object.values(node)) {
		if (Array.isArray(value) || (value && typeof value === "object" && "type" in value))
			collectImports(value, module)
	}
}

function getBridge(): Bridge {
	const host = globalThis as any
	return (host[Symbol.for(bridgeKey)] ??= {
		dependencies: new Map(),
		urls: new Map(),
		importers: new Map(),
		applyStyles,
	})
}

function dependencyURL(specifier: string): Promise<string> {
	const bridge = getBridge()
	let url = bridge.urls.get(specifier)
	if (!url) {
		url = loadImportableModule(specifier).then((namespace) => {
			bridge.dependencies.set(specifier, namespace)
			const exports = Object.keys(namespace)
				.filter((name) => name !== "__esModule")
				.map(
					(name, index) =>
						`const value${index} = namespace[${JSON.stringify(name)}]; export { value${index} as ${JSON.stringify(name)} };`,
				)
			return createModuleURL(
				`const namespace = ${bridgeExpression}.dependencies.get(${JSON.stringify(specifier)});\n${exports.join("\n")}`,
			)
		})
		bridge.urls.set(specifier, url)
	}
	return url
}

function createModuleURL(code: string): string {
	return URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
}

function isLocal(specifier: string): boolean {
	return specifier.startsWith(".") || specifier.startsWith("@app/")
}

function compileError(path: string, message: string): AppCompileError {
	return new AppCompileError([{ file: path, line: null, column: null, message }])
}
