# Built-in brands

| Brand | Look |
|---|---|
| `neutral` | Dark slate gradient backdrop; footage inset at 92 % with rounded corners, a soft shadow and an automatic rim (drawn only when the footage edge blends into the backdrop); soft-blue accent; title card with the app name, demo title and date; no logo. |

User brands, such as a company brand with its logo, are created with
`/demo brand new` (skill `demo-brand`). They live in `<root>/brands/<name>/`,
outside this repo.

**Full documentation:** [docs/BRANDS.md](../docs/BRANDS.md) covers:
- the package layout;
- every `brand.json` option with its default and range;
- the automatic decisions (footage rim, logo-bug placement, title text, title-card hold);
- the render chain, validation, caching, and trademark rules.
