---
layout: post
title: Transparent Compression (DECMPFS)
series: "APFS Internals"
series_part: 17
categories: [file-systems, apfs]
tags: [apfs, compression, decmpfs]
---

APFS supports transparent file compression through the DECMPFS (Decompression File System) framework, shared with HFS+. Compressed files appear normal to applications but store their data in a compressed form on disk, significantly reducing space usage on system volumes. This post covers the on-disk format, compression types, and how to parse compressed files.

## Overview

A compressed file is identified by the `UF_COMPRESSED` BSD flag set in its [inode record](/post/2022/12/16/APFS-Inode-and-Directory-Records). When this flag is present, the file's actual data is stored in either an [extended attribute](/post/2022/12/19/APFS-Data-Streams) named `com.apple.decmpfs` (for small files) or in the file's resource fork (for larger files). The kernel transparently decompresses data on read, so applications never see the compressed form.

## The decmpfs_disk_header

The `com.apple.decmpfs` extended attribute begins with a fixed header:

```cpp
#define DECMPFS_MAGIC 0x636d7066 // 'cmpf'

typedef struct {
    uint32_t compression_magic;  // 0x00
    uint32_t compression_type;   // 0x04
    uint64_t uncompressed_size;  // 0x08
    uint8_t attr_bytes[];        // 0x10
} decmpfs_disk_header;
```
- `compression_magic`: Must equal `DECMPFS_MAGIC` (`0x636d7066`). All fields are little-endian.
- `compression_type`: Identifies the compression algorithm and data location (see below)
- `uncompressed_size`: The original uncompressed file size in bytes (for `DATALESS_PKG_CMPFS_TYPE` this field is reinterpreted: the low 40 bits hold the package size and the upper bits hold a child-entry count)
- `attr_bytes`: Inline compressed data (for xattr-stored types), or empty for resource fork types

The maximum size of the entire `com.apple.decmpfs` extended attribute is 3802 bytes. If the compressed data exceeds this limit, it must be stored in the resource fork.

## Compression Types

{: style="margin-left: 0"}
Type | Algorithm | Location | Notes
-----|-----------|----------|------
1 | None | xattr | Small files stored uncompressed inline
3 | zlib | xattr | Small zlib-compressed files
4 | zlib | resource fork | Larger zlib-compressed files
5 | Dataless | none | Data fetched on demand (iCloud/network)
7 | LZVN | xattr | Fast LZ77 variant (macOS 10.9+)
8 | LZVN | resource fork | Larger LZVN files
9 | None | xattr | Uncompressed variant in LZVN format
10 | None | resource fork | 64KB chunks, uncompressed
11 | LZFSE | xattr | High-efficiency entropy-coded (macOS 10.11+)
12 | LZFSE | resource fork | Larger LZFSE files
13 | LZBITMAP | xattr | Block bitmap compression
14 | LZBITMAP | resource fork | Larger LZBITMAP files

Odd-numbered types (3, 7, 9, 11, 13) store data inline in the extended attribute. Even-numbered types (4, 8, 10, 12, 14) store data in the resource fork.

### Dataless Files

Special compression types represent files whose content is not stored locally:

```cpp
#define DATALESS_CMPFS_TYPE     0x80000001
#define DATALESS_PKG_CMPFS_TYPE 0x80000002
```

These are placeholders for iCloud-synced or network-mounted content. The metadata (size, permissions) exists locally, but the data is fetched on demand.

## Parsing a Compressed File

1. Check the `UF_COMPRESSED` flag (bit 5 of `bsd_flags` in `j_inode_val_t`).
2. Read the `com.apple.decmpfs` extended attribute from the File System Tree.
3. Verify `compression_magic` equals `DECMPFS_MAGIC`.
4. Read `compression_type` to determine the algorithm and data location.
5. Locate the compressed data:
   - **Inline (types 1, 3, 7, 9, 11, 13):** Data follows the header in `attr_bytes`.
   - **Resource fork (types 4, 8, 10, 12, 14):** Data is in the `com.apple.ResourceFork` extended attribute.
6. Decompress using the appropriate algorithm.

## Resource Fork Chunking

Resource fork compression types split data into 65,536-byte (64 KB) chunks. Two chunking schemes exist:

### Scheme v1 (Type 4, zlib)

The resource fork data section begins with a chunk table: an array of `uint32_t` offsets, one per chunk plus a trailing entry. The compressed size of chunk `i` is `offsets[i+1] - offsets[i]`.

### Scheme v2 (Types 8, 10, 12, 14)

The resource fork contains a resource map with type `'cmpf'` (`0x636D7066`). At offset 260, a `uint32_t` chunk count is stored. Starting at offset 264, each chunk is described by an 8-byte entry containing a `uint32_t` offset and `uint32_t` size.

## Interaction with APFS

When the kernel hides extended attributes from userland for compressed files:
- `com.apple.decmpfs` is always hidden
- `com.apple.ResourceFork` is hidden when it contains compression data

This means forensic tools accessing raw APFS structures will see these attributes, but tools going through the VFS layer will not. The `INODE_HAS_UNCOMPRESSED_SIZE` flag (0x40000) in `internal_flags` indicates the inode's `uncompressed_size` field is valid.

On [sealed volumes](/post/2022/12/20/APFS-Sealed-Volumes), compressed data integrity is verified through the sealed volume's hash tree. The `apfs_verify_uncompressed_data` function checks decompressed blocks against expected hashes.

## Forensic Considerations

- Transparent compression is extremely common on macOS system volumes. Most files in `/System` and `/usr` are compressed.
- The reported file size (in the inode) is the _compressed_ size (allocated extents). The _actual_ size is in `uncompressed_size` from the decmpfs header or the inode's extended field.
- Tools that read raw disk data must handle decompression to access file contents.
- The compression type reveals which macOS version created the file: LZVN (10.9+), LZFSE (10.11+), LZBITMAP (macOS 11+).
- Dataless files (types 0x80000001, 0x80000002) indicate cloud-synced content whose data was never stored locally or has been evicted.

## Conclusion

DECMPFS provides transparent, per-file compression that is deeply integrated into APFS through extended attributes and resource forks. Understanding the compression types and chunking schemes is essential for any tool that needs to access file contents on APFS volumes, particularly system volumes where compression is the default.
