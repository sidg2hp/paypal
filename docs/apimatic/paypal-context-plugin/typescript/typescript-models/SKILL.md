---
name: 'typescript-models'
description: 'Work with models from the PayPal Server SDK TypeScript SDK. Load before building a request payload or mapping a response onto your own types. The interface won''t tell you each model has a paired runtime schema, how unions are read back, that date fields are plain strings, or where unknown JSON survives.'
---

# Working with models in an APIMatic TypeScript SDK

Most request/response data are plain TypeScript objects conforming to interfaces (covered in `typescript-calling-endpoints`). This skill covers the **non-obvious model shapes** that trip integrations up. The patterns are generic across APIMatic TypeScript SDKs; take the real type names from your SDK source.

## Union types (oneOf / anyOf)

**Check this SDK has any before reading on:** `ls src/models/containers/`. No such directory means
the API declares no `oneOf`/`anyOf` type, nothing below is generated, and a field that looks like a
union is an ordinary object with every member optional. Skip to the next section.

When a field can be one of several types, APIMatic generates a union type in
`src/models/containers/`: a TypeScript union of the variant interfaces, plus a runtime schema built with
either `oneOf([...])` or `anyOf([...])`. **The two behave differently and you must tell them apart.**

The only reliable signals are the container file's doc comment (`This is a container type for one-of
types` / `... for any-of types`) and the literal `oneOf([...])` / `anyOf([...])` call in its source. Do
**not** infer it from the schema's runtime `type()` string or from the error text — an `anyOf` container
also reports itself as `OneOf<...>`.

### Construct — a plain object literal

There are **no factory helpers**. Assign the variant's own shape directly:

```typescript
const body: {RequestType} = {
  {field}: {                 // typed as {Union}
    type: '{variantTag}',    // the variant's discriminating value, if it has one
    someField: 'value',
  },
};
```

### Read — narrow with the generated type guards

The union's namespace exports one `is{Variant}` guard per variant. These are **read-side only**:

```typescript
import { {Union} } from '@paypal/paypal-server-sdk';

if ({Union}.is{Variant}(response.result.{field})) {
  // narrowed to {Variant}
}
```

A tagged union can also be narrowed on its discriminator:

```typescript
switch (response.result.{field}.type) {
  case '{variantTag}':
    break;
}
```

### The failure mode to know about

Both kinds are validated **when you make the call**, client-side, before any HTTP request.

`oneOf` requires **exactly one** variant to match, so two errors come out of it:

- `Matched more than one type` — your value satisfies several variants at once. Usually the variants'
  discriminating field is unconstrained in the generated schema, so no value can disambiguate them. Set
  the discriminator explicitly; if it still fails, the union cannot be satisfied from the typed API and
  the SDK needs regenerating.
- `Could not match against any acceptable type` — a required field is missing, or the discriminator
  value is not one the variant accepts.

`anyOf` requires **at least one** match, so it can only ever raise the second error — a value matching
several variants is accepted. Don't chase a "matched more than one" diagnosis on an `anyOf` container.

Open the container file under `src/models/containers/` and read the variant list and each variant's
schema before debugging your own input.

## Collections

List/array properties are `Array<T>` (or `T[]`); maps are `Record<string, V>`. Assign a plain array or object directly:

```typescript
const body: {RequestType} = {
  {listProp}: ['A', 'B'],                           // Array<string>
  {mapProp}: { key: 'value' },                      // Record<string, string>
};
```

An `undefined` collection is omitted from the JSON; an explicit `null` is sent **as `null`** (only allowed
where the property type includes `| null`); an empty array `[]` is serialized as `[]`.

## Dates & numbers

- Date/time fields are plain `string` properties with a bare `string()` runtime schema — **the SDK does
  no date conversion and no format checking**. The expected format is whatever the spec declares, and it
  is not always ISO-8601: a field documented `Format: dd-MM-yyyy HH:mm:ss` rejects
  `new Date().toISOString()` at the API, with nothing client-side to warn you. Read the field's own doc
  comment in `src/models/` (or its `@param` line in `src/controllers/`) and format the string to match.
- Money/quantities may be `string`, `number`, or a union; the model's property type is the source of truth.
- Numeric IDs are typically `number`.

## Enums

Enums are TypeScript `enum` declarations exported from the SDK (member = wire value). Reference the
member — never a bare string literal:

```typescript
import { {EnumType} } from '@paypal/paypal-server-sdk';

request.{enumProp} = {EnumType}.SomeConstant;
```

An enum member is still assignable to `string` (or `number` for a numeric enum), so reading one into your
own code needs no conversion. Going the other way, **the compiler is less help than it looks**:
`const x: {EnumType} = 'value'` is rejected (TS2322), but a type assertion —
`'value' as {EnumType}`, including a value that is not a declared member — **compiles with no
diagnostic**, because an enum and `string` are comparable types. No `as unknown as` is needed, and none
of this tells you whether the value is real.

What actually decides it is the enum's own schema, and **the permissive form is usually the common
one**: `stringEnum(X)` accepts declared members only, while `stringEnum(X, true)` accepts any string.
Check yours rather than assuming the strict case — `grep -c 'stringEnum(.*, true)' src/models/*.ts`
against the total — because where the permissive form dominates, nothing between your assertion and the
provider will reject a value you invented.

See [reference.md](reference.md) for the full enum declaration shape.

## Unknown / future fields

Whether unknown response fields survive varies per SDK.
The discovery signal is the model's own file — its schema call, and the interface beside it:

- **`expandoObject({...})`**, paired with an index signature **`[key: string]: unknown`** on the
  interface → unknown response fields land on the object **itself** (`result.someUnknownField`), and any
  extra key you set on a request object is serialized into the body as-is. There is **no**
  `additionalProperties` member: reading `result.additionalProperties` gives `undefined`, and writing
  `{ additionalProperties: {...} }` still compiles against the index signature and sends a literal
  `additionalProperties` key.
- **`typedExpandoObject({...}, '<key>', <valueSchema>)`** → the extras are collected under the **named
  member given as its second argument**, typed `Record<string, T>` on the interface. Read that name off
  the call; it is not a fixed word.
- A plain **`object({...})`** → unknown fields are dropped on deserialization.

Check the model interface and its schema before concluding a field was lost — reaching for a regenerate
or a hand-rolled parse is a dead end when the data is already sitting on the returned object.

## Next

- Step 5, errors and status codes → **typescript-error-handling**
- Back to the call that returned this shape → **typescript-calling-endpoints**
