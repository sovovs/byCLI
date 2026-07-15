# @sovovs/bycli-recorder-core

Pure-domain recorder engine shared by byCLI and its recorder backend.

It provides canonicalization, normalization, pairing, aggregation, scoring,
ranking, verification, configuration, logging, metrics, and shared recorder
types. It performs no browser control, HTTP serving, filesystem writes, or
process output.

```js
import { rankSamples } from '@sovovs/bycli-recorder-core';

const result = rankSamples(samples);
```

Licensed under Apache-2.0.
