# Test Benchmarks

Measured test runtimes for setting realistic local and CI timeouts.

Recommended timeout is the larger of twice the last runtime or 30 seconds.

| Command | Last Run Time | Last Updated | Recommended Timeout | Notes |
|---|---|---|---|---|
| `make check` | 0.21s | 2026-07-23 | 30s | Cinnamon runtime behavior also has a manual desktop gate. |
