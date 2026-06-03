---
layout: post
title: "SpiceCrypt 3.0: QSPICE Support"
categories: [security-research, encryption]
tags: [qspice, spice, reverse-engineering, encryption, interoperability]
---

[SpiceCrypt 3.0.0](https://github.com/jtsylve/spice-crypt/) is out.  When I [introduced SpiceCrypt in March](/post/2026/03/18/PSpice-Encryption-Weakness), it decrypted PSpice and LTspice model files so engineers could use lawfully obtained models in any simulator.  This release adds QSPICE, the protection scheme used by Qorvo's simulator, and with it SpiceCrypt now spans the three most widely used SPICE tools in a single auto-detecting library and tool.

## What's new

- **QSPICE `.prot` decryption.**  SpiceCrypt now decrypts QSPICE protected sub-circuits: randomized base-16 encoding, a seed-keyed dual stream cipher, DEFLATE decompression, and Windows-1252 detokenization.  Surrounding plaintext lines pass through untouched.  The full reverse-engineered scheme is documented in [`SPECIFICATIONS/qspice.md`](https://github.com/jtsylve/spice-crypt/blob/master/SPECIFICATIONS/qspice.md).
- **Unified auto-detection.**  `decrypt_stream()` and `decrypt()` now auto-detect across Binary File, PSpice, QSPICE, and LTspice formats.  Point SpiceCrypt at a file and it picks the right scheme.
- **New public API.**  `QSpiceFileParser` and `QSpiceCipher` are now exported for callers that want to work with QSPICE directly.
- **Block-count reporting.**  Since a single file can hold many protected sub-circuits, `decrypt_stream()` now returns the block count for QSPICE inputs.
- **Graceful degradation.**  A protected block that fails to decode now passes through unchanged with a warning instead of aborting the whole file.

## Breaking changes

The deprecated v2.0.0 backward-compatibility shims have been removed: the top-level `des.py`, `binary_file.py`, and `crypto_state.py` modules are gone.  Import the LTspice internals directly instead:

```python
from spice_crypt.ltspice import ...
```

The CLI and the primary `decrypt` / `decrypt_stream` entry points are unchanged.

## Upgrading

```bash
pip install --upgrade spice-crypt
```

Or with uv:

```bash
uv tool install --upgrade spice-crypt
```

## Links

- **Repository**: [github.com/jtsylve/spice-crypt](https://github.com/jtsylve/spice-crypt)
- **PyPI**: [pypi.org/project/spice-crypt](https://pypi.org/project/spice-crypt/)
- **QSPICE specification**: [SPECIFICATIONS/qspice.md](https://github.com/jtsylve/spice-crypt/blob/master/SPECIFICATIONS/qspice.md)

If you run into issues or have feature requests, please [open an issue](https://github.com/jtsylve/spice-crypt/issues) on GitHub.

**Disclaimer:** SpiceCrypt is intended solely for enabling simulator interoperability with lawfully obtained models.  Using it to violate intellectual property rights is immoral and is not an acceptable use of the tool.
