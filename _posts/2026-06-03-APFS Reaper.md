---
layout: post
title: The Reaper
series: "APFS Internals"
series_part: 10
categories: [file-systems, apfs]
tags: [apfs, reaper, garbage-collection]
---

In our [post on Containers](/post/2022/12/05/APFS-Containers), we introduced the Reaper as the subsystem responsible for garbage collection in APFS. The Reaper handles deletions that are too large to complete within a single transaction, such as deleting an entire volume or cleaning up after a snapshot deletion. In this post, we will examine the Reaper's on-disk structures and its multi-phase state machine.

## Overview

Each APFS container has exactly one Reaper, stored as an ephemeral object in the checkpoint data area. Its object identifier is recorded in the `nx_reaper_oid` field of the [NX Superblock](/post/2022/12/06/APFS-NX-Superblock). The Reaper runs in a dedicated kernel thread with throttled I/O priority, processing entries from a linked list of _reap list blocks_. When a handler cannot complete its work within a single transaction, it saves its progress in a state buffer and resumes in a new transaction.

## nx_reaper_phys_t

The top-level Reaper structure.

```cpp
typedef struct nx_reaper_phys {
    obj_phys_t nr_o;              // 0x00
    uint64_t nr_next_reap_id;    // 0x20
    uint64_t nr_completed_id;    // 0x28
    oid_t nr_head;               // 0x30
    oid_t nr_tail;               // 0x38
    uint32_t nr_flags;           // 0x40
    uint32_t nr_rlcount;         // 0x44
    uint32_t nr_type;            // 0x48
    uint32_t nr_size;            // 0x4C
    oid_t nr_fs_oid;             // 0x50
    oid_t nr_oid;                // 0x58
    xid_t nr_xid;                // 0x60
    uint32_t nr_nrle_flags;      // 0x68
    uint32_t nr_state_buffer_size; // 0x6C
    uint8_t nr_state_buffer[];   // 0x70
} nx_reaper_phys_t;
```
- `nr_o`: The object header (type `OBJECT_TYPE_NX_REAPER`, ephemeral)
- `nr_next_reap_id`: The identifier to assign to the next reap operation (initialized to 1)
- `nr_completed_id`: The identifier of the most recently completed reap operation
- `nr_head`: Object identifier of the first reap list block (zero if empty)
- `nr_tail`: Object identifier of the last reap list block (zero if empty)
- `nr_flags`: Reaper state flags (see below)
- `nr_rlcount`: Number of reap list blocks in the chain
- `nr_type`: The object type currently being reaped
- `nr_size`: Size parameter for the current reap operation
- `nr_fs_oid`: The volume object identifier associated with the current reap
- `nr_oid`: Object identifier of the object being reaped (zero when idle)
- `nr_xid`: Transaction identifier for the current operation
- `nr_nrle_flags`: Flags from the reap list entry being processed
- `nr_state_buffer_size`: Size of the state buffer in bytes
- `nr_state_buffer`: Variable-length buffer for handler progress state

The state buffer allows reap handlers to save their position across transaction boundaries. For a 4096-byte block, this buffer is 3984 bytes.

#### Reaper Flags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
NR_BHM_FLAG | 0x00000001 | Must always be set (initialization flag)
NR_CONTINUE | 0x00000002 | An object is partially reaped and requires continued processing

## Reap Lists

Reap list blocks form a singly linked list from `nr_head` to `nr_tail`. Each block contains an array of entries describing objects to be reaped.

```cpp
typedef struct nx_reap_list_phys {
    obj_phys_t nrl_o;                // 0x00
    oid_t nrl_next;                  // 0x20
    uint32_t nrl_flags;              // 0x28
    uint32_t nrl_max;                // 0x2C
    uint32_t nrl_count;              // 0x30
    uint32_t nrl_first;             // 0x34
    uint32_t nrl_last;              // 0x38
    uint32_t nrl_free;              // 0x3C
    nx_reap_list_entry_t nrl_entries[]; // 0x40
} nx_reap_list_phys_t;
```
- `nrl_o`: The object header (type `OBJECT_TYPE_NX_REAP_LIST`, ephemeral)
- `nrl_next`: Object identifier of the next reap list block in the chain, or zero
- `nrl_flags`: Reserved
- `nrl_max`: Maximum number of entries (calculated as `(block_size - 64) / 40`)
- `nrl_count`: Number of active entries
- `nrl_first`: Index of the first active entry, or `0xFFFFFFFF` if empty
- `nrl_last`: Index of the last active entry, or `0xFFFFFFFF` if empty
- `nrl_free`: Index of the first free entry slot, or `0xFFFFFFFF` if full

Within each block, two linked lists are threaded through the entry array using index chains: an active list of entries awaiting processing and a free list of available slots.

### nx_reap_list_entry_t

Each entry describes a single object to be reaped.

```cpp
typedef struct nx_reap_list_entry {
    uint32_t nrle_next;   // 0x00
    uint32_t nrle_flags;  // 0x04
    uint32_t nrle_type;   // 0x08
    uint32_t nrle_size;   // 0x0C
    oid_t nrle_fs_oid;    // 0x10
    oid_t nrle_oid;       // 0x18
    xid_t nrle_xid;       // 0x20
} nx_reap_list_entry_t;   // 0x28
```
- `nrle_next`: Index of the next entry in the chain, or `0xFFFFFFFF`
- `nrle_flags`: Entry flags (see below)
- `nrle_type`: The object type to reap
- `nrle_size`: Size parameter for the handler
- `nrle_fs_oid`: Volume object identifier (zero for container-level objects)
- `nrle_oid`: Object identifier of the object to reap
- `nrle_xid`: Transaction or reap identifier

#### Reap List Entry Flags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
NRLE_VALID | 0x00000001 | The entry contains valid data
NRLE_REAP_ID_RECORD | 0x00000002 | Triggers a completion notification (updates `nr_completed_id`)
NRLE_CALL | 0x00000004 | Triggers the reap handler for the specified object
NRLE_COMPLETION | 0x00000008 | Marks the entry as a post-reap completion callback
NRLE_CLEANUP | 0x00000010 | Triggers cleanup operations after reaping

When an object is added to the Reaper, two entries are typically appended: a _call entry_ (`NRLE_VALID | NRLE_CALL`) that triggers the type-specific handler, and a _completion entry_ (`NRLE_VALID | NRLE_REAP_ID_RECORD`) that updates `nr_completed_id` when processed. Sub-object entries (such as a volume's object map during volume deletion) are inserted at the head so they are processed before their parent.

## Volume Deletion Phases

The most complex reap operation is deleting an entire volume. This proceeds through a sequence of phases (beginning at `APFS_REAP_PHASE_START` = 0, which transitions immediately to the snapshot phase), tracked in an `apfs_reap_state_t` stored in `nr_state_buffer`:

```cpp
typedef struct apfs_reap_state {
    uint64_t last_pbn;    // 0x00
    xid_t cur_snap_xid;   // 0x08
    uint32_t phase;       // 0x10
} __attribute__((packed)) apfs_reap_state_t;     // 0x14 (packed, no padding)
```
- `last_pbn`: Physical block number where extent reaping last paused
- `cur_snap_xid`: Transaction identifier of the snapshot currently being reaped
- `phase`: Current deletion phase (0-4)

### Phase 1: APFS_REAP_PHASE_SNAPSHOTS

All snapshots belonging to the volume are reaped. The Reaper iterates through each snapshot's extent reference tree, freeing physical extents. Progress is tracked by `cur_snap_xid`. Each snapshot's extentref tree is then deleted, exactly as in normal [snapshot deletion](/post/2022/12/28/APFS-Snapshot-Metadata).

### Phase 2: APFS_REAP_PHASE_ACTIVE_FS

After all snapshots are gone, the active file system's extents are freed. The Reaper walks the volume's extent reference tree and frees all data extents owned by the volume. Progress is tracked by `last_pbn`. Supplemental trees are also destroyed: the sealed volume's file extent tree (`apfs_fext_tree_oid`, present when `APFS_INCOMPAT_SEALED_VOLUME` is set) and the per-file key upgrade/rotation tree (`apfs_pfkur_tree_oid`, present when `APFS_INCOMPAT_PFK_UPGRADE_ROTATION` is set).

### Phase 3: APFS_REAP_PHASE_DESTROY_OMAP

The volume's [Object Map](/post/2022/12/12/APFS-OMAP) is destroyed. This is added to the Reaper as a sub-object, using its own state tracking (`omap_reap_state_t`). After the OMAP is fully reaped, crypto state, key caches, and the volume's superblock metadata are cleared.

```cpp
typedef struct omap_reap_state {
    uint32_t omr_phase;  // 0x00
    uint32_t omr_pad;    // 0x04
    omap_key_t omr_ok;   // 0x08
} omap_reap_state_t;     // 0x18
```
- `omr_phase`: Current phase (`OMAP_REAP_PHASE_MAP_TREE` = 1, `OMAP_REAP_PHASE_SNAPSHOT_TREE` = 2)
- `omr_ok`: The last freed key, used to resume iteration after a transaction boundary

### Phase 4: APFS_REAP_PHASE_DONE

All volume structures have been freed. The reap operation is complete.

## Crash Recovery

The Reaper's design guarantees crash-safe resumption. If the system crashes mid-reap:

1. The Reaper's ephemeral object is restored from the checkpoint. Since `nr_oid` is nonzero and `NR_CONTINUE` is set in `nr_flags`, the Reaper knows to resume.
2. On the next mount, the Reaper thread starts and enters a transaction.
3. Since `nr_oid` is already set, it skips entry dequeue and goes directly to handler dispatch.
4. The handler reads its saved state from `nr_state_buffer` and resumes where it left off.

This ensures that even multi-transaction deletions spanning many checkpoints will always complete, regardless of how many crashes occur during the process.

## Forensic Considerations

The Reaper is forensically significant because:

- **Partially reaped volumes** may still contain recoverable data. The `phase` field in the reap state indicates how far deletion has progressed. Data in phases not yet reached may be fully intact.
- **The reap list** reveals which objects are pending deletion. A volume that appears missing from the container's `nx_fs_oid` array may still exist in the Reaper's queue.
- **The `nr_completed_id` and `nr_next_reap_id` fields** provide a history of how many reap operations have occurred, giving insight into container activity.
- **Free queue entries** from reaper-freed blocks retain their transaction identifiers, indicating when deletion occurred.

## Conclusion

The Reaper provides crash-safe, multi-transaction garbage collection for APFS. Its state machine design allows arbitrarily large deletions (entire volumes, snapshot cleanup, object map destruction) to proceed incrementally across as many transactions as needed, with guaranteed resumption after crashes. Combined with the [Space Manager's](/post/2026/06/02/APFS-Space-Manager) free queues, it ensures that block deallocation is always consistent and recoverable.
