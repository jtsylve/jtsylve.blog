---
layout: post
title: 2022 APFS Advent Challenge Day 13 - Data Streams
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
- `xdata_len`: The length of the extended attribute's inline data
- `xdata`: The extended attribute data or the identifier of a data stream that contains the data

#### Extended Attribute Value Flags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
XATTR_DATA_STREAM | 0x00000001 | The attribute data is stored in a data stream
XATTR_DATA_EMBEDDED | 0x00000002 | The attribute data is stored directly in the record
XATTR_FILE_SYSTEM_OWNED | 0x00000004 | The extended attribute record is owned by the file system
XATTR_RESERVED_8 | 0x00000008 | _reserved_

Like NTFS attributes, APFS extended attributes that are small enough can store their data directly in the attribute record itself.  In these instances, the `XATTR_DATA_EMBEDDED` flag will be set and the stream's data is stored in the `xdata` field.

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

The eight _most significant bits_ of the `len_and_flags` field are reserved for flags, but no flags are currently defined.  

If the value of `phys_block_num` is zero, then the extent is _sparse_ and should be interpreted as containing all zero bytes.

The `crypto_id` field is specific to encrypted volumes and will be discussed in a future post.

## Conclusion

Understanding _data streams_ and their on-disk structures is essential to analyzing APFS.  This post discussed the _default data stream_, _extended attributes_, and _file extents_.  Later this week, we will discuss how parsing this information differs in both _Sealed_ and _Encrypted_ volumes.

{% include advent2022.html %}