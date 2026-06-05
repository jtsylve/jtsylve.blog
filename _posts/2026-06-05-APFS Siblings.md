---
layout: post
title: Hard Links and Siblings
series: "APFS Internals"
series_part: 15
categories: [file-systems, apfs]
tags: [apfs, hard-links, siblings]
---

In our [post on Inode and Directory Records](/post/2022/12/16/APFS-Inode-and-Directory-Records), we noted that a single inode may be referenced by more than one directory record, as is the case with hard links. In [File System Trees](/post/2022/12/15/APFS-FSTrees), we listed `APFS_TYPE_SIBLING_LINK` and `APFS_TYPE_SIBLING_MAP` among the record types. Today we examine how APFS explicitly tracks hard links through a mechanism called _siblings_.

## Why Siblings Exist

Traditional Unix file systems track hard links implicitly: an inode has a link count (`nlink`), and each directory entry pointing to it constitutes a link. There is no built-in way to enumerate all the names of a hard-linked file without scanning the entire file system.

APFS tracks hard links explicitly. Each hard link to an inode is called a _sibling_ and is assigned its own unique identifier. This enables:
- Efficient enumeration of all names for a file
- Bidirectional mapping between sibling identifiers and inodes
- Support for macOS Carbon APIs that require distinguishing between links to the same file
- Proper Spotlight indexing and file coordination across multiple names

The sibling with the lowest identifier is the _primary link_. The inode's `parent_id` and `INO_EXT_TYPE_NAME` extended field always reflect the primary link's parent directory and name.

## Sibling Link Records

_Sibling link records_ (type `APFS_TYPE_SIBLING_LINK`) map from an inode to each of its hard links. They are stored in the [File System Tree](/post/2022/12/15/APFS-FSTrees).

```cpp
typedef struct j_sibling_key {
    j_key_t hdr;          // 0x00
    uint64_t sibling_id;  // 0x08
} j_sibling_key_t;        // 0x10
```
- `hdr`: The record's header. The object identifier is the inode number.
- `sibling_id`: The sibling's unique identifier

```cpp
typedef struct j_sibling_val {
    uint64_t parent_id;  // 0x00
    uint16_t name_len;   // 0x08
    uint8_t name[0];     // 0x0A
} j_sibling_val_t;
```
- `parent_id`: The inode number of the parent directory containing this link
- `name_len`: The length of the name including the null terminator
- `name`: The null-terminated UTF-8 name of the directory entry

For a file with three hard links, there will be three sibling link records, all sharing the same inode number in their key header but each with a unique `sibling_id`. Each record stores the parent directory and name for that particular link.

## Sibling Map Records

_Sibling map records_ (type `APFS_TYPE_SIBLING_MAP`) provide the reverse mapping: given a sibling identifier, find the inode.

```cpp
typedef struct j_sibling_map_key {
    j_key_t hdr; // 0x00
} j_sibling_map_key_t; // 0x08
```
- `hdr`: The record's header. The object identifier is the sibling's unique identifier.

```cpp
typedef struct j_sibling_map_val {
    uint64_t file_id; // 0x00
} j_sibling_map_val_t; // 0x08
```
- `file_id`: The inode number of the underlying file

This bidirectional mapping (sibling link: inode -> sibling ID + location; sibling map: sibling ID -> inode) allows efficient traversal in either direction.

## Sibling Identifier Allocation

Sibling identifiers are allocated from the same object identifier space as inode numbers (from the volume's `next_obj_id` counter). Each directory record for a hard-linked file stores its sibling identifier in the `DREC_EXT_TYPE_SIBLING_ID` extended field, linking the directory entry to its corresponding sibling records.

## Operations

When the first hard link is created (the target's `nlink` is still 1 and its existing directory entry has no `DREC_EXT_TYPE_SIBLING_ID` field), the original entry is first promoted to a sibling: a sibling identifier is allocated for it, a `DREC_EXT_TYPE_SIBLING_ID` field is added to that existing directory entry, and sibling link and map records are created for the original link. The steps below then run for the new link.

When a hard link is created:
1. A new sibling identifier is allocated from `next_obj_id` for the new link (on the first hard link, a second identifier is also allocated to promote the original entry; see above).
2. A sibling link record is inserted into the File System Tree, keyed by the target inode number and the new sibling ID.
3. A sibling map record is inserted, keyed by the sibling ID, with the target inode as the value.
4. The directory record receives a `DREC_EXT_TYPE_SIBLING_ID` extended field with the sibling ID.
5. Because sibling identifiers are handed out in increasing order from `next_obj_id`, a newly created link always has a higher identifier than every existing sibling, so creating a link never changes which sibling is the primary link.

When a hard link is removed:
1. Both the sibling link record and sibling map record are deleted.
2. If the removed link was the primary link, the inode's metadata is updated to reflect the next-lowest sibling as the new primary.

## Hard-Link Fixup at Mount

On volumes where the `APFS_FEATURE_HARDLINK_MAP_RECORDS` feature flag (bit 1 of `apfs_features`) is not set, the implementation runs a fixup pass at mount time. This pass iterates all `APFS_TYPE_SIBLING_LINK` records and ensures a corresponding `APFS_TYPE_SIBLING_MAP` record exists for each one. Progress is tracked via the `fixup-hardlink-progress` extended attribute on the root directory (inode 2), which stores the last processed object identifier.

Once fixup completes, `APFS_FEATURE_HARDLINK_MAP_RECORDS` is set and the progress attribute is removed. This mechanism handles the transition from older APFS implementations that did not maintain sibling map records.

## Forensic Considerations

Sibling records are valuable for forensic analysis:

- They allow complete enumeration of all paths to a file without scanning every directory entry on the volume.
- The `parent_id` in sibling link records reveals which directories contain links to a file, even if some of those directory entries have been deleted or are in snapshots.
- Inconsistencies between sibling records and directory entries (or between sibling link and sibling map records) may indicate tampering or corruption.
- The `DREC_EXT_TYPE_SIBLING_ID` extended field in directory records provides a cross-reference that can validate the integrity of the sibling mapping.

## Conclusion

APFS's explicit hard link tracking through sibling records distinguishes it from traditional Unix file systems. The bidirectional mapping between inodes and sibling identifiers enables efficient enumeration, correct primary link tracking, and robust support for macOS APIs that distinguish between names of the same file.
