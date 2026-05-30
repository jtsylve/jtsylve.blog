---
layout: post
title: Wrapped Keys
series: "APFS Internals"
series_part: 15
categories: [file-systems, apfs]
tags: [apfs, wrapped-keys, encryption]
---

In our last post, we discussed both [Volume and Container Keybags](/post/2022/12/21/APFS-Keybags) and how they protect wrapped _Volume Encryption_ and _Key Encryption Keys_. Depending on whether the encrypted volume was migrated from an HFS+ encrypted [Core Storage](https://en.wikipedia.org/wiki/Core_Storage) volume, there are subtle differences in how these keys are used. In this post, we will discuss the structure of these wrapped keys and how they can be used to access the raw _Volume Encryption Keys_ that encrypt data on the file system.

## Key Encryption Key Blobs

Each _Key Encryption Key_ (`KEK`) is encoded in a binary [DER](https://en.wikipedia.org/wiki/X.690#DER_encoding) blob with the following structure:

```asn1
KEKBLOB ::= SEQUENCE {
    unknown [0] INTEGER
    hmac    [1] OCTET STRING
    salt    [2] OCTET STRING
    keyblob [3] SEQUENCE {
        unknown     [0] INTEGER
        uuid        [1] OCTET STRING 
        flags       [2] INTEGER
        wrapped_key [3] OCTET STRING
        iterations  [4] INTEGER
        salt        [5] OCTET STRING
    }
}
```

The keys begin with a header that contains an `HMAC-SHA256` hash of the _key blob_ data. The HMAC key is generated from the `SHA-256` hash of a magic value concatenated with the given salt.

```go
hmac_key := SHA256("\x01\x16\x20\x17\x15\x05" + salt)
```

The _key blob_ encodes the wrapped `KEK` and additional information needed for unwrapping, including a set of bit-flags.

#### KEK Flags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
KEK_FLAG_CORESTORAGE |  0x00010000'0000000000 | Key is a legacy CoreStorage `KEK`
KEK_FLAG_HARDWARE | 0x00020000'0000000000 | Key is hardware encrypted

If the `KEK_FLAG_CORESTORAGE` flag is set, then the wrapped KEK was migrated from a Core Storage encrypted HFS+ volume and used a 128-bit key to encrypt the KEK; otherwise, a 256-bit key is used.

Generate a key using the `PBKDF2-HMAC-SHA256` algorithm, the user's password, the provided salt, and the number of iterations.

```go
// Calculate size of wrapping key (in bytes)
key_size := (flags & KEK_FLAG_CORESTORAGE) ? 16 : 32

// Generate unwrapping key from user's password
key := pbkdf2_hmac_sha256(password, salt, iterations, key_size)

// Unwrap the encrypted KEK
kek := rfc3394_unwrap(key, wrapped_key);
```

If the encrypted volume was migrated from Core Storage and the user changed their password afterward, it's possible to have a non-Core-Storage wrapped `KEK` containing only a 128-bit key. In these instances, the last 128 bits of the unwrapped `KEK` will be zeros and should be ignored.

```go
// Shorten the KEK if needed
if is_zeroed(kek[16:]) {
    kek = kek[:16];
}
```

## Volume Encryption Key Blobs

_Volume Encryption Key_ (`VEK`) blobs have a very similar structure to the `KEK` blobs that we just discussed. Depending on whether they were migrated from Core Storage, they can also be 128-bit or 256-bit keys.

```asn1
VEKBLOB ::= SEQUENCE {
    unknown [0] INTEGER
    hmac    [1] OCTET STRING
    salt    [2] OCTET STRING
    keyblob [3] SEQUENCE {
        unknown     [0] INTEGER
        uuid        [1] OCTET STRING
        flags       [2] INTEGER
        wrapped_key [3] OCTET STRING
    }
}
```

#### VEK Flags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
VEK_FLAG_CORESTORAGE |  0x00010000'0000000000 | Key is a legacy CoreStorage `VEK`
VEK_FLAG_HARDWARE | 0x00020000'0000000000 | Key is hardware encrypted

Use the `KEK` to unwrap the `VEK` using the `RFC3394` key wrapping algorithm. If the wrapped `VEK` is a 128-bit Core Storage `VEK`, then only the first 128-bits of the `KEK` are used.

```cpp
// Calculate size of wrapping key (in bytes)
vek_size = (flags & VEK_FLAG_CORESTORAGE) ? 16 : 32;

if (vek_size == 16) {
    kek = kek[:16];
}

// Unwrap the VEK
vek = rfc3394_unwrap(vek, wrapped_key)
```

128-bit Core Storage `VEKs` must be extended to 256-bit encryption keys. This is accomplished by using the first 128 bits of the `SHA256` hash of the `VEK` and its UUID as the second half of the key.

```go
// 128-bit veks need to be combined with the first 128-bits of a hash
if vek_size == 16 {
    vek = append(vek, SHA256(vek + uuid)[16:])
}
```

## RFC 3394 Key Unwrapping

Both KEK and VEK unwrapping use the [RFC 3394](https://www.rfc-editor.org/rfc/rfc3394) AES Key Wrap algorithm. This algorithm provides authenticated key transport: if the wrapping key is wrong or the wrapped data is corrupted, the unwrap will fail with a detectable integrity error.

The algorithm operates on 64-bit blocks:
1. The wrapped key is split into `n` 64-bit blocks. The first block is the _integrity check value_ (ICV) and the remaining blocks are the key material.
2. Over 6 rounds (each iterating through all key blocks), the algorithm applies AES decryption with XOR operations that mix a round counter into the data.
3. After all rounds, the ICV must equal `0xA6A6A6A6A6A6A6A6`. If it does not, the wrapping key was incorrect or the data is corrupted.

The wrapped key is always 8 bytes longer than the unwrapped key (the ICV overhead). So a 256-bit (32-byte) key is stored as a 40-byte wrapped blob, and a 128-bit (16-byte) key as a 24-byte wrapped blob.

## Per-File Encryption State

On volumes with per-file encryption (not single-key mode), each file's encryption state is stored in a `wrapped_crypto_state_t` structure within `APFS_TYPE_CRYPTO_STATE` records in the [File System Tree](/post/2022/12/15/APFS-FSTrees):

```cpp
typedef struct wrapped_crypto_state {
    uint16_t major_version;             // 0x00
    uint16_t minor_version;             // 0x02
    uint32_t cpflags;                   // 0x04
    uint32_t persistent_class;          // 0x08
    uint32_t key_os_version;            // 0x0C
    uint16_t key_revision;              // 0x10
    uint16_t key_len;                   // 0x12
    uint8_t persistent_key[];           // 0x14
} wrapped_crypto_state_t;
```
- `major_version`: Currently 5
- `minor_version`: Currently 0
- `cpflags`: Crypto flags (`CP_RAW_KEY_WRAPPEDKEY` = 0x01 indicates a SEP-wrapped hardware key)
- `persistent_class`: The file's [protection class](/post/2022/12/21/APFS-Keybags) (1-7)
- `key_os_version`: The OS version that created this key, packed as major/minor/build
- `key_revision`: Key revision counter (incremented on re-wrap)
- `key_len`: Length of the wrapped key data in bytes (max 128)
- `persistent_key`: The RFC 3394-wrapped per-file key

The `persistent_class` determines when the key is available for unwrapping (see [Protection Classes](/post/2022/12/21/APFS-Keybags)). The `key_os_version` is encoded as a packed integer: `(major << 24) | (minor << 16) | build`.

On single-key volumes (`APFS_FS_ONEKEY`), per-file crypto state records do not exist. Instead, all files use the volume-level VEK with per-extent tweaks.

## Conclusion

In this post, we discussed using the wrapped keys stored in APFS Keybags to gain access to the _Volume Encryption Key_ that protects a user's data in APFS. The RFC 3394 algorithm provides authenticated unwrapping, while the `wrapped_crypto_state_t` structure enables per-file encryption with individual protection classes. In a the next post in this series, we will continue our discussion about APFS encryption by describing how to identify and decrypt protected information using these keys.

