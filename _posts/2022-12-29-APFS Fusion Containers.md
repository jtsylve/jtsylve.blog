---
layout: post
title: Fusion Containers
series: "APFS Internals"
series_part: 18
categories: [file-systems, apfs]
tags: [apfs, fusion, containers]
---

As we discussed in [an earlier post](/post/2022/12/05/APFS-Containers), Apple’s [Fusion Drives](https://en.wikipedia.org/wiki/Fusion_Drive) combine the storage capacity of a hard disk drive (HDD) with the faster access speed of a solid state drive (SSD). The HDD is the primary storage device, and the SSD acts as a cache for recently accessed data. However, the Fusion Drive does not have built-in caching logic, and the operating system treats the two drives as separate storage devices.   Apple created [Core Storage](https://en.wikipedia.org/wiki/Core_Storage) to support the desired caching capabilities and the ability to pool the storage of each device into a single logical volume. APFS removes the need for Core Storage by having first-class support for this tiered storage model.  This post will go into more detail about APFS _Fusion Containers_.

## Physical Stores

Both the SSD and HDD of a Fusion Drive appear to macOS as separate physical disk devices.  Both disks are [GPT](https://en.wikipedia.org/wiki/GUID_Partition_Table) partitioned with a standard EFI partition and a second, larger partition, which takes up the bulk of the space on disk.  For example, running the command `diskutil list` may show the HDD as `/dev/disk0` with its primary partition as `/dev/disk0s2` and the SSD as `/dev/disk1` and `/dev/disk1s2`.  These two partitions make up the _physical stores_ of the Fusion Container.

Each physical store is formatted separately in much the same way as any other APFS container.  Both will share the same `nx_uuid` in their _NX Superblocks_ and have a separate, nearly-identical UUID in the `nx_fusion_uuid` field, with the _most significant bit_ being cleared on the `tier1` SSD partition and set on the `tier2` HDD partition.  The combination of these UUIDs can be used to identify the physical storage tiers of the container.

## Synthesized Container

Both tiers are mapped together as a single "synthesized" container and are presented to macOS as a single logical block device (for example, `/dev/disk2`). The `tier1` blocks are mapped at logical byte offset zero, and the `tier2` blocks at 4 EiB. The offsets within the exabyte-scale gap between the two sets of blocks cannot be read.  

APFS objects and blocks can be stored on either (or both) tiers, and their physical addresses will require some simple translation as follows:

```cpp
#define FUSION_TIER2_DEVICE_BYTE_ADDR 0x4000000000000000ULL
const paddr_t first_tier2_block = FUSION_TIER2_DEVICE_BYTE_ADDR / nxsb->block_size;

if (paddr < first_tier2_block) {
  tier1->read_block(paddr); 
} else {
  tier2->read_block(paddr – first_tier2_block);
}
```

The logically exabyte-scale gap separating the two tiers presents a unique problem during digital forensic imaging of Fusion Containers.  To preserve the logical offsets of the evidence without having to use a data center worth of storage, you must use an evidence storage format that supports _sparse_ imaging.  As long as this is considered along with the additional physical address translation described above, analyzing Fusion Containers does not generally differ from analyzing other APFS containers.
