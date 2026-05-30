---
layout: post
title: Fusion Containers
series: "APFS Internals"
series_part: 26
categories: [file-systems, apfs]
tags: [apfs, fusion, containers]
---

As we discussed in [an earlier post](/post/2022/12/05/APFS-Containers), Apple’s [Fusion Drives](https://en.wikipedia.org/wiki/Fusion_Drive) combine the storage capacity of a hard disk drive (HDD) with the faster access speed of a solid state drive (SSD). The HDD is the primary storage device, and the SSD acts as a cache for recently accessed data. However, the Fusion Drive does not have built-in caching logic, and the operating system treats the two drives as separate storage devices. Apple created [Core Storage](https://en.wikipedia.org/wiki/Core_Storage) to support the desired caching capabilities and the ability to pool the storage of each device into a single logical volume. APFS removes the need for Core Storage by having first-class support for this tiered storage model. This post will go into more detail about APFS _Fusion Containers_.

_Note: As of macOS 15, Apple has removed Fusion Drive support from the APFS kernel extension. Containers with the `NX_INCOMPAT_FUSION` flag set now fail to mount. The structures documented here remain relevant for forensic analysis of existing Fusion containers but can no longer be created on current systems._

## Physical Stores

Both the SSD and HDD of a Fusion Drive appear to macOS as separate physical disk devices. Both disks are [GPT](https://en.wikipedia.org/wiki/GUID_Partition_Table) partitioned with a standard EFI partition and a second, larger partition, which takes up the bulk of the space on disk. For example, running the command `diskutil list` may show the HDD as `/dev/disk0` with its primary partition as `/dev/disk0s2` and the SSD as `/dev/disk1` and `/dev/disk1s2`. These two partitions make up the _physical stores_ of the Fusion Container.

Each physical store is formatted separately in much the same way as any other APFS container. Both will share the same `nx_uuid` in their _NX Superblocks_ and have a separate, nearly-identical UUID in the `nx_fusion_uuid` field, with the _most significant bit_ being cleared on the `tier1` SSD partition and set on the `tier2` HDD partition. The combination of these UUIDs can be used to identify the physical storage tiers of the container.

## Synthesized Container

Both tiers are mapped together as a single "synthesized" container and are presented to macOS as a single logical block device (for example, `/dev/disk2`). The `tier1` blocks are mapped at logical byte offset zero, and the `tier2` blocks at 4 EiB. The offsets within the exabyte-scale gap between the two sets of blocks cannot be read.

### Address Markers

APFS uses the following constants and macros to distinguish SSD addresses from HDD addresses and to convert between them:

```cpp
#define FUSION_TIER2_DEVICE_BYTE_ADDR 0x4000000000000000ULL

#define FUSION_TIER2_DEVICE_BLOCK_ADDR(_blksize) \
    (FUSION_TIER2_DEVICE_BYTE_ADDR >> __builtin_ctzl(_blksize))

#define FUSION_BLKNO(_fusion_tier2, _blkno, _blksize) \
    ((_fusion_tier2) \
        ? (FUSION_TIER2_DEVICE_BLOCK_ADDR(_blksize) | (_blkno)) \
        : (_blkno))
```

`FUSION_TIER2_DEVICE_BLOCK_ADDR` converts the byte-level constant to a block address for a given block size. `FUSION_BLKNO` produces a synthesized block address: for `tier1` (SSD) blocks it returns the address unchanged, and for `tier2` (HDD) blocks it ORs in the tier2 base offset. When reading a physical address, any address below the tier2 boundary belongs to the SSD; any address at or above it belongs to the HDD after subtracting the offset.

## Write-Back Cache

The _Write-Back Cache_ (WBC) is the mechanism APFS uses to buffer writes destined for the HDD on the faster SSD. Data written to the Fusion Container is initially stored on the SSD tier and later _drained_ (flushed) to the HDD in batches. The WBC occupies a contiguous region on the SSD, sized based on the total Fusion device capacity.

### fusion_wbc_phys_t

The on-disk state of the WBC is stored as a `fusion_wbc_phys_t` object.

```cpp
typedef struct {
    obj_phys_t fwp_objHdr;
    uint64_t fwp_version;
    oid_t fwp_listHeadOid;
    oid_t fwp_listTailOid;
    uint64_t fwp_stableHeadOffset;
    uint64_t fwp_stableTailOffset;
    uint32_t fwp_listBlocksCount;
    uint32_t fwp_reserved;
    uint64_t fwp_usedByRC;
    prange_t fwp_rcStash;
} fusion_wbc_phys_t;
```

- `fwp_objHdr`: The object’s header
- `fwp_version`: The version of this data structure
- `fwp_listHeadOid`: The object identifier of the first WBC list block
- `fwp_listTailOid`: The object identifier of the last WBC list block
- `fwp_stableHeadOffset`: The stable head offset within the WBC list, pointing to the oldest committed (flushed-to-disk) entry. Entries before this offset are durable.
- `fwp_stableTailOffset`: The stable tail offset within the WBC list, pointing past the newest committed entry. Entries between `fwp_stableTailOffset` and the current (volatile) tail may not have been flushed and must be replayed or discarded during crash recovery.
- `fwp_listBlocksCount`: The number of blocks used by the WBC list
- `fwp_reserved`: Reserved
- `fwp_usedByRC`: The number of blocks currently used by the replacement cache
- `fwp_rcStash`: The physical range used as a stash area by the replacement cache

The `fwp_stableHeadOffset` and `fwp_stableTailOffset` fields define the committed window within the WBC list. During crash recovery, entries within this window are known to be durable, while entries outside it may need to be replayed or discarded.

### fusion_wbc_list_phys_t

WBC list entries are stored in blocks described by a `fusion_wbc_list_phys_t` structure. These blocks form a linked list from `fwp_listHeadOid` to `fwp_listTailOid`, operating as a ring buffer.

```cpp
typedef struct {
    obj_phys_t fwlp_objHdr;
    uint64_t fwlp_version;
    uint64_t fwlp_tailOffset;
    uint32_t fwlp_indexBegin;
    uint32_t fwlp_indexEnd;
    uint32_t fwlp_indexMax;
    uint32_t fwlp_reserved;
    fusion_wbc_list_entry_t fwlp_listEntries[];
} fusion_wbc_list_phys_t;
```

- `fwlp_objHdr`: The object’s header
- `fwlp_version`: The version of this data structure
- `fwlp_tailOffset`: The tail offset within this list block
- `fwlp_indexBegin`: The index of the first valid entry in this block
- `fwlp_indexEnd`: The index after the last valid entry in this block
- `fwlp_indexMax`: The maximum number of entries that can be stored in this block
- `fwlp_reserved`: Reserved
- `fwlp_listEntries`: A variable-length array of WBC list entries

### fusion_wbc_list_entry_t

Each entry in the WBC list maps a cached block on the SSD to its destination on the HDD.

```cpp
typedef struct {
    paddr_t fwle_wbcLba;
    paddr_t fwle_targetLba;
    uint64_t fwle_length;
} fusion_wbc_list_entry_t;
```

- `fwle_wbcLba`: The block address of the cached data on the SSD
- `fwle_targetLba`: The block address of the data’s destination on the HDD
- `fwle_length`: The number of blocks in this cache entry

For read caching, the data exists on both drives. For write caching, the data resides only on the SSD until drained to the HDD, where space has already been allocated.

### Drain Behavior

The WBC periodically drains cached data from the SSD to the HDD. Drain operations are triggered when the dirty extent count exceeds a threshold (25% or 75% of WBC capacity) or on a periodic 60-second interval. The minimum drain size is 2 MB and the maximum is 8 MB. Drain items are sorted by block address for sequential HDD writes, and adjacent items are coalesced. Drains are temporarily suspended when the device is in a low power state or a degraded I/O state.

The drain operates as a state machine:

{: style="margin-left: 0"}
State | Condition | Description
------|-----------|------------
Idle | `mode & 3 == 0` | No drain activity. Transitions to drain pending when usage exceeds the 75% threshold.
Drain pending | `mode & 3 == 1` | A drain has been requested. Transitions to drain active when the drain lock is acquired.
Drain active | `mode & 3 == 3` | Dirty blocks are being scanned and enqueued for flushing to the HDD.
Throttled | `mode & 3 == 2` | Drain is temporarily suspended. Returns to idle when usage drops below 25%.

## Middle Tree

The _Middle Tree_ is a [B-Tree](/post/2022/12/08/APFS-BTrees) that maps HDD block addresses to their cached locations on the SSD. It provides the lookup mechanism that allows APFS to intercept reads for HDD data that has been promoted to the faster tier.

### fusion_mt_key_t

The key for a middle tree entry is the physical block address on the HDD.

```cpp
typedef paddr_t fusion_mt_key_t;
```

### fusion_mt_val_t

The value describes the cached extent on the SSD.

```cpp
typedef struct {
    paddr_t fmv_lba;
    uint32_t fmv_length;
    uint32_t fmv_flags;
} fusion_mt_val_t;
```

- `fmv_lba`: The block address of the cached data on the SSD
- `fmv_length`: The number of blocks in this cached extent
- `fmv_flags`: Flags for this entry (see below)

### Middle Tree Flags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
FUSION_MT_DIRTY | `1 << 0` | The cached extent has been written to the SSD but not yet flushed to the HDD
FUSION_MT_TENANT | `1 << 1` | The cached extent is actively in use by the caching algorithm

## Tier Migration

APFS automatically promotes frequently accessed data from the HDD to the SSD and demotes infrequently accessed data in the reverse direction. This migration is managed by a Generalized CLOCK (GCLOCK) algorithm with a Bloom filter for access tracking.

### Promotion

When a block on the HDD is read, the migration algorithm evaluates whether it should be promoted to the SSD. The block must pass an access-frequency check (via the GCLOCK resident list or a Bloom filter), and the SSD must have available capacity. If eligible, the block is copied from the HDD to the SSD, and the middle tree is updated to reflect the new mapping.

### Demotion

When the SSD tier is full and new space is needed, the GCLOCK sweeps a circular array of multi-bit reference counters. Each counter tracks access recency: recently accessed blocks have high counter values, while blocks that have not been accessed recently are decremented on each sweep. When a counter reaches zero, the corresponding block becomes a candidate for demotion back to the HDD.

### Capacity Thresholds

The WBC region and tier capacities scale with the total Fusion device size. For devices smaller than 12 GB, the WBC region is one-third of the total capacity. For devices between 12 and 20 GB, intermediate scaling applies with a 2 GB SSD reserve. For devices 20 GB and above, the SSD reserve grows as one-third of the excess capacity above 20 GB plus 2 GB. Migration is suspended during operations that require stable block layouts, such as volume resizes and snapshot creation.

## Forensic Considerations

The logically exabyte-scale gap separating the two tiers presents a unique problem during digital forensic imaging of Fusion Containers. To preserve the logical offsets of the evidence without having to use a data center worth of storage, you must use an evidence storage format that supports _sparse_ imaging.

When analyzing a Fusion Container, the WBC list and middle tree are particularly valuable. The WBC list reveals blocks that were recently written but may not yet have been flushed to the HDD, providing insight into recent write activity. The middle tree shows which HDD blocks have been cached on the SSD, indicating frequently accessed data. The `FUSION_MT_DIRTY` flag in middle tree entries identifies data that exists only on the SSD.

As long as sparse imaging and the address translation described above are accounted for, analyzing Fusion Containers does not generally differ from analyzing other APFS containers.

## Conclusion

This post covered Fusion Containers in APFS, including how the two physical stores are synthesized into a single logical container, the write-back cache structures that buffer writes on the SSD, the middle tree that tracks tier mappings, and the migration algorithm that moves data between tiers.
