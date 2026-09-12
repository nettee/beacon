# Beacon configuration format: YAML vs TOML

Research date: 2026-09-12

## Decision

Use **YAML 1.2** for Beacon's hand-maintained MVP configuration, parsed with
[`yaml`](https://eemeli.org/yaml/) v2 and validated separately with a strict
TypeScript schema (for example Zod strict objects). Keep prompts inline as YAML
literal block scalars; optionally add file references later if prompts become
large enough to deserve their own review lifecycle.

TOML is viable, and its quoted-string rules are more explicit, but it is not a
better fit for Beacon's representative data. Repeated Profiles containing
repeated schedules become nested arrays-of-tables, where header context carries
more meaning than indentation. More importantly, the strongest current,
maintained TypeScript TOML parser (`smol-toml`) exposes a value parser and
serializer rather than the source-aware document model Beacon would need to
attach schema errors to exact source locations or safely preserve comments
during edits. The `yaml` package exposes ranges, comments, CST tokens, a line
counter, and mutable Document nodes in one mature API.

This does **not** make YAML validation optional. Beacon should accept a
deliberately narrow YAML subset and fail fast:

- parse one document with YAML 1.2 core schema, `strict: true`,
  `uniqueKeys: true`, `stringKeys: true`, and a conservative alias limit (or
  disallow aliases);
- reject parse warnings as well as errors for configuration input;
- validate the resulting value with strict object schemas at every object
  boundary, so unknown fields fail instead of being stripped;
- map schema issue paths back through the YAML Document nodes to their
  `range`, then report `file:line:column` with the logical path;
- treat schedule expressions, time zones, IDs, paths, model names and Prompt
  text as strings; do not enable the optional YAML timestamp tag;
- never silently rewrite configuration during `serve` or `doctor`.

The equivalent samples are [beacon.example.yaml](./beacon.example.yaml) and
[beacon.example.toml](./beacon.example.toml).

## Parser experiment

The samples were parsed on Node.js with `yaml@2.9.1` and
`smol-toml@1.8.0`. Both produced two Profiles, with schedule counts `[1, 0]`,
so representability is not in question. Small adversarial checks confirmed:

- `yaml` core parsed `d: 2026-09-12` as a JavaScript string;
- `smol-toml` parsed `d = 2026-09-12` as its Date-derived TOML date value;
- both rejected a duplicate `a` key and printed the offending source line;
  the YAML Document additionally exposed structured `linePos` and error code
  `DUPLICATE_KEY`;
- `smol-toml.stringify(smolToml.parse("# c\na = 1.0\n"))` returned
  `"a = 1\n"`, demonstrating loss of both the comment and the float's lexical
  representation on a normal value round trip.

These checks corroborate documented behavior; they are not a comprehensive
parser conformance test.

## Comparison against Beacon's shape

| Concern | YAML 1.2 + `yaml` v2 | TOML 1.0/1.1 + `smol-toml` | Consequence |
|---|---|---|---|
| Multiple Profiles, one Feishu app each | A sequence of mappings; child access, prompts, destinations and schedules stay visually nested | `[[profiles]]`, followed by profile subtables and `[[profiles.schedules]]`; the reader must track which most-recent array element a nested table belongs to | YAML is easier to scan and safer to copy/edit for this shape |
| `allow_all` / allowlist | Natural tagged-by-field object (`mode`, optional `users`/`chats`) | Equally representable as a table | Tie; strict schema enforces the mode-dependent invariant in either format |
| Long Prompt | `|-` literal block preserves line breaks without interpreting `:`, `#`, quotes, or backslashes; indentation is structural and removed | `'''...'''` multiline literal string avoids escaping; the first newline after the delimiter is trimmed, but indentation inside content is retained | Both are good. TOML is pleasant for flush-left prose; YAML composes more cleanly inside each Profile |
| Arrays and nesting | Concise block sequences/maps | Flat tables are excellent; repeated nested records require arrays-of-tables and increasingly long headers | YAML wins for Profiles containing schedules and destinations |
| Comments | Supported by both specs. `yaml` Document nodes expose comments and source tokens, though its docs warn comment association is not completely stable in every case | Supported by spec. `smol-toml.parse()` returns values and `stringify()` regenerates text; comments are not in that value model | YAML has the stronger Node/TS path if source-aware editing is later needed |
| Syntax diagnostics | `parseDocument` reports error offsets and optional line/column/source excerpts; every parsed node has a source range | TOML parsers report syntax locations (legacy `@iarna/toml` documents line/col/pos; `smol-toml` emits parse errors), but the normal value API does not expose a source tree | YAML makes syntax and schema diagnostics easier to unify |
| Strict schema and unknown fields | Not a format feature. Parse to `unknown`, then strict schema validation | Same | Tie. Do not rely on either parser for Beacon semantics |
| Date coercion | YAML 1.2 **core schema has no timestamp type**; `yaml` only creates `Date` when its optional `timestamp` custom tag is enabled | TOML defines offset/local date-time, local date, and local time as native value kinds; `smol-toml` represents them with an extended `Date` and documents acceptance/normalization of some invalid dates | YAML has the safer default for a config whose dates/times should remain explicit strings |
| Deterministic serialization | Stringifying a JS value can be made stylistically consistent; Document mutation generally retains ordering/comments but is not byte-preserving | `smol-toml.stringify()` is deterministic for a given object/order but is lossy: comments and lexical choices disappear; it also documents `1.0` becoming `1` by default | Neither parse-to-object/stringify path is a lossless editor. YAML Document is the better starting point |
| Programmatic round-trip editing | Document `getIn`/`setIn`/`deleteIn`, ranges and comments are first-class | Requires an additional CST/patch library (for example `toml-patch`) or textual patching; this is not part of `smol-toml` | YAML avoids a second parser/editor stack |
| TypeScript ecosystem | `yaml` ships types, YAML 1.2 support and a source-aware Document API; current npm metadata checked during research: 2.9.1 | `smol-toml` is active, typed, and largely TOML 1.1 compliant; current npm metadata: 1.8.0. `@iarna/toml` is older (2.2.5, npm metadata last modified 2023) | Both have usable parsers; YAML's API better matches Beacon diagnostics |

## Important facts vs inference

### Specification and library facts

- YAML 1.2.2 defines block collections, comments, literal/folded block
  scalars, and recommends the core schema. Its core schema resolves only the
  JSON-family scalar tags plus YAML's expanded boolean/number/null spelling;
  timestamp is not a core tag.
- TOML 1.0 defines four date/time value kinds, four string forms, tables, and
  arrays-of-tables. A newline immediately after a multiline string's opening
  delimiter is trimmed; remaining indentation is content.
- TOML key order is not semantically guaranteed. YAML's representation model
  likewise says mapping key order and comments must not be relied upon as
  constructed data semantics. Display order may still be maintained as an
  editorial convention.
- `yaml` v2's `parseDocument` exposes parse errors/warnings, node ranges,
  comments, CST tokens, line counting, and mutable document accessors.
- `smol-toml` states that it passes most official `toml-test` cases but does
  not reject certain invalid dates (for example `2023-02-30`, which it
  normalizes), and that parse/stringify can lose numeric lexical type
  (`1.0` becomes `1` by default).
- Neither syntax parser knows Beacon's allowed fields. Zod strict objects (or
  an equivalent strict validator) are required to reject unknown keys.

### Beacon-specific inference

- Humans are more likely to make context mistakes in a copied block of nested
  TOML arrays-of-tables than in an indented YAML Profile. This is a usability
  judgment based on the concrete samples, not a property guaranteed by either
  specification.
- MVP configuration is declared read-only and reloads only on restart, so
  lossless programmatic editing is not a current requirement. YAML's Document
  advantage matters mainly for high-quality diagnostics now and leaves a
  cleaner path if an admin command edits config later.
- Prompt length alone does not justify TOML. Both samples keep Prompt content
  readable; the surrounding repeated structure favors YAML.

## Recommended loading boundary

```ts
import { LineCounter, parseDocument } from "yaml";

export function parseConfig(source: string): unknown {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, {
    version: "1.2",
    schema: "core",
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    lineCounter,
  });

  if (doc.errors.length || doc.warnings.length) {
    throw new ConfigSyntaxError(doc.errors, doc.warnings);
  }

  // Apply the strict Beacon schema next; never cast this value to Config.
  return doc.toJS({ maxAliasCount: 0 });
}
```

The production implementation should keep `doc` alongside the raw value long
enough to resolve each schema issue path to a node range. If a path points to a
missing required field, report the closest parent node's location.

## Serialization policy

For the MVP, **do not serialize the user's config at all**. Configuration is a
human-owned input file; runtime records and schedule state belong in separate
state files written atomically. This avoids pretending either format provides
lossless object round-tripping.

If Beacon later gains `config set`, prefer YAML Document mutation and show a
diff before replacing the file. Still use atomic write-to-temp + rename, and
reparse/revalidate before replacement. Deterministic canonical generation is a
different operation from respectful editing and should be exposed separately.

## Sources

- [YAML 1.2.2 specification](https://yaml.org/spec/1.2.2/)
- [`yaml` v2 documentation](https://eemeli.org/yaml/)
- [TOML 1.0 specification](https://toml.io/en/v1.0.0)
- [`smol-toml` documentation/source](https://github.com/squirrelchat/smol-toml)
- [Zod strict object and error-path documentation](https://zod.dev/api)
- [`@iarna/toml` parser diagnostics documentation](https://github.com/iarna/iarna-toml)
- [`toml-patch` round-trip editing API](https://github.com/DecimalTurn/toml-patch)
