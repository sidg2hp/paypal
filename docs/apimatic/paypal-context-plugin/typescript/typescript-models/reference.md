# Models reference (APIMatic TypeScript)

## Date/time

Date/time values are plain `string` properties with a bare `string()` schema — the SDK converts nothing
and validates no format. The format is the one the spec declares (RFC-3339 in many APIs, but also things
like `dd-MM-yyyy HH:mm:ss`), and it is written in the field's doc comment in `src/models/`. Read that
comment, then produce the string yourself — `Date.toISOString()`, or a formatter such as `date-fns` or
`dayjs` for a non-ISO format.

## String-enum shape

A real TypeScript `enum` declaration, with its runtime schema beside it:

```typescript
export enum {EnumType} {
  FirstValue = 'first_value',
  SecondValue = 'second_value',
}

export const {enumType}Schema: Schema<{EnumType}> = stringEnum({EnumType});
```

Usage:

```typescript
import { {EnumType} } from '@paypal/paypal-server-sdk';

const v: {EnumType} = {EnumType}.FirstValue;    // reference the member
const raw: string = {EnumType}.FirstValue;      // string assignment works directly
```

A bare string literal is not assignable, and `'new_value' as {EnumType}` compiles (an assertion between an enum and `string` is allowed) but proves nothing. A schema built
as `stringEnum({EnumType}, true)` — emitted only when the spec marks the enum as accepting additional
values — is the one case where unknown values pass validation; reaching it from typed code needs
`'new_value' as unknown as {EnumType}`.

## Numeric-enum shape

Same declaration over `number`, with `numberEnum` for the schema:

```typescript
export enum {EnumType} {
  Off = 0,
  On = 1,
}

export const {enumType}Schema: Schema<{EnumType}> = numberEnum({EnumType});

request.{enumProp} = {EnumType}.On;
const n: number = {EnumType}.On;   // number assignment works directly
```

## Union types — finding the exact members

For a oneOf/anyOf union type, open its file under **`src/models/containers/`**. Its doc comment and the
literal `oneOf([...])` / `anyOf([...])` call are the only reliable way to tell the two apart — the
runtime type label reads `OneOf<...>` for both. Each variant `{V}` produces a **type guard** on the
union's namespace:

- `{Union}.is{V}(value): value is {V}` — read-side narrowing.

There are **no `from{V}` factories** in TypeScript. To build a union value you assign the variant's own
object shape directly; see the union section in `SKILL.md` for the write-side pattern.

## Notes

- Optional model properties typed as `T | undefined` are omitted from the serialized JSON when `undefined` — distinct from sending an explicit `null`.
- A model captures unknown response fields when its schema is `expandoObject(...)` — the interface then
  carries an index signature `[key: string]: unknown` and the extras sit on the object itself, with no
  `additionalProperties` member — or `typedExpandoObject(schema, '<key>', <valueSchema>)`, which collects
  them under the member named by its second argument. Where the schema is a plain `object(...)`, unknown
  fields are dropped on deserialization. Which form you get varies per SDK — read the
  model's schema.
