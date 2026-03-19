---
layout: post
title: 2022 APFS Advent Challenge Day 1 - Anatomy of an Object
---

APFS is a _copy-on-write_ file system, consisting of a set of immutable objects that are the fundamental building blocks of the file system's design.  _APFS objects_ are made up of one or more fixed-size _blocks_.  Block sizes are configurable at the time of formatting a new container.  Valid block sizes are any power-of-two sized value between 4 KiB and 64 KiB of data, and must always be an integer multiple of the block size of the underlying storage device.  At the time of this writing, the default (and thus most common) block size is 4 KiB.


## Object Headers

While some objects are _headerless_, most begin with an `obj_phys_t` structure as their header.  Like all APFS on-disk objects, this structure is stored with _little-endian_ values.

```cpp
#define MAX_CKSUM_SIZE 8

typedef uint64_t oid_t;
typedef uint64_t xid_t;

typedef struct obj_phys {
    uint8_t o_cksum[MAX_CKSUM_SIZE]; // 0x00
    oid_t o_oid;                     // 0x08
    xid_t o_xid;                     // 0x10
    uint32_t o_type;                 // 0x18
    uint32_t o_subtype;              // 0x1C
} obj_phys_t;                        // 0x20
```

The object headers are immediately followed by type-specific data, and any remaining space between the object's data and the end of its last block is always zeroed and is reserved for future use.


## Checksum

The integrity of an on-disk APFS object's data can be verified by calculating a `Fletcher-64` checksum of all the object's data after the first 8 bytes.  This checksum can be compared with the value of the `o_cksum` field in the object's header.  If these values do not match, then the object is either only partially flushed to disk or is otherwise corrupted.  Note that like most uses of checksums, this is not a security feature, but is only used to detect unintentionally corrupted data.

```cpp
uint64_t fletcher64(const void* data, size_t size) {
    uint64_t sum1 = 0;
    uint64_t sum2 = 0;

    // Calculate the number of 32-bit words
    size_t words_left = size / sizeof(uint32_t);

    // Interpret the data as a set of 32-bit words
    const uint32_t* words = static_cast<const uint32_t*>(data);

    while (words_left > 0) {
        // Truncate sums after a maximum of 1024 words
        const size_t n = std::min(words_left, size_t{1024});

        // Compute the checksums
        for (size_t i = 0; i < n; i++) {
            sum1 += words[i];
            sum2 += sum1;
        }

        // Calculate the modulo of the sums
        sum1 %= UINT32_MAX;
        sum2 %= UINT32_MAX;

        words_left -= n;
        words += n;
    }

    // Calculate the value needed to be able to get a checksum of zero
    const uint64_t ck_low = UINT32_MAX - ((sum1 + sum2) % UINT32_MAX);
    const uint64_t ck_high = UINT32_MAX - ((sum1 + ck_low) % UINT32_MAX);

    // Combine the sums
    return ck_low | (ck_high << 32);
}
```


## Object and Transaction IDs

Each object has a unique 8-byte object identifier (`oid`), which is stored in the header's `o_oid` field, along with an 8-byte transaction identifier (`xid`).  Most APFS objects are immutable.  When a change is made and flushed to disk, an entirely new object is created elsewhere on disk and is assigned the same `oid` as the original object, but with a higher `xid`.  

Once the updated object has been fully flushed to disk, and all other objects that reference the original object have been updated to reference the newer object, the transaction is considered complete and the original object's blocks are free to be reused by APFS.  While these blocks are not immediately wiped for reuse, the lifetime of unreferenced objects is relatively short.


## Types and Subtypes

The remaining two fields in the header encode the object's type and (optional) subtype identifiers.  Each distinct APFS object type is assigned a unique _type identifier_.  With few exceptions, this identifier is stored in the 16 _least-significant_ bits of the `o_type` field in the header, with the 16 _most-significant_ bits being used for type flags.

The following is a list of all currently-known object types and their identifiers.  We will discuss the details of many of them throughout the course of this blog series.

| Object Type | Type Identifier | Description | Structure |
| ------------- | ------------- | ----------- | --------- |
| NX_SUPERBLOCK | 0x01 | Container Superblock | `nx_superblock_t` |
| BTREE | 0x02 | B-Tree Root Node | `btree_node_phys_t` |
| BTREE_NODE | 0x03 | B-Tree Node | `btree_node_phys_t` |
| MTREE | 0x04 | M-Tree | _undocumented type_ |
| SPACEMAN | 0x05 | Space Manager | `spaceman_phys_t` |
| SPACEMAN_CAB | 0x06 | Space Manager Chunk-Info Address Block | `cib_addr_block` | 
| SPACEMAN_CIB | 0x07 | Space Manager Chunk-Info Block | `chunk_info_block` |
| SPACEMAN_BITMAP | 0x08 | Space Manager Free-Space Bitmap | _raw block of bits_ |
| OMAP | 0x0b | Object Map | `omap_phys_t` |
| CHECKPOINT_MAP | 0x0c | Checkpoint Map | `checkpoint_map_phys_t` |
| FS | 0x0d | Volume | `apfs_superblock_t` |
| NX_REAPER | 0x11 | Reaper | `nx_reaper_phys_t` |
| NX_REAP_LIST | 0x12 | Reaper List | `nx_reap_list_phys_t` |
| EFI_JUMPSTART | 0x14 | EFI Boot Information | `nx_efi_jumpstart_t` |
| NX_FUSION_WBC | 0x16 | Fusion Write-Back Cache State | `fusion_wbc_phys_t` |
| NX_FUSION_WBC_LIST | 0x17 | Fusion Write-Back Cache List | `fusion_wbc_list_phys_t` |
| ER_STATE | 0x18 |  Rolling Encryption State | `er_state_phys_t` |
| GBITMAP | 0x19 | General Purpose Bitmap | `gbitmap_phys_t` |
| GBITMAP_BLOCK | 0x1b | General Purpose Bitmap Block | `gbitmap_block_phys_t` |
| ER_RECOVERY_BLOCK | 0x1c | Rolling Encryption Recovery State | `er_recovery_block_phys_t` |
| SNAP_META_EXT | 0x1d | Additional Snapshot Metadata | `snap_meta_ext_obj_phys_t` |
| INTEGRITY_META | 0x1e | Integrity Metadata | `integrity_meta_phys_t` |

There are three additional known object types that use all 32-bits of the `o_type` header field and do not contain type flags.

| Object Type | Type Identifier | Description | Structure |
| ------------- | ------------- | ----------- | --------- |
| CONTAINER_KEYBAG | 0x7379656b | Container Keybag | `media_keybag_t` |
| VOLUME_KEYBAG | 0x73636572 | Volume Keybag | `media_keybag_t` |
| MEDIA_KEYBAG  | 0x79656b6d | Media Keybag | `media_keybag_t` |


B-Tree objects also contain subtypes, which help identify the specific purpose of the tree.  These subtype identifiers are stored in the header's `o_subtype` field.  The following is a list of known b-tree subtypes and the structures that they map.

| Object Subtype | Subtype Identifier | Description | Key Structure | Value Structure |
| --------------- | --------------- | ----------- | ------------- | --------------- |
| SPACEMAN_FREE_QUEUE | 0x09 | Space Manager Free-Space Queue | `spaceman_free_queue_key_t` | `spaceman_free_queue_t` |
| EXTENT_LIST_TREE | 0x0a | Logical to Physical Mapping of Extents | `paddr_t` | `prange_t` |
| OMAP | 0x0b | Object Map | `omap_key_t` | `omap_val_t` |
| FSTREE | 0x0e | File-System Record Tree | `j_key_t` | _variable_ |
| BLOCKREFTREE | 0x0f | Extent Reference Tree | `j_phys_ext_key_t` | `j_phys_ext_val_t` |
| SNAPMETATREE | 0x10 | Snapshot Metadata Tree | `j_key_t` | _variable_ |
| OMAP_SNAPSHOT | 0x13 | Omap Snapshot Info | `xid_t` | `omap_snapshot_t` |
| FUSION_MIDDLE_TREE | 0x15 | Tracks Cached SSD Fusion Blocks | `fusion_mt_key_t` | `fusion_mt_val_t` |
| GBITMAP_TREE | 0x1a | General Purpose Bitmap Tree | `uint64_t` | `uint64_t` |
| FEXT_TREE | 0x1f | File Extents | `fext_tree_key_t` | `fext_tree_val_t` |

### Type Flags

As previously mentioned, when object types are indicated in object headers and other APFS structures, they are usually combined with up to 16 bits of flags that give extra information.  The currently defined flags are as follows:

```cpp
// Object Kind Flags
#define OBJ_VIRTUAL 0x00000000
#define OBJ_EPHEMERAL 0x80000000
#define OBJ_PHYSICAL 0x40000000

// Other Flags
#define OBJ_NOHEADER 0x20000000
#define OBJ_ENCRYPTED 0x10000000
#define OBJ_NONPERSISTENT 0x08000000
```

The two _most-significant_ bits are used to denote the _kind_ of APFS object: virtual, ephemeral, or physical.  All APFS objects fit into one of these three categories.  The difference between these will be the subject of tomorrow's post.

If the `OBJ_NOHEADER` flag is set, then the object type in question does not start with an `obj_phys_t` header.  These types of objects are rare, and so far I've only seen it used for _space manager bitmap_ objects.  Note that these objects are different than the _headerless_ objects that are used in sealed volumes, which we will discuss in a future post.

The `OBJ_ENCRYPTED` flag denotes an object that is always encrypted on disk, and the `OBJ_NONPERSISTENT` flag denotes an object that is never written to disk at all (this flag will only be set for ephemeral objects in memory that do not require persistence).

{% include advent2022.html %}
