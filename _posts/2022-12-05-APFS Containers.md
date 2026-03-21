---
layout: post
title: Containers
series: "APFS Internals"
series_part: 3
categories: [file-systems, apfs]
tags: [apfs, containers]
---

APFS is a _pooled storage_, _transactional_, _copy-on-write_ file system.  Its design relies on a core management layer known as the _Container_.  APFS containers consist of a collection of several specialized components: The _Space Manager_, the _Checkpoint Areas_, and the _Reaper_.  In today's post, we will give an overview of APFS containers and these components.

## History

Prior to the introduction of APFS, Apple's primary file system of choice was [HFS+](https://en.wikipedia.org/wiki/HFS_Plus).  HFS+ is a _journaling file system_ that was introduced by Apple in 1998 as an improvement over its legacy HFS file system. 

Like most file systems of its era, each HFS+ volume can only manage the space of a single physical disk partition.  While it is possible to have more than one HFS+ volume on a disk, the limitation of "one volume per partition" requires that the storage space for each volume be fixed and pre-allocated.  This means that HFS+ volumes that are low on storage space cannot make use of any available free space elsewhere on disk.

In 2012, Apple introduced its hybrid [Fusion Drives](https://en.wikipedia.org/wiki/Fusion_Drive), which consist of a larger _hard disk drive (HDD)_ combined with a smaller, but faster _solid state drive (SSD)_ in a single package.  The HDD is intended to be used as the primary storage device, providing the baseline storage capacity, and the SSD provides faster access to the most recently accessed data by acting as a cache. 

This caching logic is not built into the fusion drive hardware.  The two drives are presented to the operating system as separate storage devices.  HFS+ does not have the ability to span a volume across multiple partitions, and it was not designed to support the desired caching mechanisms.

Rather than massively overhauling HFS+ to support these new capabilities, Apple decided instead to add an additional storage layer, called [Core Storage](https://en.wikipedia.org/wiki/Core_Storage).  Core Storage acts as a _logical volume manager_ that has the ability to pool the storage of multiple devices on the same drive into a single, logical volume.  It also implements a _tiered storage model_ that allows blocks to be duplicated and cached on Fusion drives.  Incidentally, Core Storage also provides the mechanism for the volume-level encryption facilities of _File Vault_ on HFS+ systems.  Because HFS+ only sees a single logical volume, these complexities are completely transparent to the file system's implementation.

Apple introduced APFS in 2017.  The design of APFS takes many lessons from both HFS+ and Core Storage, and eliminates the need for both of them.


## Space Manager

APFS containers provide pooled and tiered storage capabilities, without the need for a Core Storage layer.  It presents one logical view of storage, whose blocks can be shared among multiple volumes without the need for pre-partitioning and pre-allocation of space.  As volumes' storage requirements change over time, blocks are allocated or returned to the container.  This allows for quite a bit of flexibility, as you can now have multiple volumes that serve different _roles_ without having to figure out their space requirements ahead of time.  For example, you can now have more than one _system_ volume with different versions on macOS installed that can share the same user _data_ volume.

It supports storage devices as small as 1 MiB in size (APFS on a 1.44 MiB HD floppy, anyone?) and has no apparent upper storage limit.  It supports the sharing of blocks among as many as 100 volumes (with some limitations).  In addition to that hard-coded upper maximum of 100 volumes, APFS requires that there can be no more than one volume per 512 MiB of storage space.  This helps limit storage contention and reduces the amount of space needed to maintain file system metadata on-disk.

The Space Manager keeps track of which blocks across storage tiers are in-use.  It is also responsible for the allocation and freeing of blocks for volumes on-demand.

## Checkpoint Areas

As mentioned in [last Friday's post](/post/2022/12/02/Kinds-of-APFS-Objects), APFS provides fault tolerance by batching together copies of updated objects and committing them to disk in transactions known as _checkpoints_.  This transactional, copy-on-write strategy ensures that there is always at least one valid and complete set of APFS objects on disk.  The latest checkpoint may be used as the authoritative source of information and since checkpoints aren't immediately invalidated, the entire state of APFS can be reverted to an earlier point in time.

APFS containers maintain two distinct checkpoint areas. The _Checkpoint Data Area_, which is reserved for storage of _ephemeral_ objects, and the _Checkpoint Descriptor Area_. 

The Checkpoint Descriptor Area provides a logically (but not necessarily physically) contiguous area on disk that is reserved to act as a [circular buffer](https://en.wikipedia.org/wiki/Circular_buffer) to store two types of objects that are used to store information about checkpoints: _Checkpoint Map Objects_ and _NX Superblock Objects_.  

After a checkpoint is flushed to disk, both types of objects are written to the descriptor area.  The Checkpoint Map Objects provide a list of all ephemeral objects, their types, and their storage location within the checkpoint data area.  A NX Superblock object is written to the descriptor area buffer after the map objects.  This superblock is the root object of APFS and serves as the initial source of information about the state of the container in each checkpoint.  All other valid objects in APFS are either directly or indirectly reachable from the NX superblock object.

## Reaper

Once a checkpoint transaction is successfully flushed to disk, APFS may choose to invalidate the oldest checkpoint.  At this point, all newly unreferenced objects are subject to a process of garbage collection, where their blocks can be wiped and returned to the space manager for reuse.  The Reaper is responsible for managing this garbage collection process, keeping track of the state of objects so that they may be freed across transactions.

## Conclusion

Containers provide the core management layer of APFS using several specialized subsystems.  This post gives a general overview of each of these components.  Future posts in this series will discuss each of these components in more detail, including information on how to interpret their on-disk structures.
