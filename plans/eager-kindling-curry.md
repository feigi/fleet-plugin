# Emit `uses` references from Java / TypeScript / Python analyzers

## Context

L4 code-level diagrams render three relationship kinds: `inherits`, `implements`, `uses` (plus `contains` for C structs). Today only the C analyzer actually emits `uses` edges (commit `5b4a2c0` on `feature/c4-code-level`) — Java, TypeScript, and Python analyzers only emit `extends`/`implements` from heritage clauses.

Consequence: every non-C L4 diagram shows an inheritance skeleton with no dependency edges, even when classes clearly depend on each other via fields / method signatures. The pipeline downstream of the analyzers already supports `uses` end-to-end:

- Model: `mapReferenceKind` in `src/core/code-model.ts:447` passes `uses` through unchanged.
- Resolver: `resolveReference` in `src/core/code-model.ts:379` resolves all kinds identically.
- Generator: `javaTsPyProfile.renderRelationships` in `src/generator/d2/code-profiles.ts:82` emits a D2 connection for every kind; `cProfile` skips only `inherits`/`implements` (not `uses`).

Gap is scan-side. Target branch: **`feature/c4-code-level`** (main has no L4 code files).

Scope (decided with user):
- "Uses" = signatures only: **field types, method parameter types, method return types**. Constructor params count (they're method parameters). No call-site walks, no local-var types.
- Stdlib/primitive filter: **per-language blocklist**, mirroring C's `BUILTIN_TYPES` approach.

## Intended outcome

A TS/Java/Python L4 diagram for a `UserService` class with `private List<User> users` and `User findByName(String n)` renders:

```
UserService → User    : uses
UserService → Auditable : implements
```

…instead of only the `implements` edge. Stdlib names (`String`, `List`, `number`, `str`, …) do not appear as dangling external refs.

## Implementation

### 1. TypeScript — `src/analyzers/typescript/code.ts`

Extend `collectReferences(declNode, elementKind)`:

- Add a blocklist constant near the top:
  ```ts
  const TS_BUILTINS = new Set([
    "string","number","boolean","void","any","unknown","never",
    "object","symbol","bigint","null","undefined",
    "Promise","Array","Map","Set","Date","Error","RegExp",
    "Record","Partial","Readonly","Pick","Omit","Required",
  ]);
  ```
- Keep existing heritage walk. Track target names already emitted (`extends`/`implements`) in a `Set<string>` so `uses` doesn't double up.
- When `elementKind === "class" | "interface"`, walk the body (`class_body` / `interface_body` / `object_type`) and collect type names from:
  - `public_field_definition` / `property_signature` — read `type` field.
  - `method_definition` / `method_signature` — read `parameters` (walk each `required_parameter`/`optional_parameter` `type`) and `return_type`.
  - Constructor shorthand params already surface as fields; reuse the same type walk.
- Reuse existing `typeName(node)` helper; extend it to recurse into `union_type`, `array_type`, `tuple_type`, `generic_type` type_arguments so `User[]`, `User | null`, `Array<User>` all yield `User`.
- Skip names in `TS_BUILTINS` and names already seen with `extends`/`implements` for this element. Deduplicate `uses` targets within the element.

### 2. Java — `src/analyzers/java/code.ts`

Extend `collectReferences(declNode, elementKind, fileCtx)`:

- Add a blocklist:
  ```ts
  const JAVA_LANG_BUILTINS = new Set([
    "String","Object","Integer","Long","Short","Byte","Boolean","Character",
    "Float","Double","Number","Void","Class","Throwable","Exception","RuntimeException",
    "Error","Thread","Runnable","System","Math","Enum","Iterable",
    // primitives (tree-sitter tags them as `integral_type`/`floating_point_type`, but
    // guard anyway in case they leak through as identifiers):
    "int","long","short","byte","boolean","char","float","double","void",
  ]);
  ```
- Keep existing heritage walk; populate a `seen: Set<string>` with all `extends`/`implements` target names.
- Walk the `class_body` / `interface_body`:
  - `field_declaration` — pull `type` child; run through `typeName(node)` extended to handle `generic_type` / `array_type` / `scoped_type_identifier` (return rightmost segment).
  - `method_declaration` / `constructor_declaration` — pull the return `type` (methods only) and each `formal_parameter`'s `type` child.
- For each extracted simple name: skip if in `JAVA_LANG_BUILTINS` or `seen`; mark seen; emit via existing `push(name, "uses")` which runs `resolveTargetFqn` so `targetQualifiedName` is populated (crucial per the FQN-resolver memory, `Hy1whxuF_VQEG84eumILc`).

### 3. Python — `src/analyzers/python/code.ts`

Extend extraction for `kind === "class"`:

- Add blocklist:
  ```ts
  const PY_BUILTINS = new Set([
    "str","int","bool","float","complex","bytes","bytearray","memoryview",
    "list","dict","tuple","set","frozenset","None","NoneType","object","type",
    "Any","Optional","Union","List","Dict","Tuple","Set","FrozenSet",
    "Iterable","Iterator","Generator","Callable","Awaitable","Coroutine",
  ]);
  ```
- Today only `collectBaseClasses` runs. Add a `collectClassBodyReferences(classNode)` that walks the class `body` block for `function_definition` / `decorated_definition` and reads each parameter's `type` annotation + the `return_type`. Use the existing `baseName(node)` helper — it already unwraps `attribute` (`mod.Foo → Foo`) and `subscript` (`List[Foo] → List`).
- For subscripts specifically, also recurse into the subscript's type arguments so `List[User]` yields `User` (not `List`). Add helper `collectNamesDeep(typeNode)` that returns a flat list.
- Dedupe against `extends` targets from `collectBaseClasses`, skip `PY_BUILTINS`, push `{ targetName, kind: "uses" }`.

### 4. Types — `src/analyzers/types.ts`

No change. `RawCodeReference.kind` already supports `"uses"`.

### 5. Zod / JSON Schema

No change — existing schemas already accept `"uses"`. (Verified via memory `vwjEJZ4JG2KY4nHDwpLy2` — the four-way sync is only required when adding new fields.)

## Tests (TDD: write first, watch them fail, then implement)

### `tests/analyzers/typescript-code.test.ts`

Add fixture edit (`tests/fixtures/code-level/typescript/user.ts`): `UserService.findByName` already returns `User | undefined` and has field `users: User[]`. Add asserts:

```ts
it("captures uses edges from field/method signatures", async () => {
  const els = await extractTypeScriptCode(FIXTURE, fs.readFileSync(FIXTURE, "utf-8"));
  const svc = els.find((e) => e.name === "UserService")!;
  expect(svc.references).toEqual(
    expect.arrayContaining([{ targetName: "User", kind: "uses" }]),
  );
});

it("does not emit uses for TS builtins", async () => {
  // findByName(name: string): User | undefined  — string/undefined must not appear
  const els = await extractTypeScriptCode(FIXTURE, fs.readFileSync(FIXTURE, "utf-8"));
  const svc = els.find((e) => e.name === "UserService")!;
  const usesNames = (svc.references ?? []).filter(r => r.kind === "uses").map(r => r.targetName);
  expect(usesNames).not.toContain("string");
  expect(usesNames).not.toContain("undefined");
});

it("does not duplicate an implements target as uses", async () => {
  // UserService implements Auditable and calls nothing of that name in its signatures.
  // Sanity guard for the dedup path.
  const src = `interface Foo {} class C implements Foo { f: Foo; }`;
  const els = await extractTypeScriptCode("c.ts", src);
  const c = els.find(e => e.name === "C")!;
  const fooRefs = (c.references ?? []).filter(r => r.targetName === "Foo");
  expect(fooRefs.map(r => r.kind)).toEqual(["implements"]);
});
```

### `tests/analyzers/java-code.test.ts`

Reuse existing `UserService.java` fixture (already has `List<User>` field and `findByName(String)`):

```ts
it("captures uses edges from fields and method signatures", async () => {
  const els = await extractJavaCode(FIXTURE, fs.readFileSync(FIXTURE, "utf-8"));
  const svc = els.find((e) => e.name === "UserService")!;
  const usesRefs = (svc.references ?? []).filter(r => r.kind === "uses");
  expect(usesRefs.map(r => r.targetName)).toContain("User");
});

it("filters java.lang builtins from uses", async () => {
  const els = await extractJavaCode(FIXTURE, fs.readFileSync(FIXTURE, "utf-8"));
  const svc = els.find((e) => e.name === "UserService")!;
  const usesNames = (svc.references ?? []).filter(r => r.kind === "uses").map(r => r.targetName);
  expect(usesNames).not.toContain("String");
});

it("populates targetQualifiedName for resolved uses", async () => {
  const els = await extractJavaCode(FIXTURE, fs.readFileSync(FIXTURE, "utf-8"));
  const svc = els.find((e) => e.name === "UserService")!;
  const userUse = (svc.references ?? []).find(r => r.kind === "uses" && r.targetName === "User");
  expect(userUse?.targetQualifiedName).toBe("com.example.users.User");
});
```

### `tests/analyzers/python-code.test.ts`

Reuse existing `user_service.py` fixture (`UserService.__init__(self, users: List[User])`, `find_by_name(self, name: str) -> User`):

```ts
it("captures uses edges from typed method signatures", async () => {
  const els = await extractPythonCode(FIXTURE, fs.readFileSync(FIXTURE, "utf-8"));
  const svc = els.find((e) => e.name === "UserService")!;
  const usesNames = (svc.references ?? []).filter(r => r.kind === "uses").map(r => r.targetName);
  expect(usesNames).toContain("User");
});

it("filters Python builtins and typing generics from uses", async () => {
  const els = await extractPythonCode(FIXTURE, fs.readFileSync(FIXTURE, "utf-8"));
  const svc = els.find((e) => e.name === "UserService")!;
  const usesNames = (svc.references ?? []).filter(r => r.kind === "uses").map(r => r.targetName);
  expect(usesNames).not.toContain("str");
  expect(usesNames).not.toContain("List");
});
```

## Critical files

- **Edit** `src/analyzers/typescript/code.ts` — extend `collectReferences`, extend `typeName` recursion.
- **Edit** `src/analyzers/java/code.ts` — extend `collectReferences`, extend `typeName` recursion.
- **Edit** `src/analyzers/python/code.ts` — add `collectClassBodyReferences`, reuse `baseName`.
- **Edit** `tests/analyzers/typescript-code.test.ts`, `tests/analyzers/java-code.test.ts`, `tests/analyzers/python-code.test.ts` — add the assertions above.
- **Do not touch** `src/core/code-model.ts`, `src/generator/d2/code*.ts`, schema files — the downstream path is already uses-aware.

## Reuse / existing utilities

- `resolveTargetFqn` in `src/analyzers/java/code.ts:105` — Java FQN resolution, already populates `targetQualifiedName`.
- `typeName(node)` in both `java/code.ts` and `typescript/code.ts` — extend in place, don't duplicate.
- `baseName(node)` in `python/code.ts:44` — already strips `attribute`/`subscript` wrappers.
- C's `BUILTIN_TYPES` set (`src/analyzers/c/code.ts:18`) — follow the same pattern, not shared.

## Verification

1. `npx vitest run tests/analyzers/typescript-code.test.ts tests/analyzers/java-code.test.ts tests/analyzers/python-code.test.ts` — new assertions pass; existing ones still pass.
2. `npm test` — full suite green (drift / correctness tests include L4 now).
3. `npm run typecheck` — no type regressions.
4. Manual smoke on a real repo with `levels.code: true`:
   - `npm run dev -- scan && npm run dev -- generate` on this repo (TypeScript) and on the Java/Python fixtures monorepo.
   - Inspect `docs/architecture/**/c4-code*.d2` for `→` connections with `uses` labels (previously only `inherits`/`implements`).
   - Cross-check `architecture-model.yaml`'s `codeRelationships` contains `kind: uses` entries.
5. Watch the stderr counter `L4: N code reference(s) dropped as stdlib/external`. Some growth is expected (unresolved internal names that aren't on the blocklist). If the number dominates, tighten per-language blocklists — don't loosen resolver rules.
