---
layout: post
title: 2022 APFS Advent Challenge Day 20 - Snapshot Metadata
---

Our previous post covered how [_Object Maps_](/post/2022/12/12/APFS-OMAP) facilitate the implementation of point-in-time _Snapshots_ of APFS file systems by preserving [_File System Tree Nodes_](/post/2022/12/15/APFS-FSTrees) from earlier transactions. In that discussion, I outlined the on-disk structure of the _Object Map Snapshot Tree_ and how it can be used to enumerate the transaction identifiers of each Volume Snapshot. Today, we will briefly discuss two other sources of information that store additional metadata about each Snapshot.

## Snapshot Metadata Tree

The _Snapshot Metadata Tree_ is a [B-Tree](/post/2022/12/08/APFS-BTrees) whose physical address can be located by reading the `apfs_snap_meta_tree_oid` field of the [_Volume Superblock_](/post/2022/12/13/APFS-Volume-Superblock).  It stores two types of objects, structured as [_File System Records_](/post/2022/12/15/APFS-FSTrees).

### Snapshot Metadata Records

_Snapshot Metadata Records_ store the bulk of metadata about Volume Snapshots.  The key-half is a `j_snap_metadata_key` structure with an encoded type of `APFS_TYPE_SNAP_METADATA`.

```cpp
typedef struct j_snap_metadata_key {
  j_key_t hdr;           // 0x00
} j_snap_metadata_key_t; // 0x08
```
- `hdr`: The record's header.  The object identifier in the header is the snapshot's transaction identifier. 

The value-half of the record is a `j_snap_metadata_val_t` structure and is immediately followed by the UTF-8 encoded name of the snapshot.

```cpp
typedef struct j_snap_metadata_val {
  oid_t extentref_tree_oid;       // 0x00
  oid_t sblock_oid;               // 0x08
  uint64_t create_time;           // 0x10
  uint64_t change_time;           // 0x18
  uint64_t inum;                  // 0x20
  uint32_t extentref_tree_type;   // 0x28
  uint32_t flags;                 // 0x2C
  uint16_t name_len;              // 0x30
  uint8_t name[0];                // 0x32
} j_snap_metadata_val_t;
```
- `extentref_tree_oid`: The _physical object identifier_ of the B-Tree that stores extent references for the snapshot.
- `sblock_oid`: The _physical object identifier_ of a backup of the snapshot's Volume Superblock
- `create_time`: The time when the snapshot was created
- `change_time`: The time that this snapshot was last modified
- `inum`: _reserved_
- `extentref_tree_type`: The type of the _Extent Reference Tree_
- `flags`: A bit field that contains additional information about a snapshot metadata record
- `name_len`: The length of the name that follows this structure (in bytes)

#### Snapshot Metadata Record Flags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
SNAP_META_PENDING_DATALESS | 0x00000001 | This snapshot is _dataless_, meaning that it does not preserve the file extents
SNAP_META_MERGE_IN_PROGRESS | 0x00000002 | The snapshot is in the process of being merged with another

### Snapshot Name Records

_Snapshot Name Records_ are used to map snapshot names to their _transaction identifiers_.  The key-half of the record is a `j_snap_name_key_t` structure with an encoded type of `APFS_TYPE_SNAP_NAME`.  It is followed by the UTF-8 encoded name of the snapshot.

```cpp
typedef struct j_snap_name_key {
  j_key_t hdr;        // 0x00
  uint16_t name_len;  // 0x08
  uint8_t name[0];    // 0x0A
} j_snap_name_key_t;
```
- `hdr`: The record's header.  The object identifier can be ignored.
- `name_len`: The length of the name (in bytes)
- `name`: The start of the UTF-8 encoded name

The value-half is a `j_snap_name_val_t` structure.

```cpp
typedef struct j_snap_name_val {
  xid_t snap_xid;    // 0x00
} j_snap_name_val_t; // 0x08
```
- `snap_xid`: The _transaction identifier_ of the snapshot

## Snapshot Extended Metadata Object

Each snapshot has a _virtual_ _Snapshot Extended Metadata Object_ in the volume's _Object Map_.  The _virtual object identifier_ of this object is stored in the `apfs_snap_meta_ext_oid` field of the Volume Superblock.  There are multiple versions of this object whose _transaction identifiers_ correspond to each snapshot.

```cpp
typedef struct snap_meta_ext_obj_phys {
  obj_phys_t smeop_o;        // 0x00
  snap_meta_ext_t smeop_sme; // 0x20
} snap_meta_ext_obj_phys_t;  // 0x48
```
- `smeop_o`: The object's header
- `smeop_sme`: The snapshot's extended metadata

```cpp
typedef struct snap_meta_ext {
  uint32_t sme_version; // 0x00
  uint32_t sme_flags;   // 0x04
  xid_t sme_snap_xid;   // 0x08
  uuid_t sme_uuid;      // 0x10
  uint64_t sme_token;   // 0x20
} snap_meta_ext_t;      // 0x28
```
- `sme_version`: The version of this structure (currently 1)
- `sme_flags`: A bitfield of flags (none are currently defined)
- `sme_snap_xid`: The transaction identifier of the snapshot
- `sme_uuid`: The unique identifier of the snapshot
- `sme_token`: An opaque token (_reserved_)



{% include advent2022.html %}