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

## Conclusion

In this post, we discussed using the wrapped keys stored in APFS Keybags to gain access to the _Volume Encryption Key_ that protects a user's data in APFS. Tomorrow, we will conclude our discussion about APFS encryption by describing how to identify and decrypt protected information using these keys.

