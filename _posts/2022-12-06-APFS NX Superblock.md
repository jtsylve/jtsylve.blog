---
layout: post
title: 2022 APFS Advent Challenge Day 4 - NX Superblock Objects
---

The _NX Superblock Object_ is a key component of APFS. It stores key information about the Container, such as the block size, total number of blocks, supported features, and the object IDs of various trees and other structures used to track and maintain other objects. The on-disk `nx_superblock_t` structure is used as the root source of information to locate all other objects in the checkpoint.  In this post, we will go into detail about this structure as well as discuss methodology that can be used to locate them on-disk.

## On-Disk Structures

```cpp
typedef uint8_t uuid_t[0x10];
typedef int64_t paddr_t;

typedef struct prange {
    paddr_t pr_start_paddr;  // 0x00
    uint64_t pr_block_count; // 0x08
} prange_t;                  // 0x10

#define NX_MAGIC 0x4253584E  // NXSB
#define NX_MAX_FILE_SYSTEMS 100
#define NX_EPH_INFO_COUNT 4
#define NX_NUM_COUNTERS 32

typedef struct nx_superblock {
    obj_phys_t nx_o;                                // 0x00
    uint32_t nx_magic;                              // 0x20
    uint32_t nx_block_size;                         // 0x24
    uint64_t nx_block_count;                        // 0x28
    uint64_t nx_features;                           // 0x30
    uint64_t nx_readonly_compatible_features;       // 0x38
    uint64_t nx_incompatible_features;              // 0x40
    uuid_t nx_uuid;                                 // 0x48
    oid_t nx_next_oid;                              // 0x58
    xid_t nx_next_xid;                              // 0x60
    uint32_t nx_xp_desc_blocks;                     // 0x68
    uint32_t nx_xp_data_blocks;                     // 0x6C
    paddr_t nx_xp_desc_base;                        // 0x70
    paddr_t nx_xp_data_base;                        // 0x78
    uint32_t nx_xp_desc_next;                       // 0x80
    uint32_t nx_xp_data_next;                       // 0x84
    uint32_t nx_xp_desc_index;                      // 0x88
    uint32_t nx_xp_desc_len;                        // 0x8C
    uint32_t nx_xp_data_index;                      // 0x90
    uint32_t nx_xp_data_len;                        // 0x94
    oid_t nx_spaceman_oid;                          // 0x98
    oid_t nx_omap_oid;                              // 0xA0
    oid_t nx_reaper_oid;                            // 0xA8
    uint32_t nx_test_type;                          // 0xB0
    uint32_t nx_max_file_systems;                   // 0xB4
    oid_t nx_fs_oid[NX_MAX_FILE_SYSTEMS];           // 0xB8
    uint64_t nx_counters[NX_NUM_COUNTERS];          // 0x3D8
    prange_t nx_blocked_out_prange;                 // 0x4D8
    oid_t nx_evict_mapping_tree_oid;                // 0x5D8
    uint64_t nx_flags;                              // 0x5E0
    paddr_t nx_efi_jumpstart;                       // 0x5E8
    uuid_t nx_fusion_uuid;                          // 0x5F8
    prange_t nx_keylocker;                          // 0x608
    uint64_t nx_ephemeral_info[NX_EPH_INFO_COUNT];  // 0x618
    oid_t nx_test_oid;                              // 0x638
    oid_t nx_fusion_mt_oid;                         // 0x640
    oid_t nx_fusion_wbc_oid;                        // 0x648
    prange_t nx_fusion_wbc;                         // 0x650
    uint64_t nx_newest_mounted_version;             // 0x660
    prange_t nx_mkb_locker;                         // 0x668
} nx_superblock_t;                                  // 0x678
```

### prange_t

`prange_t` structures keep track of contiguous ranges of blocks.  It is used in various other data structures.

- `pr_start_paddr`: The physical address of the first block in the range.
- `pr_block_count`: The number of blocks in the range

### nx_superblock_t

`nx_superblock_t` structures store key information about the Container and act as the root source of information to locate all other objects in the checkpoint.  We'll go into detail on most of these as needed, but below is a brief description of each.

- `nx_o`: The object's header
- `nx_magic`: A number that can be used to verify that you're reading an instance of nx_superblock_t. This should always be the value defined by `NX_MAGIC`
- `nx_block_size`: The logical block size used in the container
- `nx_block_count`: The total number of blocks in the container
- `nx_features`: A bit-field of optional features supported by the container
- `nx_readonly_compatible_features`: A bit-field of optional _read-only_ features supported by the container
- `nx_incompatible_features`: A bit-field of backwards-incompatible features that are in use
- `nx_next_oid`: The next object identifier that will be used by a new _virtual_ or _ephemeral_ object
- `nx_next_xid`: The next transaction identifier that will be used
- `nx_xp_desc_blocks`: Encodes the number of blocks in the _Checkpoint Descriptor Area_
- `nx_xp_data_blocks`: Encodes the number of blocks in the _Checkpoint Data Area_
- `nx_xp_desc_base`: Encodes information that can be used to locate the ranges of blocks used by the checkpoint descriptor area
- `nx_xp_data_base`: Encodes information that can be used to locate the ranges of blocks used by the checkpoint data area
- `nx_xp_desc_next`: The next index that will be used in the checkpoint descriptor area
- `nx_xp_data_next`: The next index that will be used in the checkpoint data area
- `nx_xp_desc_index`: The index of the first valid item in the checkpoint descriptor area
- `nx_xp_desc_len`: The number of blocks in the checkpoint descriptor area used by the checkpoint to which this superblock belongs
- `nx_xp_data_index`: The index of the first valid item in the checkpoint data area
- `nx_xp_data_len`: The number of blocks in the checkpoint data area used by the checkpoint to which this superblock belongs
- `nx_spaceman_oid`: The ephemeral object identifier of the container's _Space Manager_
- `nx_omap_oid`: The physical object identifier of the container's _Object Map_
- `nx_reaper_oid`: The ephemeral object identifier of the container's _Reaper_
- `nx_test_type`: _Reserved_
- `nx_max_file_systems`: The maximum number of file system volumes that can be used with this container
- `nx_fs_oid`: An array of virtual object identifiers for _File System Superblock Objects_
- `nx_counters`: An array of performance counters
- `nx_blocked_out_prange`: A physical range of blocks where space will not be allocated (used when shrinking a partition)
- `nx_evict_mapping_tree_oid`: The physical object identifier of a tree used to keep track of objects that must be moved out of blocked-out storage. (used when shrinking a partition)
- `nx_flags`: Miscellaneous container flags
- `nx_efi_jumpstart`: The physical block address of the EFI boot information object.
- `nx_fusion_uuid`: The universally unique identifier of the container's Fusion set, or zero for non-Fusion containers
- `nx_keylocker`: The location of the container's keybag.
- `nx_ephemeral_info`: An array of fields used in the management of ephemeral data
- `nx_test_oid`: _Reserved_
- `nx_fusion_mt_oid`: The physical object identifier of the _Fusion Middle Tree_ or zero on non-fusion drives
- `nx_fusion_wbc_oid`: The ephemeral object identifier of the Fusion write-back cache state or zero on non-fusion drives
- `nx_fusion_wbc`: The blocks used for the Fusion _write-back cache area_, or zero for non-Fusion drives
- `nx_newest_mounted_version`: _Reserved_, but generally used to encode the version number of the APFS KEXT with the highest version number that was used to mount this container read/write.
- `nx_mkb_locker`: The blocks used to store the wrapped media key



## Locating the NX Superblock

Block 0 of the disk partition always contains a copy of the container's `nx_superblock_t` object, but it is not guaranteed to be the most up-to-date version, depending on whether the container was last unmounted _cleanly_. Rather than relying on a possibly invalid superblock object, we can use the information in this block-zero copy to locate the latest, valid checkpoint.

### Step 1: Validating Block Zero

First, it is necessary to determine whether in fact we are dealing with an APFS container in the first place, and (if so) to identify the container's fixed block size.

1. Start by reading at least 4 KiB of data from the start of the partition.  On an APFS formatted partition, this should always be a valid `nx_superblock_t` structure.

2. Validate the object type in the `nx_o.o_type` field and that the `nx_magic` field is set to the `NX_MAGIC` value.

3. Read the container's block size from the `nx_block_size` field.  If it is larger than 4 KiB, re-read the block-zero superblock into memory with the correct block size.

4. [Calculate the object's checksum](/post/2022/12/01/Anatomy-of-an-APFS-Object) and validate it against the value in its object header.

If all goes well, we're in business.

### Step 2: Locate the Checkpoint Descriptor Area

NX Superblock objects are stored in the container's _Checkpoint Descriptor Area_.  In order to locate these superblocks, we must first identify and scan the descriptor area blocks, looking for valid NX Superblock objects.  In some cases, the blocks of the descriptor area are all physically contiguous on disk, which means we only have a single range of blocks to scan.  In other cases, we may need to locate multiple non-contiguous ranges of blocks and scan them in order.

Read the `nx_xp_desc_base` field of the block-zero superblock.  The _most-significant bit_ (MSB) of this value is a flag, and the remaining 63 _least-significant bits_ (LSBs) contain a physical block address.

If the MSB is unset, the descriptor area consists of only a single range of contiguous blocks. The rest of `nx_xp_desc_base` contains the block number of the starting block, and the `nx_xp_desc_blocks` field contains the number of blocks in the area.

Things are a bit more complicated if the MSB is set.  The descriptor area is stored non-contiguously and we'll need to scan multiple ranges.  Rather than the starting block, the LSBs of `nx_xp_desc_base` encode the physical address of a _B-Tree Root Node_ object.  

_We will discuss B-Trees, and how to parse them later this week, but for now it is only necessary to understand that B-Trees in APFS are essentially just ordered key/value stores._  

This particular B-Tree maps `uint64_t` logical starting offsets inside the checkpoint descriptor area to `prange_t` physical block ranges.  Enumerating through the entries in this B-Tree allows us to identify the order and location of each range of blocks in the checkpoint descriptor area.

### Step 3: Search the Checkpoint Descriptor Area

As discussed in our [last post](/post/2022/12/05/APFS-Containers), the container's _Checkpoint Descriptor Area_ stores two types of objects: _NX Superblocks_ and _Checkpoint Maps_.  These objects can be differentiated by the `o_type` member of their object headers.

Search each range of blocks in the descriptor area, looking for NX Superblock objects.  There should be more than one, with each superblock representing a specific checkpoint.  Validate each superblock as before, and keep track of the _valid_ superblock with the highest _transaction identifier_ (`xid`).  Since NX Superblock objects are the last objects flushed to disk during a checkpoint transaction, this _should_ mean you've located the information needed to parse the most up-to-date state of the container.  If you run into problems parsing information from a container later down the road, you can always try starting from the NX Superblock with the next-highest `xid`.

## Conclusion

Understanding how to interpret and locate _NX Superblock Objects_ is the first step in parsing APFS.  These objects are essential to the process of locating all other objects in a checkpoint.  In our next post, we will discuss _Checkpoint Maps_, and how they can be used to locate ephemeral objects on disk.

{% include advent2022.html %}