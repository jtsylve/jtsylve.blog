---
layout: post
title: File System Trees
series: "APFS Internals"
series_part: 10
categories: [file-systems, apfs]
tags: [apfs, fstrees, volumes]
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

## Conclusion

The File System Tree (FS-Tree) in an APFS volume is a specialized B-Tree that stores information about the files and directories on the volume. A unique object identifier and type identify each record in the tree, and the FS-Tree is ordered by these keys. FS-Tree nodes can be encrypted, and the tree takes advantage of the Object Map’s snapshotting capabilities. By analyzing the records in the FS-Tree, one can gain a complete understanding of the volume’s file system. In our next post, we will discuss the details of some of these records.

