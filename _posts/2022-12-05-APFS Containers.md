---
layout: post
title: Containers
series: "APFS Internals"
series_part: 3
categories: [file-systems, apfs]
tags: [apfs, containers]
last_modified_at: 2026-06-01
---

APFS is a _pooled storage_, _transactional_, _copy-on-write_ file system. Its design relies on a core management layer known as the _Container_. APFS containers consist of a collection of several specialized components: The _Space Manager_, the _Checkpoint Areas_, and the _Reaper_. In today's post, we will give an overview of APFS containers and these components, including the mount procedure, transaction lifecycle, and container resize mechanisms.

## History

Prior to the introduction of APFS, Apple's primary file system of choice was [HFS+](https://en.wikipedia.org/wiki/HFS_Plus). HFS+ is a _journaling file system_ that was introduced by Apple in 1998 as an improvement over its legacy HFS file system.

Like most file systems of its era, each HFS+ volume can only manage the space of a single physical disk partition. While it is possible to have more than one HFS+ volume on a disk, the limitation of "one volume per partition" requires that the storage space for each volume be fixed and pre-allocated. This means that HFS+ volumes that are low on storage space cannot make use of any available free space elsewhere on disk.

In 2012, Apple introduced its hybrid [Fusion Drives](https://en.wikipedia.org/wiki/Fusion_Drive), which consist of a larger _hard disk drive (HDD)_ combined with a smaller, but faster _solid state drive (SSD)_ in a single package. The HDD is intended to be used as the primary storage device, providing the baseline storage capacity, and the SSD provides faster access to the most recently accessed data by acting as a cache.

This caching logic is not built into the fusion drive hardware. The two drives are presented to the operating system as separate storage devices. HFS+ does not have the ability to span a volume across multiple partitions, and it was not designed to support the desired caching mechanisms.

Rather than massively overhauling HFS+ to support these new capabilities, Apple decided instead to add an additional storage layer, called [Core Storage](https://en.wikipedia.org/wiki/Core_Storage). Core Storage acts as a _logical volume manager_ that has the ability to pool the storage of multiple devices on the same drive into a single, logical volume. It also implements a _tiered storage model_ that allows blocks to be duplicated and cached on Fusion drives. Incidentally, Core Storage also provides the mechanism for the volume-level encryption facilities of _File Vault_ on HFS+ systems. Because HFS+ only sees a single logical volume, these complexities are completely transparent to the file system's implementation.

Apple introduced APFS in 2017. The design of APFS takes many lessons from both HFS+ and Core Storage, and eliminates the need for both of them.


## Space Manager

APFS containers provide pooled and tiered storage capabilities, without the need for a Core Storage layer. It presents one logical view of storage, whose blocks can be shared among multiple volumes without the need for pre-partitioning and pre-allocation of space. As volumes' storage requirements change over time, blocks are allocated or returned to the container. This allows for quite a bit of flexibility, as you can now have multiple volumes that serve different _roles_ without having to figure out their space requirements ahead of time. For example, you can now have more than one _system_ volume with different versions of macOS installed that can share the same user _data_ volume.

It supports storage devices as small as 1 MiB in size (APFS on a 1.44 MiB HD floppy, anyone?) and has no apparent upper storage limit. It supports the sharing of blocks among as many as 100 volumes (with some limitations). In addition to that hard-coded upper maximum of 100 volumes, APFS requires that there can be no more than one volume per 512 MiB of storage space. This helps limit storage contention and reduces the amount of space needed to maintain file system metadata on-disk.

The Space Manager keeps track of which blocks across storage tiers are in-use. It is also responsible for the allocation and freeing of blocks for volumes on-demand.

## Checkpoint Areas

As mentioned in [last Friday's post](/post/2022/12/02/Kinds-of-APFS-Objects), APFS provides fault tolerance by batching together copies of updated objects and committing them to disk in transactions known as _checkpoints_. This transactional, copy-on-write strategy ensures that there is always at least one valid and complete set of APFS objects on disk. The latest checkpoint may be used as the authoritative source of information and since checkpoints aren't immediately invalidated, the entire state of APFS can be reverted to an earlier point in time.

APFS containers maintain two distinct checkpoint areas. The _Checkpoint Data Area_, which is reserved for storage of _ephemeral_ objects, and the _Checkpoint Descriptor Area_.

The Checkpoint Descriptor Area provides a logically (but not necessarily physically) contiguous area on disk that is reserved to act as a [circular buffer](https://en.wikipedia.org/wiki/Circular_buffer) to store two types of objects that are used to store information about checkpoints: _Checkpoint Map Objects_ and _NX Superblock Objects_.

After a checkpoint is flushed to disk, both types of objects are written to the descriptor area. The Checkpoint Map Objects provide a list of all ephemeral objects, their types, and their storage location within the checkpoint data area. A NX Superblock object is written to the descriptor area buffer after the map objects. This superblock is the root object of APFS and serves as the initial source of information about the state of the container in each checkpoint. All other valid objects in APFS are either directly or indirectly reachable from the NX superblock object.

Both checkpoint areas normally occupy contiguous ranges of blocks on disk, but can be _fragmented_ when contiguous space is unavailable. When fragmented, bit 31 is set in the `nx_xp_desc_blocks` or `nx_xp_data_blocks` fields of the [NX Superblock](/post/2022/12/06/APFS-NX-Superblock), and the corresponding `_base` field becomes the object identifier of a _Metadata Fragmented Extent List Tree_ rather than a direct base address. This tree maps logical offsets within the metadata region to physical block ranges, allowing the checkpoint areas to span non-contiguous regions.

## Reaper

Once a checkpoint transaction is successfully flushed to disk, APFS may choose to invalidate the oldest checkpoint. At this point, all newly unreferenced objects are subject to a process of garbage collection, where their blocks can be wiped and returned to the space manager for reuse. The Reaper is responsible for managing this garbage collection process, keeping track of the state of objects so that they may be freed across transactions.

## Mounting a Container

Mounting an APFS container involves locating the most recent valid checkpoint and using it to bootstrap access to all other structures. The procedure follows these steps:

1. **Read block zero.** This block contains a copy of the container superblock (`nx_superblock_t`). It may be the latest version or an older one, depending on whether the drive was unmounted cleanly. Validate that `nx_magic` equals `NX_MAGIC` (`'BSXN'`), the block size is valid, and the checksum is correct.

2. **Locate the checkpoint descriptor area** using the `nx_xp_desc_base` field.

3. **Find the latest valid checkpoint.** Two paths exist:
   - **Clean-unmount fast path:** If `NX_CLEAN_UNMOUNT` is set in `nx_flags`, the storage is trusted, and both `nx_xp_desc_len` and `nx_xp_data_len` are nonzero, read the superblock directly at the index `(nx_xp_desc_index + nx_xp_desc_len - 1) % (nx_xp_desc_blocks & 0x7FFFFFFF)`.
   - **Full scan:** Scan all blocks in the checkpoint descriptor area to find the superblock with the highest valid transaction identifier (`o_xid`). Walk backward from that point, validating each candidate superblock's checksum, feature flags, UUID consistency, and self-reported position. On untrusted storage (external or removable media), perform additional consistency checks on recently-changed container structures.

4. **Validate checkpoint mappings.** Read the `nx_xp_desc_len - 1` checkpoint mapping blocks that precede the superblock in the descriptor area. Verify each mapping block's type, transaction ID, and entry count. The final mapping block has `CHECKPOINT_MAP_LAST` set.

5. **Load ephemeral objects.** Read each object listed in the checkpoint mappings from the checkpoint data area. Verify checksums, types, and transaction IDs.

6. **Locate the container object map** using `nx_omap_oid`.

7. **Mount volumes.** Read the volume list from `nx_fs_oid`, look up each volume's superblock via the container object map, and access each volume's file system tree.

If any step fails, the implementation falls back to an older valid checkpoint from the descriptor area. This ensures that even after a crash or incomplete write, the container can always recover to a consistent state.

## Transaction Lifecycle

APFS maintains a pool of up to 4 transaction objects. Each transaction progresses through these states:

1. **Open:** A new transaction identifier is assigned from `nx_next_xid`. Participants (volume operations, space manager updates) enter the transaction and increment its active reference count. New reads and writes operate within this transaction.

2. **Closing:** When conditions are met (sufficient dirty objects, space pressure, or an explicit flush request), the transaction transitions to closing. No new participants may enter.

3. **Flushing:** The checkpoint write sequence begins. All dirty ephemeral objects are written to the checkpoint data area, checkpoint mapping blocks are written to the descriptor area, a storage barrier is issued, and the new superblock is written as the commit point.

4. **Complete:** The checkpoint is fully committed. The transaction object is recycled to the pool.

A new transaction can open while a previous one is still flushing. At most two transactions are active simultaneously: one accepting modifications and one being written to disk. If the flush pipeline is full, new transactions block until space is available. An error at any stage aborts the transaction, reverting all uncommitted changes.

### Checkpoint Write Sequence

The commit process writes a checkpoint in a carefully ordered sequence:

1. **Write checkpoint data:** Dirty ephemeral objects (space manager, object map, reaper, B-Tree nodes) are written to the checkpoint data area ring buffer.

2. **Write checkpoint mappings:** `checkpoint_map_phys_t` blocks recording the type, location, and size of each ephemeral object are written to the descriptor area. The last mapping block is marked with `CHECKPOINT_MAP_LAST`.

3. **Storage barrier:** A cache flush ensures all mapping and data blocks reach persistent storage before the superblock.

4. **Write superblock:** The NX Superblock is written with updated `nx_xp_desc_index`, `nx_xp_desc_len`, `nx_xp_data_index`, `nx_xp_data_len`, and the current transaction's `o_xid`. This is the atomic commit point: once persisted, the checkpoint is valid.

The ordering guarantees that if a crash occurs before the superblock is persisted, the previous checkpoint remains valid. The superblock is the single point of atomicity for each transaction.

## Container Resize

A container can be grown or shrunk while mounted. This modifies all statically allocated metadata areas (checkpoint descriptor area, checkpoint data area, space manager internal pool, and internal pool bitmaps) to fit the new container size.

### Growing

Growing a container extends `nx_block_count` to cover additional space on the device. New metadata areas are allocated in the expanded region, old metadata blocks are freed, and the space manager is updated to reflect the larger free pool.

### Shrinking

Shrinking is more complex because data may occupy the blocks being removed:

1. **Block-out phase:** The physical range at the tail of the container is identified for removal. Any data in this range is relocated to free space elsewhere in the container using the block-out mechanism (`nx_blocked_out_prange` in the NX Superblock). This eviction uses the _evict-mapping tree_ (`nx_evict_mapping_tree_oid`) to track source-to-destination block relocations. The block-out may span multiple transactions.

2. **Metadata relocation:** Transactions are frozen and new metadata areas are allocated within the reduced container bounds. The space manager, checkpoint areas, and internal pool are recreated at their new locations.

3. **Persist:** The updated superblock is written and old metadata blocks are freed.

If the shrink fails due to insufficient space, APFS computes and reports the minimum achievable container size based on currently occupied data blocks and required metadata overhead.

## Conclusion

Containers provide the core management layer of APFS using several specialized subsystems. The mount procedure ensures crash recovery by always having access to at least one valid checkpoint. The transaction lifecycle provides atomic commits through carefully ordered writes with storage barriers. Container resize enables live storage management without unmounting. Future posts in this series will discuss each of these subsystems in more detail, including the Space Manager's allocation algorithms and the Reaper's multi-phase garbage collection.
