# cclint

Short alias for **[claude-config-lint](https://www.npmjs.com/package/claude-config-lint)**.
It contains no logic of its own — it exists so that `npx cclint` resolves, since
npx looks up a package name rather than a bin name.

```bash
npx cclint
npx cclint doctor
```

Identical to `npx claude-config-lint`. Documentation, issues and source all live
in the [main repository](https://github.com/Santhosraj/Claude_Linter#readme).

The two packages are released together and the alias pins the exact version of
the core it wraps, so `cclint@0.1.0` always runs `claude-config-lint@0.1.0`.
