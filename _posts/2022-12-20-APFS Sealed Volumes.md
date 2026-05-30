---
layout: post
title: Sealed Volumes
series: "APFS Internals"
series_part: 13
categories: [file-systems, apfs]
tags: [apfs, sealed-volumes, integrity]
---

With the release of macOS 11, Apple added a security feature to APFS called _sealed volumes_.  Sealed volumes can be used to cryptographically verify the contents of the read-only _system_ volume as an additional layer of protection against rootkits and other malware that may attempt to replace critical components of the operating system.  Sealed volumes have subtle differences from some of the properties of file systems that we've discussed so far.

## Identifying a Sealed Volume

Sealed volumes can be identified by checking for the `APFS_INCOMPAT_SEALED_VOLUME` flag in the `apfs_incompatible_features` field of their [_Volume Superblock_](/post/2022/12/13/APFS-Volume-Superblock).  In addition, the `apfs_integrity_meta_oid` and `apfs_fext_tree_oid` fields must have non-zero values.

An _Integrity Metadata Object_ stores information about the sealed volume.  This is a virtual object that is owned by the volume's [_Object Map_](/post/2022/12/12/APFS-OMAP) and whose _object identifier_ can be found in the `apfs_integrity_meta_oid` field of the Volume Superblock.  On disk, it is stored as an `integrity_meta_phys_t` structure.

```cpp
typedef struct integrity_meta_phys {
    obj_phys_t im_o;               // 0x00
    uint32_t im_version;           // 0x20
    uint32_t im_flags;             // 0x24
    apfs_hash_type_t im_hash_type; // 0x28
    uint32_t im_root_hash_offset;  // 0x2C
    xid_t im_broken_xid;           // 0x30
    uint64_t im_reserved[9];       // 0x38
} integrity_meta_phys_t;           // 0x80
```
- `im_o`: The object's header
- `im_version`: The version of the data structure
- `im_flags`: The configuration flags
- `im_hash_type`: The hash algorithm that is used
- `im_root_hash_offset`: The offset (in bytes) of the root hash relative to the start of the object
- `im_broken_xid`: The identifier of the transaction that unsealed the volume
- `im_reserved`: _reserved_ (_only in version 2 or above_)

#### Integrity Metadata Flags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
APFS_SEAL_BROKEN | 0x00000001 | The volume was modified after being sealed, breaking its seal

#### Hash Types

{: style="margin-left: 0"}
Name | Value | Digest Size | Description
-----|-------|-------------|------------
APFS_HASH_INVALID | 0 | n/a | An invalid hash algorithm
APFS_HASH_SHA256 | 0x1 | 32 bytes | SHA-256 (default)
APFS_HASH_SHA512_256 (deprecated) | 0x2 | 32 bytes | SHA-512/256 (deprecated; use type 0x5 instead)
APFS_HASH_SHA384 | 0x3 | 48 bytes | SHA-384
APFS_HASH_SHA512 | 0x4 | 64 bytes | SHA-512
APFS_HASH_SHA512_256 | 0x5 | 32 bytes | SHA-512/256 (replacement for deprecated type 0x2)
APFS_HASH_SHA3_256 | 0x6 | 32 bytes | SHA3-256
APFS_HASH_SHA3_384 | 0x7 | 48 bytes | SHA3-384
APFS_HASH_SHA3_512 | 0x8 | 64 bytes | SHA3-512

Hash type 0x2 (`SHA512_256`) is deprecated and rejected during validation. The validation check `(hash_type & 0xFD) != 0` rejects both type 0 (invalid) and type 2 (deprecated).

## File System Tree

_Sealed Volumes_ verify integrity by hashing the contents of their [_File System Trees_](/post/2022/12/15/APFS-FSTrees).  This hashing necessitates some slight differences to the B-Tree. These modified B-Trees can be identified by the `BTREE_HASHED` and `BTREE_NOHEADER` flags being set in their [_B-Tree Info_](/post/2022/12/08/APFS-BTrees).

In standard B-Trees, _non-leaf nodes_ store the object identifier of their children in the value-half of their entries.  "Hashed" B-Trees instead use `btn_index_node_val_t` structures for this purpose, which store the cryptographic hash of the child node's contents along with its identifier.  Hashed nodes are also stored as _headerless_ objects, with their 32-byte header being zeroed out.

```cpp
#define BTREE_NODE_HASH_SIZE_MAX 64

typedef struct btn_index_node_val {
    oid_t binv_child_oid;                              // 0x00
    uint8_t binv_child_hash[BTREE_NODE_HASH_SIZE_MAX]; // 0x08
} btn_index_node_val_t;                                // 0x48
```
- `binv_child_oid`: The _object identifier_ of the child node
- `binv_child_hash`: The hash of the child node

## Data Stream Extents

As we discussed yesterday, [_Data Streams_](/post/2022/12/19/APFS-Data-Streams) store their extents as _file system records_ in the File System Tree.  Sealed Volumes store extents in a separate _File Extent Tree_, whose _virtual object identifier_ is stored in the `apfs_fext_tree_oid` of the Volume Superblock.

The key-half of the File Extent Tree entries are `fext_tree_key_t` structures and are sorted first by `private_id` and then by `logical_addr`.

```cpp
typedef struct fext_tree_key {
    uint64_t private_id;   // 0x00
    uint64_t logical_addr; // 0x08
} fext_tree_key_t;         // 0x10
```
- `private_id`: The object identifier of the file
- `logical_addr`: The offset (in bytes) within the file's data for the data stored in this extent

The value-half takes the form of a `fext_tree_val_t` structure.  Its fields are interpreted in the same way as the `j_file_extent_val` fields.  There is no `crypto_id` because sealed system volumes are never encrypted.

```cpp
typedef struct fext_tree_val {
    uint64_t len_and_flags;  // 0x00
    uint64_t phys_block_num; // 0x08
} fext_tree_val_t;           // 0x10
```
- `len_and_flags`: A bit field that contains the length of the extent and its flags
- `phys_block_num`: The starting physical block address of the extent

## Root Hash Verification

At mount time, the sealed volume's integrity is verified by comparing the on-disk root hash against a known-good value supplied by the boot chain:

1. The system checks whether root hash authentication is required based on the volume role and system configuration.
2. If the seal is broken (`APFS_SEAL_BROKEN` is set in `im_flags`), the mount is rejected with `EAUTH` (error 80) when authentication is required.
3. The root hash payload contains block-size-specific root hashes. The appropriate hash is selected based on the device's block size: 4 KiB blocks use offset +16, 8 KiB blocks use offset +80, and 16 KiB blocks use offset +144.
4. The selected hash is compared against the on-disk root hash stored at `im_root_hash_offset` within the integrity metadata object. This offset must be at least 0x30 (48 bytes) and is typically set to 0x80 (128 bytes).
5. If the hashes match, the volume is verified. If they do not match and authentication is required, the system boots to recovery mode.

Because the hashed B-Tree functions as a Merkle tree, the root hash transitively verifies every node in the File System Tree. Modifying any leaf node changes its hash, which propagates up through every ancestor node to the root.

## Seal Breaking

When a sealed volume is modified (for example, during a system update), the seal is broken:

1. `APFS_SEAL_BROKEN` (bit 0) is set in `im_flags`.
2. If `im_version` is 2 or above, the current transaction identifier is stored in `im_broken_xid`.
3. The volume's verification flag is cleared.

To restore a broken seal, the implementation verifies that `im_version >= 2` and that the file system root tree has not been modified since the seal was broken (the root tree's maximum transaction identifier must be less than `im_broken_xid`). If both conditions hold, `APFS_SEAL_BROKEN` is cleared and `im_broken_xid` is zeroed.

## File Info Records

Sealed volumes also use _file info records_ (type `APFS_TYPE_FILE_INFO`) to store per-extent data hashes and attribution tags. These records enable verification of individual file data blocks without re-hashing the entire tree.

```cpp
typedef struct j_file_info_key {
    j_key_t hdr;           // 0x00
    uint64_t info_and_lba; // 0x08
} j_file_info_key_t;       // 0x10
```
- `hdr`: The record's header (type `APFS_TYPE_FILE_INFO`)
- `info_and_lba`: The physical block address (lower 56 bits) and record type (upper 8 bits)

Two record types exist:

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
APFS_FILE_INFO_DATA_HASH | 1 | A hash of the file's data at a specific extent
APFS_FILE_INFO_ATTRIBUTION_TAG | 2 | A code-signing attribution tag

Data hash values store the hash of a segment of file data:

```cpp
typedef struct j_file_data_hash_val {
    uint16_t hashed_len; // 0x00
    uint8_t hash_size;   // 0x02
    uint8_t hash[];      // 0x03
} j_file_data_hash_val_t;
```
- `hashed_len`: The length of the hashed data segment, in blocks
- `hash_size`: The length of the hash in bytes (must match the digest size for `im_hash_type`)
- `hash`: The hash data

## Conclusion

Sealed Volumes in APFS provide an extra layer of security by allowing macOS to verify its system volume cryptographically. The Merkle-tree-like hashed B-Tree structure, combined with root hash verification at mount time and per-extent data hashes, ensures that any modification to the system volume is detectable. Understanding seal breaking, hash verification, and the additional file info records is essential for analyzing sealed system volumes.

