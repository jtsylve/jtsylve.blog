---
layout: post
title: Checkpoint Maps and Ephemeral Objects
series: "APFS Internals"
series_part: 5
categories: [file-systems, apfs]
tags: [apfs, checkpoints, ephemeral]
---

In our [last post](/post/2022/12/06/APFS-NX-Superblock), we discussed _NX Superblock Objects_ and how they can be used to locate the _Checkpoint Descriptor Area_ in which they are stored.  Today, we will discuss the other type of objects that are stored in the descriptor area, _Checkpoint Maps_, and how they can be used to find persistent, ephemeral objects on disk. 

## On-Disk Structures

Each _Checkpoint Mapping_ structure gives information about a single ephemeral object that is stored in the _Checkpoint Data Area_.

```cpp
typedef struct checkpoint_mapping {
    uint32_t cpm_type;     // 0x00
    uint32_t cpm_subtype;  // 0x04
    uint32_t cpm_size;     // 0x08
    uint32_t cpm_pad;      // 0x0C
    oid_t cpm_fs_oid;      // 0x10
    oid_t cpm_oid;         // 0x18
    oid_t cpm_paddr;       // 0x20
} checkpoint_mapping_t;    // 0x28
```

- `cpm_type`: The type of the mapped object
- `cpm_subtype`: The (optional) subtype of the mapped object
- `cpm_size`: The size (in-bytes) of the mapped object
- `cpm_pad`: _reserved padding_
- `cpm_fs_oid`: The _virtual_ object identifier of the file system that owns the ephemeral object
- `cpm_oid`: The _object identifier_ of the mapped object
- `cpm_paddr`: The physical address of the start of the object

_Checkpoint Map Objects_ contain a simple array of `checkpoint_mapping_t` structures.  Each entry in the map corresponds to an ephemeral object stored in the _Checkpoint Data Area_.  If there are more mappings than can fit into a single Checkpoint Map Object, additional map objects are added to the _Checkpoint Descriptor Area_.  A Checkpoint's final Checkpoint Map Object is marked with the `CHECKPOINT_MAP_LAST` flag.

```cpp
#define CHECKPOINT_MAP_LAST 0x00000001

typedef struct checkpoint_map_phys {
    obj_phys_t cpm_o;               // 0x00
    uint32_t cpm_flags;             // 0x20
    uint32_t cpm_count;             // 0x24
    checkpoint_mapping_t cpm_map[]; // 0x28
} checkpoint_map_phys_t;
```

- `cpm_o`: The [object header](/post/2022/12/01/Anatomy-of-an-APFS-Object)
- `cpm_flags`: A set of bit-flags.  Currently, only `CHECKPOINT_MAP_LAST` is defined
- `cpm_count`: The number of mappings stored in this Checkpoint Map
- `cpm_map`: An array of `cpm_count` Checkpoint Mappings


## Locating Ephemeral Objects

Once you've identified the location of the Checkpoint Data Area, enumeration of on-disk ephemeral objects is simple.  _NOTE: You cannot rely on the block-zero NX Superblock copy.  You must locate the NX Superblock that belongs to the Checkpoint you're examining._

Because there are relatively few persistent, ephemeral objects, [linear time](https://en.wikipedia.org/wiki/Time_complexity#Linear_time) enumeration of all of a checkpoint's mappings is practical.  This means that there aren't any complex data structures that get in between us and the objects that we're looking for.

1. The `nx_xp_desc_index` member of the Checkpoint's `nx_superblock_t` stores a zero-based block index into the Checkpoint Descriptor Area.  This is the location of the first Checkpoint Map Object.  Locate this object and validate it using the checksum stored in its object header.

2. Read the `cpm_count` member of the Checkpoint Map.  This contains the number of Checkpoint Mappings stored in the current map.

3. Enumerate the mappings stored in the `cpm_map` array.  These mappings each contain information about an on-disk ephemeral object, including the physical block address in which it is stored.

4. Once all mappings have been enumerated, read the `cpm_flags` member.  If the bit defined in `CHECKPOINT_MAP_LAST` is set, you've reached the end of your journey; otherwise, there are more ephemeral objects to enumerate.

5. The next Checkpoint Map Object should follow the current map object, but it is important to remember that the Checkpoint Descriptor Area acts as a [circular buffer](https://en.wikipedia.org/wiki/Circular_buffer).  You can determine the number of blocks in the Checkpoint Descriptor Area, by reading the `nx_xp_desc_blocks` member of the NX Superblock and ignoring the _most-significant bit_.  If the current map is stored in the last block of the descriptor area, then the next map will be stored in the first.

```c++
// calculating the next index in the circular buffer
next_index = current_index + 1;
if (next_index == (nx_xp_desc_blocks & 0x7FFFFFFF)) {
    next_index = 0;
}

// alternatively...
next_index = (current_index + 1) % (nx_xp_desc_blocks & 0x7FFFFFFF);
```

## Conclusion

Compared to other kinds of objects in APFS, each checkpoint only maintains a relatively small number of on-disk ephemeral objects.  Due to their nature, these objects are likely all read into memory at once when the Checkpoint is mounted.  Thanks to these facts, ephemeral objects are stored on disk in a way that is relatively simple for us to find and enumerate.

If only it were always that simple...  Next up in this series we will discuss B-Trees -- APFS's method of choice for referencing potentially large sets of data on disk.

