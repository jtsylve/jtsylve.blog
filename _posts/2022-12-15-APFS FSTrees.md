---
layout: post
title: File System Trees
series: "APFS Internals"
series_part: 13
categories: [file-systems, apfs]
tags: [apfs, fstrees, volumes]
last_modified_at: 2026-06-01
---

Each APFS volume has a logical file system stored on disk as a collection of File System Objects. Unlike other [APFS Objects](/post/2022/12/01/Anatomy-of-an-APFS-Object), File System Objects consist of one or more File System Records, which are stored in the volume’s File System Tree (FS-Tree). Each record stores specific information about a file or directory. Analyzing each record and associating them with other records with the same identifier gives a complete picture of the file system entry. This post will discuss how these records are organized in the volume's FS-Tree.

## Overview

The File System Tree is a specialized B-Tree that differs in several ways from the other trees that we’ve discussed so far:

1. FS-Trees are _virtual_ B-Trees. Each node in the tree is a _virtual object_ owned by the Volume’s [_Object Map_](/post/2022/12/12/APFS-OMAP). This means that querying the FS-Tree requires using the Object Map to locate each node.

2. FS-Tree nodes can be optionally encrypted. (We will discuss encryption in a future post.)  This allows for select volumes to encrypt not only their files' contents but their metadata as well.

3. FS-Trees store a heterogeneous set of records -- multiple types of keys and values are stored in the same tree.

One advantage of being _virtual_ trees is that FS-Trees can take full advantage of the Object Map’s snapshotting capabilities to restore their state to previous points in time. Apple also uses the snapshots to compare an FS-Tree with an earlier version of itself to create deltas for [Time Machine](https://en.wikipedia.org/wiki/Time_Machine_(macOS)) backups.


### Keys

 Because FS-Trees have multiple key types, they require a way to identify record types. All keys begin with a common structure for this purpose. Specific types may add additional fields to their keys.

```cpp
#define OBJ_ID_MASK 0x0fffffff'ffffffff
#define OBJ_TYPE_MASK 0xf0000000'00000000
#define OBJ_TYPE_SHIFT 60

typedef struct j_key {
    uint64_t obj_id_and_type;
} j_key_t;
```
- `obj_id_and_type`: A bit field that encodes the record's _object identifier_ (in the 60 _least-significant bits_) and _type_ (in the four _most-significant bits_).

Keys are ordered first by an _object identifier_ and then by _type_. A File System Object’s records will be stored together sequentially. Search the FS-Tree for the first record with a given identifier and then enumerate subsequent records until reaching one with a different ID.

### Reserved Inode Numbers

Several inode numbers are reserved for special purposes:

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
INVALID_INO_NUM | 0 | Invalid (no inode)
ROOT_DIR_PARENT | 1 | Sentinel parent ID for the root directory (not an actual inode)
ROOT_DIR_INO_NUM | 2 | The volume’s root directory
PRIV_DIR_INO_NUM | 3 | The private directory (`private-dir`), used for implementation-specific bookkeeping
SNAP_DIR_INO_NUM | 6 | Snapshot metadata directory
PURGEABLE_DIR_INO_NUM | 7 | Purgeable file references (reserved, no actual directory)
MIN_USER_INO_NUM | 16 | First inode number available for user content

All inode numbers below 16 are reserved. On system volumes in a volume group, these same numbers are offset by `UNIFIED_ID_SPACE_MARK` (`0x0800000000000000`).

## File System Record Types

Below is a table of the documented File System Record Types.  We will discuss the on-disk format of each record type soon.

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
APFS_TYPE_SNAP_METADATA | 1 | Metadata about a snapshot
APFS_TYPE_EXTENT | 2 | A physical extent record
APFS_TYPE_INODE | 3 | An inode
APFS_TYPE_XATTR | 4 | An extended attribute
APFS_TYPE_SIBLING_LINK | 5 | A mapping from an inode to hard links
APFS_TYPE_DSTREAM_ID | 6 | A data stream
APFS_TYPE_CRYPTO_STATE | 7 | A per-file encryption state
APFS_TYPE_FILE_EXTENT | 8 | A physical extent record for a file
APFS_TYPE_DIR_REC | 9 | A directory entry
APFS_TYPE_DIR_STATS | 10 | Information about a directory
APFS_TYPE_SNAP_NAME | 11 | The name of a snapshot
APFS_TYPE_SIBLING_MAP | 12 | A mapping from a hard link to its target inode
APFS_TYPE_FILE_INFO | 13 | Additional information about file data

On volumes with the `APFS_INCOMPAT_EXPANDED_RECORDS` flag set, the type value `APFS_TYPE_EXPANDED` (14) serves as a marker. When this type is set in `j_key_t`, the actual record subtype is stored in a separate byte at key offset +8. Known expanded subtypes:

{: style="margin-left: 0"}
Subtype | Description
--------|------------
16 | Purgeable file tracking
17 | Tombstone records for deleted entries
18 | Expanded directory statistics
19 | Clone mapping records for file cloning

## Key Encoding Details

The `obj_id_and_type` field in `j_key_t` packs both the object identifier and type into a single 64-bit value. In a volume group, `SYSTEM_OBJ_ID_MARK` (0x0fffffff00000000) is the smallest object identifier used by the system volume: object identifiers below this value belong to the data volume, and identifiers at or above it belong to the system volume.

When sorting FS-Tree records, the comparison proceeds in three stages:

1. Compare object identifiers (lower 60 bits of `obj_id_and_type`) numerically.
2. Compare types (upper 4 bits) numerically. This groups all record types for a single file system object together.
3. For directory records and extended attributes, compare the remaining key data. For `j_drec_hashed_key_t`, compare `name_len_and_hash` numerically first, then name bytes. For `j_xattr_key_t`, compare name bytes directly.

This ordering ensures that all records for a single file system object (inode, directory entries, extents, xattrs, siblings) are stored adjacently in the tree, making it efficient to gather all information about a file in a single range scan.

## File System Object Composition

Different file system objects are composed of different record types. Here are the common compositions:

- **Files:** `INODE` (required), plus optional `CRYPTO_STATE`, `DSTREAM_ID`, `EXTENT`, `FILE_EXTENT`, `SIBLING_LINK`, and `XATTR` records
- **Directories:** `INODE` (required), plus `DIR_REC` for each child, optional `DIR_STATS`, `CRYPTO_STATE`, and `XATTR`
- **Symbolic links:** `INODE` (required), plus an `XATTR` with the name `com.apple.fs.symlink` whose value is the target path
- **Snapshots:** `SNAP_METADATA` (required) and `SNAP_NAME` (required), plus optional `CRYPTO_STATE` and `EXTENT`

## Conclusion

The File System Tree (FS-Tree) in an APFS volume is a specialized B-Tree that stores information about the files and directories on the volume. A unique object identifier and type identify each record in the tree, and the FS-Tree is ordered by these keys. FS-Tree nodes can be encrypted, and the tree takes advantage of the Object Map’s snapshotting capabilities. By analyzing the records in the FS-Tree, one can gain a complete understanding of the volume’s file system. In our next post, we will discuss the details of some of these records.

