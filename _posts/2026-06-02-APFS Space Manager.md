---
layout: post
title: Space Manager
series: "APFS Internals"
series_part: 9
categories: [file-systems, apfs]
tags: [apfs, space-manager, allocation]
---

In our [earlier post on Containers](/post/2022/12/05/APFS-Containers), we introduced the Space Manager as the subsystem responsible for tracking which blocks are in use across all storage tiers and for allocating and freeing blocks on behalf of volumes. That post promised more detail in the future. Today we deliver on that promise by examining the Space Manager's on-disk structures, including its hierarchical chunk tracking system, free queues, internal pool, and allocation zones.

## Overview

Each APFS container has exactly one Space Manager, stored as an ephemeral object in the checkpoint data area. Its object identifier is recorded in the `nx_spaceman_oid` field of the [NX Superblock](/post/2022/12/06/APFS-NX-Superblock). The Space Manager tracks block allocation using a three-tier hierarchy: the top-level `spaceman_phys_t` structure contains per-device metadata, which references _Chunk Address Blocks_ (CABs) or _Chunk Info Blocks_ (CIBs) directly, which in turn reference individual allocation bitmaps.

## Chunks and Bitmaps

The Space Manager divides each storage device into fixed-size _chunks_. Each chunk is a contiguous range of blocks tracked by a single allocation bitmap. The number of blocks per chunk is stored in `sm_blocks_per_chunk`.

```cpp
typedef struct chunk_info {
    uint64_t ci_xid;         // 0x00
    uint64_t ci_addr;        // 0x08
    uint32_t ci_block_count; // 0x10
    uint32_t ci_free_count;  // 0x14
    paddr_t ci_bitmap_addr;  // 0x18
} chunk_info_t;              // 0x20
```
- `ci_xid`: The transaction identifier of the last transaction that modified this chunk's bitmap
- `ci_addr`: The first block address of this chunk
- `ci_block_count`: The number of blocks in this chunk (lower 20 bits). Upper 12 bits hold flags (see below).
- `ci_free_count`: The number of free blocks in this chunk (lower 20 bits)
- `ci_bitmap_addr`: The physical address of the allocation bitmap for this chunk, or zero if no bitmap has been allocated

#### Chunk Info Flags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
CI_PINNED_TO_MAIN | 0x04000000 | The chunk is within the metazone region (reserved for metadata)
CI_ALLOC_ZONE_HINT | 0x08000000 | The chunk is currently assigned to an allocation zone

## Chunk Info Blocks and Chunk Address Blocks

Chunk info structures are grouped into _Chunk Info Blocks_ (CIBs), physical objects that each hold an array of `chunk_info_t` entries.

```cpp
typedef struct chunk_info_block {
    obj_phys_t cib_o;              // 0x00
    uint32_t cib_index;            // 0x20
    uint32_t cib_chunk_info_count; // 0x24
    chunk_info_t cib_chunk_info[]; // 0x28
} chunk_info_block_t;
```
- `cib_o`: The object header (type `OBJECT_TYPE_SPACEMAN_CIB`)
- `cib_index`: The index of this CIB within its device's array
- `cib_chunk_info_count`: The number of chunk info entries in this block
- `cib_chunk_info`: A variable-length array of chunk info structures

For large containers where the number of CIBs exceeds what can be stored directly in the Space Manager, a second level of indirection is used: _Chunk Address Blocks_ (CABs).

```cpp
typedef struct cib_addr_block {
    obj_phys_t cab_o;       // 0x00
    uint32_t cab_index;     // 0x20
    uint32_t cab_cib_count; // 0x24
    paddr_t cab_cib_addr[]; // 0x28
} cib_addr_block_t;
```
- `cab_o`: The object header (type `OBJECT_TYPE_SPACEMAN_CAB`)
- `cab_index`: The index of this CAB within its device's array
- `cab_cib_count`: The number of CIB addresses stored in this block
- `cab_cib_addr`: A variable-length array of physical CIB addresses

When `sm_cab_count` in the device structure is zero, CIB addresses are stored directly in the Space Manager. When nonzero, the CAB indirection layer is present.

## Free Queues

When blocks are freed, they are not immediately returned to the allocation bitmaps. Instead, they are placed into _free queues_: B-Trees that hold recently freed extents until all transactions that might reference them have been checkpointed. This ensures crash-safe deallocation.

APFS maintains three free queues:

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
SFQ_IP | 0 | Internal pool free queue
SFQ_MAIN | 1 | Main device free queue
SFQ_TIER2 | 2 | Tier-2 (HDD on Fusion) device free queue

```cpp
typedef struct spaceman_free_queue {
    uint64_t sfq_count;           // 0x00
    oid_t sfq_tree_oid;           // 0x08
    xid_t sfq_oldest_xid;         // 0x10
    uint16_t sfq_tree_node_limit; // 0x18
    uint16_t sfq_pad16;           // 0x1A
    uint32_t sfq_pad32;           // 0x1C
    uint64_t sfq_reserved;        // 0x20
} spaceman_free_queue_t;          // 0x28
```
- `sfq_count`: The number of entries in this free queue
- `sfq_tree_oid`: The object identifier of the B-Tree that stores the entries, or zero if not yet created
- `sfq_oldest_xid`: The oldest transaction identifier among all entries
- `sfq_tree_node_limit`: When the B-Tree node count exceeds this limit, the queue is drained more aggressively

### Free Queue Entries

Free queue entries use a key that sorts first by transaction identifier, then by physical address:

```cpp
typedef struct spaceman_free_queue_key {
    xid_t sfqk_xid;          // 0x00
    paddr_t sfqk_paddr;      // 0x08
} spaceman_free_queue_key_t; // 0x10
```

The value is a `uint64_t` block count. Single-block extents store a zero-length value in the B-Tree to save space (the count of 1 is implied).

When inserting entries, the implementation coalesces adjacent extents that share the same transaction identifier, reducing B-Tree size and improving drain efficiency.

## Internal Pool

The _Internal Pool_ (IP) is a dedicated set of blocks used for allocating B-Tree nodes and other metadata structures. It provides a reserved area that guarantees metadata allocations can succeed even when the container is nearly full. The IP has its own allocation bitmaps, separate from the per-chunk bitmaps used for data.

Key fields in `spaceman_phys_t`:
- `sm_ip_base`: The physical base address of the internal pool blocks
- `sm_ip_block_count`: The total number of blocks in the pool (bit 63 is a fragmentation flag)
- `sm_ip_bm_base`: The physical base address of the IP bitmap blocks
- `sm_ip_bm_block_count`: The number of IP bitmap blocks (bit 31 is a fragmentation flag)
- `sm_ip_bm_size_in_blocks`: The number of bitmap blocks needed to cover the pool
- `sm_ip_bm_tx_multiplier`: The number of bitmaps per transaction (at least 4)

When the fragmentation flag is set (bit 63 of `sm_ip_block_count` or bit 31 of `sm_ip_bm_block_count`), the pool blocks or bitmaps are not contiguous. Their physical addresses must be looked up through a _Metadata Fragmented Extent List Tree_ rather than computed from the base address.

## Allocation Zones

APFS uses _allocation zones_ to group related allocations together on disk, reducing fragmentation and improving sequential read performance. Each device has up to 8 allocation zones (`SM_DATAZONE_ALLOCZONE_COUNT`), with zone IDs 1 through 4 corresponding to minimum allocation sizes in blocks.

```cpp
typedef struct spaceman_allocation_zone_info_phys {
    spaceman_allocation_zone_boundaries_t saz_current_boundaries;
    spaceman_allocation_zone_boundaries_t saz_previous_boundaries[7];
    uint16_t saz_zone_id;
    uint16_t saz_previous_boundary_index;
    uint32_t saz_reserved;
} spaceman_allocation_zone_info_phys_t;
```
- `saz_current_boundaries`: The current start and end block addresses of this zone
- `saz_previous_boundaries`: A circular buffer of the 7 most recent previous chunk assignments
- `saz_zone_id`: The allocation size class (1-4 blocks, or 0 for unused)
- `saz_previous_boundary_index`: Index into the circular buffer for the next rotation

Each allocation zone boundary is a simple range:

```cpp
typedef struct spaceman_allocation_zone_boundaries {
    uint64_t saz_zone_start; // 0x00
    uint64_t saz_zone_end;   // 0x08
} spaceman_allocation_zone_boundaries_t;
```

When an allocation zone's current chunk becomes full, the allocator scans for a new chunk with sufficient free space, rotates the old boundaries into the circular buffer, and updates the current boundaries. The `CI_ALLOC_ZONE_HINT` flag on chunks tracks which chunk is currently assigned to a zone.

## Metazone

The _metazone_ is a contiguous region at the beginning of each device reserved exclusively for metadata allocation. Data allocations must not use metazone blocks. This separation ensures that metadata structures (B-Tree nodes, Space Manager bitmaps) are clustered together near the start of the device for efficient access.

The metazone size scales with device capacity:
- Devices smaller than approximately 6 GB have no metazone
- Devices smaller than 16 GB use a 512 MB metazone
- Larger devices use a tiered formula that allocates progressively smaller fractions as device size increases, capped at one-quarter of the total device size

Chunks within the metazone are marked with the `CI_PINNED_TO_MAIN` flag and are excluded from data allocation zones.

## spaceman_phys_t

The top-level structure tying everything together:

```cpp
typedef struct spaceman_phys {
    obj_phys_t sm_o;
    uint32_t sm_block_size;
    uint32_t sm_blocks_per_chunk;
    uint32_t sm_chunks_per_cib;
    uint32_t sm_cibs_per_cab;
    spaceman_device_t sm_dev[SD_COUNT];
    uint32_t sm_flags;
    uint32_t sm_ip_bm_tx_multiplier;
    uint64_t sm_ip_block_count;
    uint32_t sm_ip_bm_size_in_blocks;
    uint32_t sm_ip_bm_block_count;
    paddr_t sm_ip_bm_base;
    paddr_t sm_ip_base;
    uint64_t sm_fs_reserve_block_count;
    uint64_t sm_fs_reserve_alloc_count;
    spaceman_free_queue_t sm_fq[SFQ_COUNT];
    uint16_t sm_ip_bm_free_head;
    uint16_t sm_ip_bm_free_tail;
    uint32_t sm_ip_bm_xid_offset;
    uint32_t sm_ip_bitmap_offset;
    uint32_t sm_ip_bm_free_next_offset;
    uint32_t sm_version;
    uint32_t sm_struct_size;
    spaceman_datazone_info_phys_t sm_datazone;
    // Variable-length arrays follow...
} spaceman_phys_t;
```

The structure is followed by variable-length arrays: IP bitmap XID arrays, IP bitmap offset arrays, IP bitmap free-next arrays, and CIB/CAB address arrays for each device. The total on-disk size must fit within one block.

Each device is described by a `spaceman_device_t`:

```cpp
typedef struct spaceman_device {
    uint64_t sm_block_count;  // 0x00
    uint64_t sm_chunk_count;  // 0x08
    uint32_t sm_cib_count;    // 0x10
    uint32_t sm_cab_count;    // 0x14
    uint64_t sm_free_count;   // 0x18
    uint32_t sm_addr_offset;  // 0x20
    uint32_t sm_reserved;     // 0x24
    uint64_t sm_reserved2;    // 0x28
} spaceman_device_t;          // 0x30
```
- `sm_block_count`: Total blocks on this device
- `sm_chunk_count`: Number of chunks
- `sm_cib_count`: Number of CIBs
- `sm_cab_count`: Number of CABs (zero if CIBs are stored directly)
- `sm_free_count`: Total free blocks on this device
- `sm_addr_offset`: Byte offset within `spaceman_phys_t` where the CIB/CAB address array begins

## Forensic Considerations

The Space Manager is particularly valuable for forensic analysis:

- **Free queue entries** identify blocks that were recently freed but may still contain recoverable data. The transaction identifier on each entry indicates when the block was freed.
- **Allocation bitmaps** reveal which blocks are currently in use versus free, which can be cross-referenced against file extent records to find orphaned data.
- **Chunk info transaction identifiers** (`ci_xid`) indicate when each chunk's allocation state last changed, providing a coarse timeline of write activity across the disk.
- **Allocation zones** reveal where the file system tends to place related data, which can help reconstruct file system activity patterns.

## Conclusion

The Space Manager implements a sophisticated hierarchical allocation system that balances performance, fragmentation avoidance, and crash safety. Its three-tier structure (CABs, CIBs, bitmaps) scales from tiny containers to multi-terabyte devices. Free queues ensure safe deallocation across transactions, while allocation zones and the metazone organize blocks for optimal access patterns.
