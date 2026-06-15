---
layout: post
title: Clonegroups
series: "APFS Internals"
series_part: 18
categories: [file-systems, apfs]
tags: [apfs, clonegroups, copy-on-write]
---

In our [post on Data Streams](/post/2022/12/19/APFS-Data-Streams), we discussed how APFS implements file cloning through shared extents and reference counting. While `j_phys_ext_val_t` reference counts and `j_dstream_id_val_t` track sharing at the extent level, APFS also maintains a higher-level grouping mechanism called _clonegroups_ that tracks which inodes share physical data. This post covers the clonegroup tree and its role in managing cloned files.

## Overview

The _clonegroup tree_ tracks groups of files that share physical data extents through cloning (e.g., `cp --clone` or the `clonefile` syscall). It is a [B-Tree](/post/2022/12/08/APFS-BTrees) with subtype `OBJECT_TYPE_CLONEGROUP_TREE`, referenced by the `apfs_clonegroup_tree_oid` field in the [Volume Superblock](/post/2022/12/13/APFS-Volume-Superblock).

Within each clone group, exactly one inode is designated the _full clone_: it owns the physical data extents shared by the group. All other members are _partial clones_ that reference the full clone's extents via copy-on-write. When an inode has a `INO_EXT_TYPE_CLONEGROUP_ID` (type 21) extended field set, it belongs to the clone group identified by that field's value.

## Record Types

The clonegroup tree contains two types of records, distinguished by a `record_type` field in the key:

{: style="margin-left: 0"}
Type | Name | Description
-----|------|------------
1 | Mapping | Maps an inode to a clone group. One record per member inode.
2 | Cookie | Inserted when only one member remains, signaling the group can be cleaned up.

## On-Disk Structures

### Mapping Records (record_type = 1)

Mapping records track which inodes belong to a clone group.

```cpp
typedef struct clonegroup_mapping_key {
    uint64_t group_id;     // 0x00
    uint8_t record_type;   // 0x08 (always 1)
    uint64_t inode_id;     // 0x09
    uint64_t private_id;   // 0x11
} clonegroup_mapping_key_t; // 0x19 (25 bytes, packed)
```
- `group_id`: The clone group identifier
- `record_type`: Always 1 for mapping records
- `inode_id`: The inode number of the group member
- `private_id`: The inode's data stream identifier (`private_id` from `j_inode_val_t`)

Keys are sorted by `group_id`, then `record_type`, then `inode_id`, then `private_id`.

```cpp
#define CLONEGROUP_FLAG_FULL_CLONE     0x10
#define CLONEGROUP_FLAG_PURGEABLE_MASK 0x0F

typedef struct clonegroup_val {
    uint64_t physical_size; // 0x00
    uint32_t flags;         // 0x08
    uint8_t xfields[];      // 0x0C
} clonegroup_val_t;
```
- `physical_size`: The total physical size in bytes of extents this inode contributes to the group. For the full clone, this equals the on-disk size of all shared extents. For partial clones, this is 0.
- `flags`: Bit 4 (`CLONEGROUP_FLAG_FULL_CLONE`) indicates this inode owns the physical extents. Bits 0-3 encode purgeable urgency.
- `xfields`: Optional extended fields (same format as inode extended fields)

### Cookie Records (record_type = 2)

Cookie records signal that a clone group has been reduced to a single member and can be cleaned up.

```cpp
typedef struct clonegroup_cookie_key {
    uint64_t group_id;    // 0x00
    uint8_t record_type;  // 0x08 (always 2)
    uint64_t cookie;      // 0x09
} clonegroup_cookie_key_t; // 0x11 (17 bytes, packed)
```

Note that the `cookie` field in the key is a `uint64_t`. The cookie record's _value_ is separate: it is a single byte set to 0. The record's presence triggers the solo-group cleanup path.

## Lifecycle

### Group Creation

When a file is first cloned and the clone group does not yet exist:

1. A mapping record is inserted for the source inode with `CLONEGROUP_FLAG_FULL_CLONE` set and `physical_size` reflecting its data extent size.
2. `INO_EXT_TYPE_CLONEGROUP_ID` is set on the source inode.
3. A mapping record is inserted for the clone with `physical_size = 0` (partial clone).
4. `INO_EXT_TYPE_CLONEGROUP_ID` is set on the clone.

### Adding Members

Each subsequent clone of any group member gets its own mapping record as a partial clone. The group grows without any data being physically copied.

### Full Clone Promotion and Demotion

As clones diverge through copy-on-write, an inode's relationship to the shared extents changes:

- When an inode that was a partial clone has fully diverged (all its extents are unique), it becomes a full clone of its own data.
- When a full clone is deleted, ownership of the shared physical extents must transfer to another group member.

These transitions are tracked by setting or clearing `CLONEGROUP_FLAG_FULL_CLONE` and updating `physical_size`.

### Deletion

When a group member is deleted:

1. Its mapping record is removed from the clonegroup tree.
2. If the deleted inode was the full clone, ownership transfers to another member.
3. If only one member remains, a cookie record is inserted to mark the group for cleanup.

### Solo Group Cleanup

When a group is reduced to a single member, the clone group tracking overhead is no longer needed. The cleanup process removes the remaining mapping record, the cookie record, and the `INO_EXT_TYPE_CLONEGROUP_ID` extended field from the surviving inode.

## Forensic Considerations

The clonegroup tree provides insight into file relationships that cannot be derived from extent records alone:

- It reveals which files were created by cloning, even after copy-on-write has caused their extents to partially or fully diverge.
- The `physical_size` field on the full clone indicates how much shared data exists, which is important for accurate disk space accounting.
- Cookie records reveal clone groups that are in the process of being dissolved.
- The `group_id` links related files that may be spread across different directories, enabling reconstruction of clone relationships.

## Conclusion

Clonegroups provide the bookkeeping layer above APFS's extent-level reference counting. While physical extents track shared blocks, clonegroups track shared _relationships_ between files. This enables efficient space accounting, orderly ownership transfer during deletion, and cleanup when clone groups dissolve.
