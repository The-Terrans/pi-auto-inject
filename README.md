# pi-auto-inject

Pi extension project for automatically injecting contents of files referenced with `@path` into user requests, instead of leaving references for the model to read later.

**Status:** Project scaffold only; injection is not implemented yet.

## Development

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts Pi with local extension. Pi also loads this repository as a local package via `pi install ./`.
