---
layout: post
title: B-Trees (Part 2)
series: "APFS Internals"
series_part: 7
categories: [file-systems, apfs]
tags: [apfs, btrees, indexing]
---

Mastering the skill of B-Tree traversal is essential in parsing information from APFS. Our [last post](/post/2022/12/08/APFS-BTrees) gave an overview of APFS B-Trees, their layout, and on-disk node structures.  Today, we will discuss applying that knowledge to perform enumeration and fast lookups of referenced objects.  

## Overview

Traversal of APFS B-Trees always starts at the _root node_, which can be identified by having the `BTNODE_ROOT` bit-flag set in the `bt_flags` field of its `btree_node_phys_t` header. Each B-Tree can only have a single root node. Root nodes only differ from the other nodes in that their storage space is slightly more limited to make room for the `btree_info_t` structure, which stores information about the entire tree.

You can visualize an APFS B-Tree as a root node on the highest level, branching downward for each generation of children. The nodes at the lowest level (level-zero) are called _leaf nodes_ and have the `BTNODE_LEAF` bit-flag in their header. Single-level B-Trees consist of a solitary node that is both a root and leaf node. Two-level B-Trees have a single root node whose immediate children are leaf nodes. B-Trees with more than two levels will have intermediary nodes that are neither root nor leaf nodes.

Unique, sortable keys reference each value in a B-Tree. When a B-Tree is created, the _key/value pairs_ (k/v) are sorted in a context-specific manner that is specific to how the tree is used.  The pairs are then written to as few level-zero leaf nodes as possible.  The leaf nodes are evenly allocated among parent nodes, which reference their children by storing a copy of the first key in the child, which is mapped to the child node’s _object identifier_ (`oid`).  Higher order levels are created, as necessary, until reaching a single root node.

## Enumerating B-Trees

APFS B-Tree nodes have three storage areas: the _table space_, the _key area_, and the _value area_.  The table space contains the table of contents, which stores the location of each key-value pair within the node. If the `BTNODE_FIXED_KV_SIZE` flag is set in the node’s header flags, the table of contents only stores offsets for keys and values. Otherwise, it also stores their lengths.

Identify the location of the table space within the node by reading the `btn_table_space` member of the node's header.  This table space begins at `btn_table_space.off` bytes after the node's header and is `btn_table_space.len` bytes in length.  The remaining storage space in the node is used for the key and value areas.  We will refer to this space collectively as the _k/v area_.  

_Remember: The k/v area is 0x28 bytes smaller in root nodes due to the btree info stored at the end._

The table of contents is an array of either type `kvoff_t` (for fixed-size k/v pairs) or `kvloc_t` elements.  Read the size of this array from the `btn_nkeys` field of the node header.  Each array element corresponds to a k/v pair.  Key offsets are relative to the beginning of the k/v area and value offsets from the end.  Enumerating through this array allows you to locate the data associated with each key and value in the node.

_NOTE: B-Trees with the `BTREE_ALLOW_GHOSTS` flag can sparsely populate values.  The value 0xFFFF stored in the offset field of an entry in the table of contents indicates that there is no associated value for a given key stored in the node._

Leaf nodes give direct access to values, so no further effort is required in these cases. For non-leaf nodes, the stored value can be interpreted as an object identifier. The btree info may contain either the `BTREE_EPHEMERAL` or `BTREE_PHYSICAL` flags or neither. This indicates whether non-root nodes are _physical_, _ephemeral_, or _virtual objects_. Physical nodes can be directly addressed by their object identifiers. Ephemeral nodes need to be looked up using [Checkpoint Maps](/post/2022/12/07/APFS-Checkpoint-Maps). Virtual nodes require querying Object Maps (discussed in the next post). In all cases, locate each child node using the appropriate method and continue the enumeration process.

## Faster Lookups of Specific Values

We could use enumeration to look up a value by its key as with Checkpoint Maps, but that would require _linear time_. We can use the copies of the key information stored in non-leaf nodes for much faster _logarithmic-time_ lookups. When analyzing a non-leaf node, identify the key closest to, but not ordered after, the desired key. We can then continue the search by analyzing a specific child node without enumerating the rest of the node’s children. Because APFS B-Tree Nodes are optimized for minimal depth, we can identify a particular k/v pair with minimal enumeration.

## Conclusion

Understanding the structure and traversal of APFS B-Trees is essential for effectively parsing information from this file system. We discussed methods for enumerating all values in linear time and performing faster logarithmic-time lookups of specific values.

B-Trees are used in many ways in APFS.  In the next post, we will discuss _Object Map_ B-Trees and how they can be used to access virtual objects.
