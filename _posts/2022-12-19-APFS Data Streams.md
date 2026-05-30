---
layout: post
title: Data Streams
series: "APFS Internals"
series_part: 16
categories: [file-systems, apfs]
tags: [apfs, data-streams, extents]
---

Data in APFS that is too large to store within records is stored elsewhere on disk and referenced by _data streams (`dstreams`)_.  Similar to _non-resident attributes_ in NTFS, APFS data streams manage a set of _extents_ that reference the number and order of blocks on the disk which contain external data.  In this post, we will discuss how _data streams_ are used in APFS to manage one or more [forks](https://en.wikipedia.org/wiki/Fork_(file_system)) of data in inodes as well as their record structures in the [_File System Tree_](/post/2022/12/15/APFS-FSTrees).

## Inode Default Data Streams

Each file has a _default data stream_ that stores what we typically refer to as the file's data. This stream's _object identifier_ may or may not be different from the inode's. It is stored in the `private_id` field of the inode's `j_inode_val_t` structure. Metadata about the default data stream is stored as a `j_dstream_t` structure in an [inode _extended field_](/post/2022/12/16/APFS-Inode-and-Directory-Records) with the type of `INO_EXT_TYPE_DSTREAM`.

```cpp
typedef struct j_dstream {
    uint64_t size;                // 0x00
    uint64_t alloced_size;        // 0x08
    uint64_t default_crypto_id;   // 0x10
    uint64_t total_bytes_written; // 0x18
    uint64_t total_bytes_read;    // 0x20
} j_dstream_t;                     // 0x28
```
- `size`: The size of the logical data (in bytes)
- `alloced_size`: The total space allocated for the data stream (in bytes), including any unused space
- `default_crypto_id`: The default encryption key or tweak used in this data stream
- `total_bytes_written`: The total number of bytes that have been written to this data stream
- `total_bytes_read`: The total number of bytes that have been read from this data stream

The logical _size_ and _allocated size_ of a `dstream` may differ.  The _allocated size_ is always a factor of the container's block size.  If the file contents do not fill up the last block, then the _allocated size_ may be larger than the logical _size_.  APFS also allows `dstreams` to be _sparsely allocated_. Some extent ranges that logically contain all zero-bytes may not be stored on disk.  In these instances, the _allocated size_ may be smaller than the logical _size_ of the stream.

The `default_crypto_id` comes into play when we're dealing with encrypted volumes.  We will discuss more about APFS encryption in a future post.

The `total_bytes_written` and `total_bytes_read` fields are performance counters we can use to determine how often a data stream has been read-from or written-to.  They are only periodically updated, and more research is needed to determine what triggers these values to be flushed to disk.  Both values are allowed to overflow and reset from zero, so their utility for forensic analysis is relatively limited.

## Extended Attributes

Along with the _default data stream_, files in APFS can also contain other [forks](https://en.wikipedia.org/wiki/Fork_(file_system)).  Like in HFS+, these additional data streams are called _extended attributes_ but are similar in concept to _alternate data streams_ in NTFS.

Extended attributes are stored in the _File System Tree_ as records with a type identifier of `APFS_TYPE_XATTR` and the same _object identifier_ as the _inode record_.  The key half of an _extended attribute record_ is a `j_xattr_key_t` structure.

```cpp
typedef struct j_xattr_key {
    j_key_t hdr;       // 0x00
    uint16_t name_len; // 0x08
    uint8_t name[0];   // 0x0A
} j_xattr_key_t;
```
- `hdr`: The record's header
- `name_len`: The length of the extended attribute's name (in bytes), including the final null character.
- `name`: The null-terminated, UTF-8 encoded name of the extended attribute

The value half of the _extended attribute record_ is a `j_xattr_val_t` structure.

```cpp
typedef struct j_xattr_val {
    uint16_t flags;     // 0x00
    uint16_t xdata_len; // 0x02
    uint8_t xdata[0];   // 0x04
} j_xattr_val_t;
```
- `flags`: The extended attribute record's flags
- `xdata_len`: The length of the data in `xdata`. When `XATTR_DATA_EMBEDDED` is set this is the inline data length; when `XATTR_DATA_STREAM` is set this is the size of the `j_xattr_dstream_t` structure (48 bytes), and the logical data size is found in the embedded `j_dstream_t`.
- `xdata`: The extended attribute data or the identifier of a data stream that contains the data

#### Extended Attribute Value Flags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
XATTR_DATA_STREAM | 0x00000001 | The attribute data is stored in a data stream
XATTR_DATA_EMBEDDED | 0x00000002 | The attribute data is stored directly in the record
XATTR_FILE_SYSTEM_OWNED | 0x00000004 | The extended attribute record is owned by the file system
XATTR_RESERVED_8 | 0x00000008 | _reserved_
XATTR_PRIVATE_DSTREAM | 0x00000010 | The data is stored in a private temporary inode's data stream (combined with `XATTR_DATA_STREAM`)

Exactly one of `XATTR_DATA_EMBEDDED` or `XATTR_DATA_STREAM` must be set. The maximum embedded payload size is 3804 bytes (`XATTR_MAX_EMBEDDED_SIZE`); xattrs exceeding this must use a data stream.

Like NTFS attributes, APFS extended attributes that are small enough can store their data directly in the attribute record itself. In these instances, the `XATTR_DATA_EMBEDDED` flag will be set and the stream's data is stored in the `xdata` field.

### Well-Known Extended Attributes

Several extended attribute names have special meaning to APFS:

{: style="margin-left: 0"}
Name | Description
-----|------------
`com.apple.fs.symlink` | Target path for symbolic links (file-system-owned)
`com.apple.fs.firmlink` | Target path for firmlinks (requires entitlement)
`com.apple.fs.altlink` | Alternative symlink target on sealed volumes
`com.apple.decmpfs` | Transparent compression metadata
`com.apple.ResourceFork` | Resource fork data (hidden for compressed files)
`com.apple.fs.cow-exempt-file-count` | Count of COW-exempt files (on root directory)
`com.apple.rootless` | System Integrity Protection flags
`com.apple.system.fs.speculative_telemetry` | Speculative download telemetry (kernel-internal)
`com.apple.BootInfo` | Boot file/directory inode numbers (on root directory)

Instead, when the `XATTR_DATA_STREAM` flag is set, `xdata` stores a `j_xattr_dstream_t` structure.

```cpp
typedef struct j_xattr_dstream {
    uint64_t xattr_obj_id; // 0x00
    j_dstream_t dstream;   // 0x08
};                         // 0x30
```
- `xattr_obj_id`: The object identifier of the extended attribute's data stream
- `dstream`: The metadata of the extended attribute's data stream (see above)

## Data Stream Extents

Except for _Sealed Volumes_ (which we will discuss in the future), the _extents_ of a `dstream` are stored in the volume's _File System Tree_ as a set of records with the type `APFS_TYPE_FILE_EXTENT`.  For streams with non-contiguous data, there will be more than one extent record.

The _file extent record_ keys are of the type `j_file_extent_key_t` and encode the object identifier of the `dstream` in their record header, along with the logical offset of the extent in the stream.

```cpp
typedef struct j_file_extent_key {
    j_key_t hdr;           // 0x00
    uint64_t logical_addr; // 0x08
} j_file_extent_key_t;     // 0x10
```
- `hdr`: The record's header
- `logical_addr`: The offset within the file's data (in bytes) for the data stored in this extent

The value half of a `file extent record` takes the form of a `j_file_extent_val_t` structure and is used to denote the physical location of the extent data on disk.

```cpp
// length and flags masks
#define J_FILE_EXTENT_LEN_MASK 0x00ffffffffffffffULL
#define J_FILE_EXTENT_FLAG_MASK 0xff00000000000000ULL
#define J_FILE_EXTENT_FLAG_SHIFT 56

typedef struct j_file_extent_val {
    uint64_t len_and_flags;  // 0x00
    uint64_t phys_block_num; // 0x08
    uint64_t crypto_id;      // 0x10
} j_file_extent_val_t;       // 0x18
```
- `len_and_flags`: A bit-field encoding the length (in bytes) of the extent in the 56 _least significant bits_ and its flags in the _most significant bits_
- `phys_block_num`: The physical block number of the first block in the extent
- `crypto_id`: The encryption key or tweak used in this extent (or zero if not encrypted)

The eight _most significant bits_ of the `len_and_flags` field encode flags. Two flags are currently defined:

#### File Extent Flags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
FEXT_CRYPTO_ID_IS_TWEAK | 0x01 | The `crypto_id` field contains a tweak value rather than a crypto state object identifier. Set when the volume uses single-key encryption (`APFS_FS_ONEKEY`).
FEXT_ALLOCATED_UNWRITTEN | 0x02 | The extent's physical blocks are allocated but have not yet been written with user data. Reading these blocks returns zeroes. Cleared once data is written.

If the value of `phys_block_num` is zero, then the extent is _sparse_ and should be interpreted as containing all zero bytes.

The `crypto_id` field is specific to encrypted volumes. For volumes using single-key encryption, it contains the AES-XTS tweak value. For per-file encryption, it matches the object identifier of the `j_crypto_val_t` record that describes the encryption state. New extents inherit their `crypto_id` from the `default_crypto_id` field of the containing `j_dstream_t`.

## Physical Extent Records

While _file extent records_ describe which blocks belong to a specific file, APFS also maintains _physical extent records_ that track ownership and reference counting at the physical block level. These records have the type `APFS_TYPE_EXTENT` and use the physical block address as their object identifier.

```cpp
typedef struct j_phys_ext_key {
    j_key_t hdr; // 0x00
} j_phys_ext_key_t;  // 0x08
```
- `hdr`: The record's header. The object identifier is the physical block address of the start of the extent.

```cpp
#define PEXT_LEN_MASK  0x0fffffffffffffffULL
#define PEXT_KIND_MASK 0xf000000000000000ULL
#define PEXT_KIND_SHIFT 60

typedef struct j_phys_ext_val {
    uint64_t len_and_kind;   // 0x00
    uint64_t owning_obj_id;  // 0x08
    int32_t refcnt;          // 0x10
} j_phys_ext_val_t;          // 0x14
```
- `len_and_kind`: A bit-field encoding the extent length in blocks (lower 60 bits via `PEXT_LEN_MASK`) and its kind (upper 4 bits via `PEXT_KIND_MASK`)
- `owning_obj_id`: The identifier of the data stream that owns this extent. For a file's primary data stream, this is the inode's `private_id`. For an extended attribute's data stream, this is the `xattr_obj_id`.
- `refcnt`: The reference count for this extent. The extent's physical blocks can be freed when this count reaches zero.

The `kind` field indicates the extent's relationship to snapshots. On a volume with no snapshots, the kind is always `APFS_KIND_NEW`. When snapshots exist, the kind helps determine whether an extent is shared with a snapshot and whether copy-on-write is needed.

## Data Stream Identifiers

APFS uses _data stream identifier records_ (type `APFS_TYPE_DSTREAM_ID`) to track how many inodes share the same set of file extents. This is the mechanism that enables efficient file cloning.

```cpp
typedef struct j_dstream_id_key {
    j_key_t hdr; // 0x00
} j_dstream_id_key_t; // 0x08
```
- `hdr`: The record's header. The object identifier matches the data stream's `private_id`.

```cpp
typedef struct j_dstream_id_val {
    uint32_t refcnt; // 0x00
} j_dstream_id_val_t; // 0x04
```
- `refcnt`: The reference count for this data stream. Tracks how many inodes share the same `private_id` (and thus the same set of file extents).

When a file is cloned, the clone's `private_id` is set to the source's `private_id`, and this reference count is incremented. No file extent records are copied; both inodes share the same extents until one is modified. When the count transitions from 2 to 1, the sole remaining owner no longer needs copy-on-write semantics for that data stream.

## Copy-on-Write Semantics

Cloning a file in APFS (via `cp --clone` or the `clonefile` syscall) creates a new inode that shares all data extents with the source. Both the `INODE_WAS_CLONED` and `INODE_WAS_EVER_CLONED` flags are set on both files. The `j_dstream_id_val_t` reference count is incremented, but no physical data is duplicated.

When a file with shared extents (`refcnt > 1` in its `j_phys_ext_val_t`) is subsequently modified:

1. New physical blocks are allocated for the modified range.
2. A new `j_file_extent_val_t` is created pointing to the new blocks.
3. A new `j_phys_ext_val_t` is created with `refcnt = 1`.
4. The original `j_phys_ext_val_t`'s `refcnt` is decremented.
5. If the original extent's `refcnt` reaches zero, its physical blocks are freed.

This means that after cloning, only the blocks that are actually modified require additional storage. Unmodified blocks remain shared between both files indefinitely (or until freed by both). The `INODE_WAS_EVER_CLONED` flag is never cleared once set, ensuring the file system always checks reference counts during writes to that inode, even if the clone is later deleted.

On encrypted volumes with per-file keys, the clone initially receives a `crypto_id` of `APFS_UNASSIGNED_CRYPTO_ID` (`~0ULL`), meaning it continues using the original file's encryption state. If the clone is later modified, a new encryption state object is created for it with its own key.

## Conclusion

Understanding _data streams_ and their on-disk structures is essential to analyzing APFS. This post discussed the _default data stream_, _extended attributes_, _file extents_, _physical extent records_ with reference counting, _data stream identifiers_, and the copy-on-write mechanics that enable efficient file cloning. Later in this series, we will discuss how parsing this information differs in both _Sealed_ and _Encrypted_ volumes.

