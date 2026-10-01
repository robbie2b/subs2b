# Subsync benchmark

Tools to check the alignment engine (`src/utils/subsync.ts`) against ffsubsync, the reference implementation of the idea.
Nothing here is part of the addon. The corpus contains subtitle text: keep it outside the repository.

1. **Collect** a corpus from a deployed subs2b (candidates in one language, timing references in other languages):
   `SUBS2B_UUID=<uuid> npx tsx experiments/subsync/benchmark/collect.ts <workDir>/corpus`
2. **Run ffsubsync** on every pair in Docker (needs Docker; installs ffsubsync from PyPI inside a throw-away container):
   `docker run --rm -v <workDir>:/data python:3.12-slim sh /data/bench.sh` (copy `bench.sh` into `<workDir>` first)
3. **Compare**: `npx tsx experiments/subsync/benchmark/eval.ts <workDir>`
4. **Decision pipeline** (several references, agreement check, timing): `npx tsx experiments/subsync/benchmark/gate.ts <workDir>`

Results of the first run (2026-10-01, ffsubsync 0.5.1; mean hit rate, 57 pairs): original 36 %, engine 72 % (one shift + ratio)
and 77 % (with split), ffsubsync 72 % and 77 %. Speed: engine 20-100 ms per alignment; ffsubsync ~2 s at 1 CPU, 16 s at 0.1 CPU.
