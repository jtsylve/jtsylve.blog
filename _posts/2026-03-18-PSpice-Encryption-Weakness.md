---
layout: post
title: A Copy-Paste Bug That Broke PSpice® AES-256 Encryption
---

PSpice is a SPICE circuit simulator from Cadence Design Systems that encrypts proprietary semiconductor model files to protect vendor IP and prevent reuse in third-party SPICE simulators.  The encryption scheme is proprietary and undocumented.

Many third-party component vendors distribute SPICE models exclusively as PSpice-encrypted files, locking them to a single simulator and preventing their use in open-source and alternative tools such as [NGSpice](https://ngspice.sourceforge.io/), [Xyce](https://xyce.sandia.gov/), and [PySpice](https://github.com/PySpice-org/PySpice).  As part of research into these encryption schemes, I've released [SpiceCrypt](https://github.com/jtsylve/spice-crypt/) — a Python library and CLI tool that decrypts encrypted SPICE model files, restoring interoperability so engineers can use lawfully obtained models in any simulator.

PSpice supports six encryption modes (0–5).  Modes 0–3 and 5 derive all key material from constants hardcoded in the binary; once those constants are extracted, files in these modes can be decrypted directly.  Mode 4 is the only mode that incorporates user-supplied key material: vendors provide a key string via a CSV file referenced by the `CDN_PSPICE_ENCKEYS` environment variable.  This key is XOR'd with the hardcoded base keys during derivation, so decryption requires the same key file.  A bug in key derivation reduces the effective keyspace to 2^32, making the user key recoverable by brute force in seconds.

### The Bug

Mode 4 uses AES-256 in ECB mode.  Key derivation starts from two base strings:

- `g_desKey`: a 4-byte "short" base key (`"8gM2"`)
- `g_aesKey`: a 27-byte "extended" base key (`"H41Mlwqaspj1nxasyhq8530nh1r"`)

When a user provides a key via the `CDN_PSPICE_ENCKEYS` CSV file, user key bytes 0–3 are XOR'd into the short base, and bytes 4–30 are XOR'd into the extended base.  A version suffix (e.g., `"1002"`) is then appended to each base key.

`PSpiceAESEncoder_setKey` receives only the short key (`g_desKey`), not the extended key (`g_aesKey`).  The 32-byte AES-256 key is constructed by zero-padding this null-terminated string:

```
Byte  0–3:  XOR("8gM2", user_key[0:4])   -- unknown (4 bytes)
Byte  4–7:  "1002"                       -- version suffix (atoi(version_string) + 999)
Byte  8:    0x00 (null terminator)       -- known
Byte  9–31: 0x00 (zero padding)          -- known
```

`EncryptionContext_init` calls `initEncryptionKeys` to derive both keys, then passes only `g_desKey` to the cipher engine via a vtable call:

```
lea     rdx, g_desKey           ; short key loaded as setKey argument
...
call    qword ptr [rax]         ; vtable[0]: setKey(&g_desKey)
```

`PSpiceAESEncoder_setKey` copies this null-terminated string into a zero-filled 32-byte local buffer and calls `AES_keyExpansion(self+8, keyBuf, 256)`.  `g_desKey` in mode 4 is 8 characters (4 XOR'd bytes + `"1002"`) followed by a null terminator, so bytes 9–31 of the AES key are always zero.

Since 28 of 32 key bytes are known, the effective keyspace shrinks from 2^256 to 2^32.

In practice the keyspace is even smaller: since user keys are stored in a CSV file, each byte is almost certainly printable ASCII (`0x20`–`0x7E`), reducing the search space to roughly 95^4 (~81 million candidates).  SpiceCrypt does not exploit this observation — exhausting the full 2^32 space is fast enough that filtering by character class would add complexity without meaningful benefit.

### Brute-Force Attack

The first encrypted block after every `$CDNENCSTART` marker is a metadata header whose plaintext always begins with the fixed prefix `"0001.0000 "` (10 ASCII bytes).  This prefix falls entirely within the first 16-byte AES sub-block, providing a known-plaintext crib for validating candidate keys.

The attack:

1. Take the first 16 bytes of the header ciphertext block.
2. For each of the 2^32 candidate 4-byte values, construct the full 32-byte key (4 candidate bytes + known suffix + zeros) and decrypt the sub-block.
3. If the first 10 bytes of the decrypted sub-block equal `"0001.0000 "`, the candidate is correct.

Exhaustive search of all 2^32 candidates takes seconds with AES-NI, or under 1 second on a GPU.  

SpiceCrypt implements this attack with a hardware-accelerated Rust extension (AES-NI / ARM Crypto Extensions) for key recovery:

```bash
# Brute-force recover the user key (~seconds on modern hardware)
spice-crypt --recover-key encrypted_file.lib

# Decrypt with a known user key
spice-crypt --user-key KEY encrypted_file.lib
```

### Full User Key Recovery

Once the 4-byte brute-force attack succeeds, the full user key is recoverable.  The metadata header's plaintext contains the derived `g_aesKey`: the extended base XOR'd with user key bytes, with the version suffix appended.

1. **Short user key** (bytes 0–3): XOR the recovered 4 bytes with the known base `"8gM2"`.

2. **Extended user key** (bytes 4–30): Decrypt the metadata header with the recovered AES key.  The embedded `g_aesKey` equals `XOR("H41Mlwqaspj1nxasyhq8530nh1r", user_key[4:31]) + "1002"`.  Strip the version suffix and XOR with the known base to recover the remaining 27 user key bytes.

The entire user key string from the CSV file is now known, and all files encrypted with that key are compromised.

### Root Cause

The names `g_desKey` and `g_aesKey` are reverse-engineered labels, not original source names.  The key sizes suggest the extended key was intended for AES and the short key for DES.  The short key is 8 bytes after derivation, matching a DES key size.  The extended key is 31 bytes plus a null terminator to fill 32 bytes, which is likely an off-by-one error since AES-256 requires 32 bytes of key material.  Passing the short key to the AES engine appears to be a copy-paste error from the DES code path.  Had the extended key been used, the effective keyspace would be 2^216, making a brute-force attack infeasible.

AES-256 encryption support was introduced in PSpice 16.6 (April 2014), alongside the existing DES-based modes.  The bug has presumably been present since that release.  Fixing it now would break compatibility with every encrypted model created in the twelve years since its introduction.

### SpiceCrypt

[SpiceCrypt](https://github.com/jtsylve/spice-crypt/) is a tool I've released that handles decryption of all PSpice encryption modes, as well as LTspice encryption formats.  It can be installed from [PyPI](https://pypi.org/project/spice-crypt/):

```bash
pip install spice-crypt
```

All encryption formats are auto-detected:

```bash
# Decrypt any encrypted SPICE model file
spice-crypt encrypted_file.lib

# Decrypt to an output file
spice-crypt -o decrypted.lib encrypted_file.lib
```

SpiceCrypt also provides a Python API for programmatic use:

```python
from spice_crypt import decrypt_stream

plaintext, verification = decrypt_stream("encrypted.lib")
```

Beyond PSpice, SpiceCrypt supports LTspice's text-based DES format and Binary File format.  Full details on all supported formats, the Python API, and the legal basis for this interoperability work are available in the [project README](https://github.com/jtsylve/spice-crypt/).

**Disclaimer:** SpiceCrypt is intended solely for enabling simulator interoperability with lawfully obtained models.  Using it to violate intellectual property rights is immoral and is not an acceptable use of the tool.

---
PSpice is a trademark of Cadence Design Systems, Inc.
