# JUKAN Auto Book Worker

Public compute-only worker for JUKAN's self-growing opening book.

This repository intentionally contains **no JUKAN private application source, no user data, and no Supabase service-role key**. GitHub Actions authenticates to the private Auto Book gateway with GitHub OIDC, claims one queued position, runs a pinned Rapfi verification, submits the result, and exits.

- JUKAN application/data remain private.
- Backend task details remain administrator-only.
- Normal users do not see verification jobs or timing information.
- Rapfi source is fetched from the upstream GPLv3 project at a pinned commit during the workflow run.
- Rapfi networks are fetched from the pinned upstream `rapfi-networks` submodule commit.

Pinned engine source used by v1: `dhbloo/rapfi@1be1551ced57e38d53ed58f6d74bf6f8b4bdc230`.
