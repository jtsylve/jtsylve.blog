---
layout: post
title: 2022 APFS Advent Challenge Day 6 - B-Trees (Part 1)
---

In [yesterday's post](/post/2022/12/07/APFS-Checkpoint-Maps), we discussed Checkpoint Maps, the simple linear-time data structures that APFS uses to manage persistent, ephemeral objects.  Today, we will give a general overview of B-Trees and detail the layout and on-disk structures of B-Tree Nodes.  

## Background

A [B-Tree](https://en.wikipedia.org/wiki/B-tree) is a self-balancing tree data structure that maintains sorted data and allows for fast search, insertion, and deletion operations.  B-Trees are a generalization of binary trees that enable each node to have more than two children, increasing the number of key/value pairs and thus the fan-out.  B-Trees are self-balancing – automatically adjusting their structure to maintain a specific balance factor that guarantees operations in [logarithmic time](https://en.wikipedia.org/wiki/Time_complexity#Logarithmic_time).

B-Trees are used in APFS to store and reference many different objects and data types.  APFS B-Trees differ from traditional implementations in several ways.  Leaf nodes store values, and non-leaf nodes store their children's _object identifiers_ (`oids`).  Because `oids` are usually smaller than values, non-leaf nodes in APFS can reference more children than other implementations, reducing tree depth and increasing fan-out. B-Tree nodes in APFS support fixed or variable-length keys and values. This flexibility enables the storage of heterogeneous types of data.  APFS provides for the specialization of B-Tree sub-objects that define their configuration and storage order.  APFS B-Trees are well-suited for storing large amounts of data on disk or other sequential access storage devices.

## On-Disk Structure and Layout

There are two types of APFS B-Tree node objects, and their layout differs slightly: _B-Tree Root Node Objects_ and _B-Tree Node Objects_.  Traversal of APFS B-Trees must start from a Root Node Object because nodes only store references to their children, not their siblings.

![Structure of a Root B-Tree Node](/images/advent2022/btree-root-node.png)

{: .caption style="font-size: small; font-weight: bold; text-align: center; margin: -25px 0 0 0"}
Structure of a Root B-Tree Node

![Structure of a Non-Root B-Tree Node](/images/advent2022/btree-non-root-node.png)

{: .caption style="font-size: small; font-weight: bold; text-align: center; margin: -25px 0 0 0"}
Structure of a Non-Root B-Tree Node

The layout of _root_ nodes differs from _non-root_ nodes in that they end with a `btree_info_t` structure.  This structure gives information about the entire B-Tree.  To avoid data duplication and to make more efficient use of space, non-root nodes do not store a copy of this information.

### B-Tree Info

```cpp
typedef struct btree_info_fixed {
    uint32_t bt_flags;     // 0x00
    uint32_t bt_node_size; // 0x04
    uint32_t bt_key_size;  // 0x08
    uint32_t bt_val_size;  // 0x0C
} btree_info_fixed_t;      // 0x10
```
- `bt_flags`: A set of B-Tree node flags
- `bt_node_size`: The on-disk size, in bytes, of a node in this B-Tree
- `bt_key_size`: The size of a key, or zero if the keys have variable size
- `bt_val_size`: The size of a value, or zero if the values have variable size

```cpp
typedef struct btree_info {
    btree_info_fixed_t bt_fixed; // 0x00
    uint32_t bt_longest_key;     // 0x10
    uint32_t bt_longest_val;     // 0x14
    uint64_t bt_key_count;       // 0x18
    uint64_t bt_node_count;      // 0x20
} btree_info_t;                  // 0x28
```
- `bt_fixed`: Information about the B-tree that doesnʼt change over time
- `bt_longest_key`: The size (in bytes) of the largest key stored in the tree
- `bt_longest_val`: The size (in bytes) of the largest value stored in the tree
- `bt_key_count`: The number of keys stored in the B-Tree
- `bt_node_count`: The number of nodes that make up the B-Tree

#### B-Tree Flags

{: style="margin-left: 0"}
| Name | Value | Description |
|------|-------| ------------|
BTREE_UINT64_KEYS | 0x00000001 | Keys are all of type `uint64_t`
BTREE_SEQUENTIAL_INSERT | 0x00000002 | Keys are inserted sequentially 
BTREE_ALLOW_GHOSTS | 0x00000004 | Allow keys with no corresponding value
BTREE_EPHEMERAL | 0x00000008 | Child node `oids` are _ephemeral_
BTREE_PHYSICAL | 0x00000010 | Child node `oids` are _physical_
BTREE_NONPERSISTENT | 0x00000020 | _never found on disk_
BTREE_KV_NONALIGNED | 0x00000040 | Keys and values aren't 8-byte aligned
BTREE_HASHED | 0x00000080 | Non-leaf nodes store child hashes
BTREE_NOHEADER | 0x00000100 | Nodes are all stored without headers


### Header

Both types of node objects begin with a `btree_node_phys_t` structure.

```cpp
// A location within a B-tree node.
typedef struct nloc {
    uint16_t off; // 0x00
    uint16_t len; // 0x02
} nloc_t;         // 0x04
```
- `off`: The context-specific offset (in bytes)
- `len`: The length (in bytes)

```cpp
typedef struct btree_node_phys {
    obj_phys_t btn_o;         // 0x00
    uint16_t btn_flags;       // 0x20
    uint16_t btn_level;       // 0x22
    uint32_t btn_nkeys;       // 0x24
    nloc_t btn_table_space;   // 0x28
    nloc_t btn_free_space;    // 0x2C
    nloc_t btn_key_free_list; // 0x30
    nloc_t btn_val_free_list; // 0x34
} btree_node_phys_t;          // 0x38
```
- `btn_o`: The node's [object header](/post/2022/12/01/Anatomy-of-an-APFS-Object)
- `btn_flags`: A set of node-specific bit-flags
- `btn_level`: The number of child levels below this node
- `btn_nkeys`: The number of keys stored in this node
- `btn_table_space`: The location of the table of contents relative to the end of the `btree_node_phys_t` structure
- `btn_free_space`: The location of free space relative to the beginning of the _key area_
- `btn_key_free_list`: A linked list that tracks free space in the _key area_
- `btn_val_free_list`: A linked list that tracks free space in the _value area_

#### Node Flags

{: style="margin-left: 0"}
| Name | Value | Description |
|------|-------| ------------|
BTNODE_ROOT | 0x0001 | Root node 
BTNODE_LEAF | 0x0002 | Leaf node 
BTNODE_FIXED_KV_SIZE | 0x0004 | Fixed-sized keys and values 
BTNODE_HASHED | 0x0008 | Node contains child hashes 
BTNODE_NOHEADER | 0x0010 | Node is stored without an object header 
BTNODE_CHECK_KOFF_INVAL | 0x8000| _never found on disk_

### Table of Contents

Each node has a _table of contents_ (ToC) which stores an entry to each key/value pair contained in the node.  The table space can be located by reading the `btn_table_space` member of the header.  The start of this area is `btn_table_space.off` bytes after the `btree_node_phys_t` and is `btn_table_space.len` bytes in size.

ToC entries identify the location of key and value data in their respective storage areas.  The structure of these entries differs depending on whether the `BTNODE_FIXED_KV_SIZE` flag is set in the header.  When this flag is set, `kvoff_t` structures in the ToC store offsets of keys and values relative to their respective storage areas.

```cpp
// The location, within a B-tree node, of a fixed-size key and value.
typedef struct kvoff {
    uint16_t k; // 0x00
    uint16_t v; // 0x02
} kvoff_t;      // 0x04
```
- `k`: Offset of the key (relative to the start of the _key area_)
- `v`: Offset of the value (relative to the end of the _value area_)

It is necessary to store both offsets and sizes for nodes with variable keys.

```cpp
// The location, within a B-tree node, of a key and value.
typedef struct kvloc {
    nloc_t k; // 0x00
    nloc_t v; // 0x04
} kvloc_t;    // 0x08
```
- `k`: Location of the key (relative to the start of the _key area_)
- `v`: Location of the value (relative to the end of the _value area_)


### Key Area

The area where key data is stored is called the _key area_ and begins immediately after the _table space_.  The size of this area grows downward towards the end of the node.  Key offsets in the ToC are relative to the start of this area.

### Value Area

The area where value data is stored is called the _value area_. For non-root nodes, the value area starts at the end of the node.  For root nodes, the start is before the `btree_info_t` structure.  This area grows upward towards the beginning of the node, and value offsets in the ToC are interpreted as negative offsets relative to this point.


## Conclusion

B-Trees are data structures that provide fast access and efficient storage of key/value data.  B-Trees are widely used in APFS and serve several specialized purposes.  

In the next post, we will continue our discussion of B-Trees and detail methods of enumerating and looking up their referenced objects.

{% include advent2022.html %}