---
layout: post
title: "Announcing ida-mcp 2.0: A Headless MCP Server for IDA Pro"
categories: [reverse-engineering, tools]
tags: [ida-pro, mcp, llm, ai, idalib, reverse-engineering]
---

The [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) lets LLMs call external tools, and for reverse engineers the obvious application is connecting an LLM to IDA Pro — navigating binaries, reading disassembly, decompiling functions, and annotating databases. Several MCP servers for IDA already exist. Today I'm releasing [ida-mcp 2.0](https://github.com/jtsylve/ida-mcp), a headless server with ~190 tools, 36 resources, 8 prompts, and support for analyzing multiple binaries simultaneously.

## Tool coverage

ida-mcp is built on [idalib](https://docs.hex-rays.com/release-notes/9_0#ida-as-a-library-idalib) and exposes ~190 tools covering:

- **Analysis & navigation** — open binaries, list/query functions, decode instructions, walk basic blocks and CFG edges, follow cross-references, build call graphs
- **Decompilation** — Hex-Rays pseudocode, microcode at any maturity level, ctree AST traversal and pattern matching, variable renaming and retyping
- **Type system** — local type libraries, structure and enum creation/editing, C declaration parsing, type application at addresses
- **Annotation** — comments (including appending with deduplication), names, bookmarks, colors, register variables, hidden ranges
- **Modification** — patching bytes, combined assemble-and-patch, creating/deleting functions, data type definitions, operand display formatting
- **Batch operations** — export all pseudocode or disassembly, generate output files (ASM, LST, MAP), rebuild executables from databases
- **Signatures** — FLIRT signature application and generation, type library loading, IDS module loading
- **Advanced** — segment register tracking, switch table analysis, fixups, exception handlers, undo/redo, snapshots, directory tree management

Every tool accepts addresses in hex (`0x401000`), decimal, or as a symbol name, and list operations use `offset`/`limit` pagination.

All mutation tools return `old_*` fields showing the previous state — `old_comment`, `old_name`, `old_color`, `old_bytes`, etc. — so the LLM can see what changed without a separate read-back call.

For anything the built-in tools don't cover, `run_script` allows arbitrary IDAPython execution (enabled by the `IDA_MCP_ALLOW_SCRIPTS` environment variable).

## What's new in 2.0

### Resources

MCP defines three primitives: tools (actions), resources (read-only context), and prompts (guided workflows). Most IDA MCP servers only implement tools; ida-mcp 2.0 implements all three.

Resources are read-only endpoints that provide context without consuming a tool call. ida-mcp exposes 36 of them via `ida://` URIs, organized into four tiers:

**Core context** — database metadata, file paths, processor info, segments, entry points, imports, exports, and a statistics summary. These give the LLM orientation when it first opens a binary.

**Structural reference** — the local type catalog, individual type definitions, structure layouts with member offsets, enum definitions, and applied FLIRT/TIL signatures. These let the LLM inspect the type system without calling tools.

**Browsable collections** — functions, strings, named locations, and bookmarks. Enough for the LLM to get a high-level picture of the binary.

Most collection resources also expose a `search/{pattern}` variant for filtering by name or address, so the LLM can narrow results without paging through large lists.

**Per-entity lookups** — function metadata, stack frames, exception handlers, decompiled variables, and cross-references by address. These are parameterized URIs like `ida://functions/{addr}` and `ida://xrefs/to/{addr}`.

In multi-database mode, the supervisor proxies resource reads to the appropriate worker and exposes its own `ida://databases` resource listing all open databases with worker status.

### Prompts

ida-mcp includes 8 prompts — structured analysis templates that guide the LLM through multi-step workflows:

**Analysis:**
- `survey_binary` — binary triage: identify the file type, architecture, key functions, strings of interest, and imports. Accepts an optional focus parameter to narrow the survey.
- `analyze_function` — single-function deep dive with data flow analysis and security notes.
- `diff_before_after` — preview how a rename or retype will affect the decompiler output before committing.
- `classify_functions` — group functions by behavioral pattern (crypto, networking, string manipulation, etc.) to prioritize analysis effort.

**Security:**
- `find_crypto_constants` — scan for known constants from AES, SHA-256, SHA-1, MD5, CRC-32, ChaCha20, RSA, and Blowfish.

**Workflow:**
- `auto_rename_strings` — suggest function renames based on unique string references, without applying any changes.
- `apply_abi` — apply type information for a known ABI (Linux syscalls, libc, Windows API, POSIX).
- `export_idc_script` — generate a reproducible IDAPython script capturing all annotations made during the session.

### Multi-database support

Reverse engineering rarely involves a single binary. You might need to cross-reference a DLL against its loader, compare two firmware versions, or analyze a malware dropper alongside its payload. With ida-mcp 1.x, you had to close one database before opening another. With ida-mcp 2.0, you can keep them all open at once.

ida-mcp runs a **supervisor process** that spawns **worker subprocesses** on demand. Each worker loads idalib independently and manages a single database. The supervisor proxies MCP tool calls to the appropriate worker based on a `database` parameter it injects into every tool's schema.

```text
MCP Client  ←—stdio—→  Supervisor (ProxyMCP)
                              │
                              ├——stdio——→  Worker 1  (binary_a.exe)
                              ├——stdio——→  Worker 2  (library.dll)
                              └——stdio——→  Worker 3  (firmware.bin)
```

This is a direct consequence of idalib's threading model: all IDA API calls must happen on the thread that imported the `idapro` module, and global state is shared per-process. Rather than fighting that, each database gets its own process with complete isolation.

This means the LLM never pays a context-switch penalty. In a serial setup, switching from one binary to another means closing the current database and reopening the next one — a swap that flushes all in-memory state and can take seconds depending on database size. With per-database workers, the LLM just passes a different `database` parameter and gets an immediate response. All databases stay warm.

This matters most when the LLM is using subagents. An orchestrating agent can spawn parallel subagents — one reversing a loader, another analyzing the payload it drops, a third inspecting a shared library — and they all run concurrently against their own workers without blocking each other. No subagent has to wait for another to release the database.

To use it, pass `keep_open=True` when opening a database:

```python
# First binary — opens normally
open_database("/path/to/binary_a.exe", keep_open=True)

# Second binary — previous database stays open
open_database("/path/to/library.dll", keep_open=True)

# Tools target a specific database
decompile_function("main", database="binary_a.exe")
get_xrefs_to("ImportantExport", database="library.dll")
```

Idle workers are cleaned up after a configurable timeout (default 30 minutes, controlled by `IDA_MCP_IDLE_TIMEOUT`), and the maximum number of concurrent workers can be capped with `IDA_MCP_MAX_WORKERS`.

If you don't need multi-database support, the `ida-mcp-worker` entry point provides the same single-database behavior as 1.x.

## Existing IDA MCP servers

ida-mcp is not the only IDA MCP server. The existing servers fall into two categories: **plugin-based** servers that run inside a GUI session, and **headless** servers that run standalone without a GUI.

The plugin-based approach is the most common. The most popular is [ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp) by mrexodia (of x64dbg fame), which runs as an IDA plugin communicating over SSE or stdio and exposes a large tool set. Others in this category include [ida-multi-mcp](https://github.com/MeroZemory/ida-multi-mcp) (multi-instance routing through a single MCP endpoint), [IDA-MCP](https://github.com/jelasin/IDA-MCP) (a gateway architecture supporting multiple IDA instances), and [IDAssistMCP](https://github.com/symgraph/IDAssistMCP). Plugin-based servers require a running GUI session, which ties the server's lifecycle to a visible IDA window.

On the headless side:

**[ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp)** includes `idalib-mcp`, a headless mode built on the same idalib foundation as ida-mcp. It exposes ~76 tools (96 with the debugger extension) plus 11 MCP resources, serving over HTTP/SSE. Requirements are IDA 8.3+ and Python 3.11+. The multi-database mode works by swapping the active database in a single process — only one is loaded at a time.

**[ida-mcp-rs](https://github.com/blacktop/ida-mcp-rs)** links directly against IDA's native libraries from Rust. It has first-class support for Apple's `dyld_shared_cache`, useful if you work with macOS/iOS binaries. The tool surface is smaller (~11 tools) and focused on core analysis operations.

**[headless-ida-mcp-server](https://github.com/cnitlrt/headless-ida-mcp-server)** uses IDA's headless executable (`idat`) rather than idalib, which avoids the idalib dependency but routes through a separate process for each API call.

ida-mcp shares the idalib foundation with `idalib-mcp` but takes a different approach: stdio transport instead of HTTP/SSE, per-database subprocess isolation instead of serial database swapping, and automatic idalib discovery instead of requiring a pip install. ida-mcp requires IDA Pro 9+ and Python 3.12+; `idalib-mcp` supports IDA 8.3+ and Python 3.11+ and includes debugger tools that ida-mcp does not have yet.

## Getting started

ida-mcp requires IDA Pro 9+ with a valid license and Python 3.12+. A Hex-Rays decompiler license is needed for decompilation tools but is not required for the rest.

```bash
# Install from PyPI
uv tool install ida-mcp
```

IDA Pro is found automatically from standard installation paths, or you can set `IDADIR` to point to your installation.

Then configure your MCP client to launch the server. If you prefer not to install globally, `uvx` can fetch and run it on demand:

```json
{
  "mcpServers": {
    "ida": {
      "command": "uvx",
      "args": ["ida-mcp"]
    }
  }
}
```

No plugin files to copy, no ports to configure, no GUI to keep running.

## Links

- **Repository**: [github.com/jtsylve/ida-mcp](https://github.com/jtsylve/ida-mcp)
- **PyPI**: [pypi.org/project/ida-mcp](https://pypi.org/project/ida-mcp/)
- **License**: MIT

If you run into issues or have feature requests, please [open an issue](https://github.com/jtsylve/ida-mcp/issues) on GitHub.

---

*IDA Pro and Hex-Rays are trademarks of Hex-Rays SA. ida-mcp is an independent project and is not affiliated with or endorsed by Hex-Rays.*
