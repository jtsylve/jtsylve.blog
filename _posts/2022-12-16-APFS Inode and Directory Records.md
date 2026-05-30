---
layout: post
title: Inode and Directory Records
series: "APFS Internals"
series_part: 14
categories: [file-systems, apfs]
tags: [apfs, inodes, directories]
last_modified_at: 2026-06-01
---

Each APFS [_file system entry_](/post/2022/12/15/APFS-FSTrees) has both an _inode_ and _directory record_. The inode record stores metadata such as the entry’s timestamps, ownership, type, and permissions (among others). Directory records store information about where the entry is stored within the file system’s hierarchy. A single inode may be referenced by more than one directory record, meaning the same file or folder may be present at multiple paths in the file system, as is the case with hard links.

## Inode Records

The first record stored for each _file system entry_ in a _File System Tree_ should be an _inode record_. The key for an inode record only consists of the standard `j_key_t` structure with the "type" identified as `APFS_TYPE_INODE`.

```cpp
// FS-Tree key for inode records
typedef struct j_inode_key {
    j_key_t hdr; // 0x00
} j_inode_key_t; // 0x08
```
- `hdr`: The record's header

The value for an inode record is variable sized to account for any _extended fields_ that may be stored after the record.

```cpp
// Type Aliases
typedef uint16_t mode_t;
typedef uint32_t uid_t;
typedef uint32_t gid_t;
typedef uint32_t cp_key_class_t;

// FS-Tree value for inode records
typedef struct j_inode_val {
    uint64_t parent_id;                      // 0x00 
    uint64_t private_id;                     // 0x08
    uint64_t create_time;                    // 0x10
    uint64_t mod_time;                       // 0x18
    uint64_t change_time;                    // 0x20
    uint64_t access_time;                    // 0x28
    uint64_t internal_flags;                 // 0x30
    union {
        int32_t nchildren;                   // 0x38
        int32_t nlink;                       // 0x38
    };
    cp_key_class_t default_protection_class; // 0x3C
    uint32_t write_generation_counter;       // 0x40
    uint32_t bsd_flags;                      // 0x44
    uid_t owner;                             // 0x48
    gid_t group;                             // 0x4C
    mode_t mode;                             // 0x50
    uint16_t pad1;                           // 0x52
    uint64_t uncompressed_size;              // 0x54
    uint8_t xfields[];                       // 0x5C
} j_inode_val_t;
```
- `parent_id`: The identifier of the file system record for the parent directory
- `private_id`: The unique identifier used by this file's data stream
- `create_time`: The time that this record was created
- `mod_time`: The time that this record was last modified
- `change_time`: The time that this record's attributes were last modified
- `access_time`: The time that this record was last accessed
- `internal_flags`: The inode's flags
- `nchildren`: The number of directory entries
- `nlink`: The number of hard links whose target is this inode
- `default_protection_class`: The default protection class for this inode
- `write_generation_counter`: A monotonically increasing counter that's incremented each time this inode or its data is modified
- `bsd_flags`: The inode's BSD flags
- `owner`: The user identifier of the inode's owner
- `group`: The group identifier of the inode's group
- `mode`: The file's mode
- `pad1`: _reserved_
- `uncompressed_size`: The size of the file without compression
- `xfields`: The inode's _extended fields_

#### Inode Flags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
INODE_IS_APFS_PRIVATE | 0x00000001 | The inode is used internally by an implementation of Apple File System
INODE_MAINTAIN_DIR_STATS | 0x00000002 | The inode tracks the size of all of its children
INODE_DIR_STATS_ORIGIN | 0x00000004 | The inode has the `INODE_MAINTAIN_DIR_STATS` flag set explicitly, not due to inheritance
INODE_PROT_CLASS_EXPLICIT | 0x00000008 | The inode's data protection class was set explicitly when the inode was created
INODE_WAS_CLONED | 0x00000010 | The inode was created by cloning another inode
INODE_WAS_PURGED | 0x00000020 | The inode's extents have been purged (set by background extent remover on purgeable files)
INODE_HAS_SECURITY_EA | 0x00000040 | The inode has an access control list
INODE_BEING_TRUNCATED | 0x00000080 | The inode was truncated
INODE_HAS_FINDER_INFO | 0x00000100 | The inode has a Finder info extended field
INODE_IS_SPARSE | 0x00000200 | The inode has a sparse byte count extended field
INODE_WAS_EVER_CLONED | 0x00000400 | The inode has been cloned at least once
INODE_ACTIVE_FILE_TRIMMED | 0x00000800 | The inode is an overprovisioning file that has been trimmed
INODE_PINNED_TO_MAIN | 0x00001000 | The inode's file content is always on the main storage device
INODE_PINNED_TO_TIER2 | 0x00002000 | The inode's file content is always on the secondary storage device
INODE_HAS_RSRC_FORK | 0x00004000 | The inode has a resource fork
INODE_NO_RSRC_FORK | 0x00008000 | The inode doesn't have a resource fork
INODE_ALLOCATION_SPILLEDOVER | 0x00010000 | The inode's file content has some space allocated outside of the preferred storage tier for that file
INODE_FAST_PROMOTE | 0x00020000 | This inode is scheduled for promotion from slow storage to fast storage
INODE_HAS_UNCOMPRESSED_SIZE | 0x00040000 | This inode stores its uncompressed size in the inode
INODE_IS_PURGEABLE | 0x00080000 | This inode will be deleted at the next purge
INODE_WANTS_TO_BE_PURGEABLE | 0x00100000 | This inode should become purgeable when its link count drops to one
INODE_IS_SYNC_ROOT | 0x00200000 | This inode is the root of a sync hierarchy for `fileproviderd`
INODE_SNAPSHOT_COW_EXEMPTION | 0x00400000 | This inode is exempt from copy-on-write behavior if the data is part of a snapshot
INODE_PROT_CLASS_UPGRADE_ROLLIP | 0x00800000 | Per-file key upgrade rotation is in progress for this inode
INODE_PURGEABLE_MARK_CHILDREN | 0x02000000 | Mark children as purgeable when they are created in this directory
INODE_HAS_SOURCE_PURGE_ID | 0x04000000 | The inode has an `INO_EXT_TYPE_SOURCE_PURGE_ID` extended field
INODE_HAS_ATTRIBUTION_TAG | 0x10000000 | The inode has an attribution tag hash extended field
INODE_MAINTAIN_SPECULATIVE_TELEMETRY | 0x20000000 | This inode participates in speculative telemetry tracking (inherited from parent)
INODE_SPECULATIVE_TELEMETRY_ACTIVE | 0x40000000 | Speculative telemetry is actively recording state transitions for this inode

Three compound flag masks are also useful for understanding flag inheritance:

- `INODE_INHERITED_INTERNAL_FLAGS` (`MAINTAIN_DIR_STATS | SNAPSHOT_COW_EXEMPTION | MAINTAIN_SPECULATIVE_TELEMETRY`): Flags that new inodes inherit from their parent directory.
- `INODE_CLONED_INTERNAL_FLAGS` (`HAS_RSRC_FORK | NO_RSRC_FORK | HAS_FINDER_INFO | SNAPSHOT_COW_EXEMPTION`): Flags that propagate from a source inode to its clone.

## Directory Records

Every folder in the file system will store a _directory record_ for each of its children.  A directory record's key begins with the standard key header with the "type" encoded as `APFS_TYPE_DIR_REC` followed by an encoded hash and name of the directory entry.

```cpp
#define J_DREC_LEN_MASK 0x000003ff
#define J_DREC_HASH_MASK 0xfffffc00
#define J_DREC_HASH_SHIFT 10

// A directory record key
typedef struct j_drec_hashed_key {
    j_key_t hdr;                // 0x00
    uint32_t name_len_and_hash; // 0x08
    uint8_t name[0];            // 0x0C
} j_drec_hashed_key_t;
```
- `hdr`: The record's header
- `name_len_and_hash`: Encodes the length (in bytes, including the trailing null character) of the UTF-8 encoded name in the 10 _least significant bits_ and a 22-bit hash of the name in the upper bits.
- `name`: A null-terminated UTF-8 encoded name of the entry


The value for a directory record is variable sized to account for any _extended fields_ that may be stored after the record.

```cpp
typedef struct j_drec_val {
    uint64_t file_id;    // 0x00
    uint64_t date_added; // 0x08
    uint16_t flags;      // 0x10
    uint8_t xfields[];   // 0x12
} j_drec_val_t;
```
- `file_id`: The identifier of the inode that this directory entry represents
- `date_added`: The time that this directory entry was added to the directory
- `flags`: The directory entry's flags
- `xfields`: The directory entry's _extended fields_

#### Directory Entry Flags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
DREC_TYPE_MASK | 0x000f | Directory Entry Type Mask (see below)
RESERVED_10 | 0x0010 | _reserved_

#### Directory Entry File Types

The four _least significant bits_ of the directory record flags encode the type of the directory entry as defined below.

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
DT_UNKNOWN | 0 | An unknown directory entry
DT_FIFO | 1 | A named pipe
DT_CHR | 2 | A character-special file
DT_DIR | 4 | A directory
DT_BLK | 6 | A block device
DT_REG | 8 | A regular file
DT_LNK | 10 | A symbolic link
DT_SOCK | 12 | A socket
DT_WHT | 14 | A whiteout

## Extended Fields

Both _inode_ and _directory_ records contain an optional set of extended fields that are used to store additional information. To check if a directory entry or inode has extended fields, the structure size can be compared to the recorded size in the table of contents entry for the file-system record. If the recorded size is different from the structure's size, then extended fields are present. 

Both the `j_drec_val_t` and `j_inode_val_t` structures have a field called `xfields` that stores the extended field data. The `xfields` field consists of three parts: an `xf_blob_t` header that indicates the number of extended fields and their size, an array of `x_field_t` instances that provide the type and size of each extended field, and an array of the extended field data itself, which is aligned to eight-byte boundaries.

The `xf_blob_t` header is stored directly after the value structure.

```cpp
// A collection of extended attributes.
typedef struct xf_blob {
    uint16_t xf_num_exts;  // 0x00
    uint16_t xf_used_data; // 0x02
    uint8_t xf_data[];     // 0x04
} xf_blob_t;
```
- `xf_num_exts`: The number of extended fields
- `xf_used_data`: The amount of space (in bytes) used to store the xfields
- `xf_data`: The extended fields

An `x_field_t` array is stored at the end of the `xf_blob_t` header.  There is one entry for each extended field.

```cpp
// An extended field's metadata.
typedef struct x_field {
    uint8_t x_type;  // 0x00
    uint8_t x_flags; // 0x01
    uint16_t x_size; // 0x02
} x_field_t;         // 0x04
```
- `x_type`: The extended field's data type
- `x_flags`: The extended field's flags
- `x_size`: The size, in bytes, of the data stored in the extended field

The data for the extended fields is stored after the `x_field_t` array.  Importantly, this data is stored in the same order as the `x_field_t` array and is aligned on eight-byte boundaries.  The padding bytes are not included in the `x_size` field.  The type of this data depends on the type of the extended field.

#### Extended Field Types (Inode Records)

{: style="margin-left: 0"}
Name | Value | Value Type | Description
-----|-------|------------|------------
INO_EXT_TYPE_SNAP_XID | 1 | `xid_t` | The transaction identifier for a snapshot
INO_EXT_TYPE_DELTA_TREE_OID | 2 | `oid_t` | The virtual object identifier of the file-system tree that corresponds to a snapshot's extent delta list
INO_EXT_TYPE_DOCUMENT_ID | 3 | `uint32_t` | The file's document identifier
INO_EXT_TYPE_NAME | 4 | _UTF-8 string_ | The name of the file
INO_EXT_TYPE_PREV_FSIZE | 5 | `uint64_t` | The file's previous size
INO_EXT_TYPE_RESERVED_6 | 6 | | _reserved_
INO_EXT_TYPE_FINDER_INFO | 7 | _32 bytes_ | Opaque data used by Finder
INO_EXT_TYPE_DSTREAM | 8 | `j_dstream_t` | A data stream
INO_EXT_TYPE_RESERVED_9 | 9 | | _reserved_
INO_EXT_TYPE_DIR_STATS_KEY | 10 | `j_dir_stats_val_t` | Statistics about a directory
INO_EXT_TYPE_FS_UUID | 11 | `uuid_t` | The UUID of a file system that's automatically mounted in this directory
INO_EXT_TYPE_UNRAW_SIZE | 12 | `uint64_t` | The unencrypted (raw) file size for a raw-encrypted inode
INO_EXT_TYPE_SPARSE_BYTES | 13 | `uint64_t` | The number of sparse bytes in the data stream
INO_EXT_TYPE_RDEV | 14 | `uint32_t` | The device identifier for a block- or character-special device
INO_EXT_TYPE_PURGEABLE_FLAGS | 15 | `uint64_t` | The pending purgeable state flags applied when the inode becomes purgeable
INO_EXT_TYPE_ORIG_SYNC_ROOT_ID | 16 | `uint64_t` | The inode number of the sync-root hierarchy that this file originally belonged to
INO_EXT_TYPE_NLINK | 17 | `uint64_t` | A directory's link count (legacy; current volumes store this in `nlink`)
INO_EXT_TYPE_SOURCE_PURGE_ID | 18 | `uint64_t` | The source purge identifier used for purgeable-record lookup (set during clone operations)
INO_EXT_TYPE_ATTRIBUTION_TAG_HASH | 19 | `uint64_t` | A hash of the file's attribution tag (code signing identity)
INO_EXT_TYPE_SPEC_TELEMETRY_STATE | 20 | `uint16_t` | Speculative download telemetry state (legacy; read and removed but never written)
INO_EXT_TYPE_CLONEGROUP_ID | 21 | `uint64_t` | The clone group identifier this inode belongs to
INO_EXT_TYPE_SPEC_TELEMETRY_TRIGGER | 22 | `uint64_t` | Speculative download telemetry trigger information for purgeable files

#### Extended Field Types (Directory Records)

{: style="margin-left: 0"}
Name | Value | Value Type | Description
-----|-------|------------|------------
DREC_EXT_TYPE_SIBLING_ID | 1 | `uint64_t` | The sibling identifier for a directory record
DREC_EXT_TYPE_DIR_GEN_COUNT | 2 | `uint64_t` | The directory generation count for a purgeable directory record

#### Extended Field Flags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
XF_DATA_DEPENDENT | 0x0001 | The data in this extended field depends on the file's data
XF_DO_NOT_COPY | 0x0002 | When copying this file, omit this extended field from the copy
XF_BTREE_TRACKED | 0x0004 | The extended field has an associated tracking record in a separate B-Tree
XF_CHILDREN_INHERIT | 0x0008 | When creating a new entry in this directory, copy this extended field to the new directory entry
XF_USER_FIELD | 0x0010 | This extended field was added by a user-space program
XF_SYSTEM_FIELD | 0x0020 | This extended field was added by the kernel
XF_RESERVED_40 | 0x0040 | _reserved_
XF_RESERVED_80 | 0x0080 | _reserved_

## Directory Statistics

Directories with the `INODE_MAINTAIN_DIR_STATS` flag store a separate _directory statistics record_ (type `APFS_TYPE_DIR_STATS`) in the File System Tree. This record provides aggregate information about the directory and all its descendants.

```cpp
typedef struct j_dir_stats_key {
    j_key_t hdr; // 0x00
} j_dir_stats_key_t; // 0x08
```
- `hdr`: The record's header. The object identifier is the directory's inode number.

```cpp
typedef struct j_dir_stats_val {
    uint64_t num_children; // 0x00
    uint64_t total_size;   // 0x08
    uint64_t chained_key;  // 0x10
    uint64_t gen_count;    // 0x18
} j_dir_stats_val_t;       // 0x20
```
- `num_children`: The total number of files and directories in this directory and its descendants (recursive count)
- `total_size`: The total size, in bytes, of all files in this directory and its descendants. A hard-linked file contributes to `total_size` for each directory it appears in.
- `chained_key`: The parent directory's file-system object identifier. This forms a chain that allows propagating size changes up the directory hierarchy.
- `gen_count`: A monotonically increasing counter incremented each time this directory or its children are modified

The `INODE_DIR_STATS_ORIGIN` flag distinguishes directories that explicitly have stats enabled from those that inherited it. The `chained_key` field allows size and count updates to propagate up the directory tree when files are created, deleted, or resized.

## Directory Record Hash Computation

The `name_len_and_hash` field in `j_drec_hashed_key_t` stores a precomputed hash used for efficient directory entry lookups. This hash is present on all volumes with `APFS_INCOMPAT_CASE_INSENSITIVE` or `APFS_INCOMPAT_NORMALIZATION_INSENSITIVE` set (which includes all default macOS and iOS volumes).

The hash is computed as follows:

1. Start with the filename as a null-terminated UTF-8 string.
2. Normalize the string using canonical decomposition (NFD). If the volume has `APFS_INCOMPAT_NORMALIZATION_INSENSITIVE` set, also apply Unicode case folding during normalization.
3. Represent the normalized filename as a sequence of UTF-32 code points (4 bytes each, little-endian). Do not include the null terminator.
4. Compute the CRC-32C hash of the UTF-32 data with an initial CRC value of `0xFFFFFFFF`.
5. Complement the bits of the hash (XOR with `0xFFFFFFFF`).
6. Keep only the low 22 bits.

This hash enables the B-Tree to quickly narrow down candidate entries without performing full Unicode normalization on every comparison. During lookups, the `name_len_and_hash` field is compared numerically first; only entries with matching hashes proceed to a full byte-by-byte name comparison.

On case-insensitive volumes, two filenames that differ only in case (e.g., `README.md` and `readme.md`) produce the same hash and are treated as the same entry. The case folding in step 2 ensures this.

## Conclusion

Inode and directory records form the core of the APFS file system hierarchy. Together with extended fields and directory statistics, they provide efficient metadata access for both individual files and aggregate directory information.

