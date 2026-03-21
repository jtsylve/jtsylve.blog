---
layout: post
title: Kinds of Objects
series: "APFS Internals"
series_part: 2
categories: [file-systems, apfs]
tags: [apfs, objects, virtual, physical, ephemeral]
---

As we discussed in [our last post](/post/2022/12/01/Anatomy-of-an-APFS-Object), _objects_ are the fundamental building blocks of APFS.  While there are many different object _types_, each individual object can be one of three _kinds_: _physical_, _virtual_, or _ephemeral_.  While each of these objects can be found on disk, there are differences in their lifetimes as well as the techniques needed to locate them.

## Physical Objects

_Physical Objects_ are objects that are always stored at a fixed location on disk.  You can think of these kinds of objects as being "owned" and managed directly by the APFS Container itself. (We will discuss containers in an upcoming post in this series.)

Locating a physical object on disk via its _object identifier_ (`oid`) is trivial, because its `oid` will always be the same as its starting block number.  APFS block numbers are zero-indexed; therefore, we can locate a physical object on disk by multiplying its `oid` by the block size of the container.  For example, if we have an APFS container that is configured with a 0x1000 byte (4 KiB) block size, the physical object with `oid` 5 will be located at byte offset 0x5000 of the physical storage media.

_NOTE: These calculations can be slightly more complicated when dealing with Fusion Containers, but we'll discuss those details in a future post._

Because physical objects use direct addressing, there can only ever be one version of these objects on disk.  If a physical object is copied, an entirely new physical object will be created with a different `oid`.  Once an APFS object is no longer being referenced by any other object, its underlying storage blocks are subject to reuse.  If they are ever reused by another physical object, the newer object will have the same `oid`, but can be differentiated from the original object given that it will have a higher _transaction identifier_ (`xid`).

## Virtual Objects

_Virtual Objects_ represent the majority of all objects in APFS.  They are not stored at fixed locations on disk, and do not have direct relationships between their `oid` and storage location.  All virtual objects are "owned" by an _Object Map_ (`OMAP`).  OMAPs are tree-like structures that are used to manage the lifetimes of virtual objects and are used to look up their block-storage location on disk.  You can look forward to a detailed discussion of object maps in a future post in this series.  Suffice it to say that OMAPs are key/value stores that allow you to efficiently locate a virtual object's blocks by using its `oid` and `xid` as keys.

This indirect mapping of virtual objects allows for quite a bit of flexibility.  Because they are not limited to a fixed block-address, virtual objects can be relocated on disk at any time by updating their storage location in their object map.  

APFS is a copy-on-write (`CoW`) file system, which means that the contents of APFS virtual objects are immutable on disk.  Changes to virtual objects are handled by the creation of an entirely new virtual object with the same `oid` and an updated `xid`. As newer transactions are flushed to disk, older transactions are invalidated, their objects will no longer be referenced by any active objects, and their block storage may be reused.

Another feature of OMAPs is that they can extend the lifetime of objects from earlier transactions by maintaining references to more than one version of the same object.  Since these earlier transactions are still "reachable", they are considered to be active and will be preserved.  This can be very useful for "rolling back" the state of APFS to an earlier point-in-time.  The _APFS Snapshot_ feature is built upon this inherent property of OMAPs (more on this in a future post).

## Ephemeral Objects

The copy-on-write nature of APFS objects is great for fault tolerance.  For example, if power is lost while a transaction is only partially through the process of being written to disk, data corruption can be avoided, because the system can just revert to the latest _valid_ transaction.  This completely removes the need for a file system transaction log.

Of course, `CoW` comes at a cost.  There are some objects that need to be updated much too frequently to be flushed to disk as part of a transaction on every change.  These frequently-updated objects also tend to not require strict data integrity guarantees or strong fault tolerances.  Two prime examples are the objects that track performance counters and garbage collection state.

Some objects require no persistence at all and are only resident in-memory.  Since we won't find those on disk, we don't need to be concerned with them at the moment.  Others spend the majority of their lifetimes in-memory when APFS is mounted and are only flushed to disk periodically (or when APFS is cleanly unmounted) for persistence.  These types of objects are known as _ephemeral_.

Like virtual objects, ephemeral objects are not located at fixed locations on disk and there is no direct mapping between `oid` and storage blocks.  Ephemeral objects are "owned" by _checkpoint maps_, which are responsible for managing their on-disk lifetime and providing translation capabilities between `oid` and on-disk storage locations (more on these in the future).

Given that we have limited guarantees about when and how often these objects are flushed to disk, ephemeral objects are limited to only those that are not critical to preserving the integrity of users' data, and that can be reconstructed entirely (or from previous versions) on-demand.  Still, ephemeral objects play an important role in APFS.  We will discuss several of the kinds of objects throughout this series.

