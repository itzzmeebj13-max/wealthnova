---
name: Named OpenAPI input schemas
description: Orval barrel export collisions caused by inline request bodies
---

Use named component schemas for endpoint request bodies rather than anonymous
inline objects.

**Why:** Orval can generate both a TypeScript body type and a Zod body constant
with the same endpoint-derived name. Re-exporting both from the validation
package's barrel then fails TypeScript with duplicate exports. A distinct
named input schema avoids the collision without modifying generated files.

**How to apply:** When adding a new request body, put it in OpenAPI components
and reference it, including for a body that is only an empty JSON object.
