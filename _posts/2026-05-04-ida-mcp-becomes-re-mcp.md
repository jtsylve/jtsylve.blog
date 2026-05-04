---
layout: post
title: "IDA-MCP Is Now RE-MCP With Ghidra Support"
categories: [reverse-engineering, tools]
tags: [ida-pro, ghidra, mcp, llm, ai, idalib, pyghidra, reverse-engineering]
---

When I started building ida-mcp, the goal was simple: give an LLM headless access to IDA Pro through MCP (Model Context Protocol). Open a binary, decompile functions, follow cross-references, rename symbols.

2.0 added a supervisor/worker architecture for analyzing multiple binaries simultaneously. 2.1 introduced progressive tool discovery so the LLM could find specialized tools on demand instead of loading ~195 schemas at startup. 2.2 added meta-tools that let the LLM write multi-step analysis scripts, issue bulk operations, and persist state across sessions through a daemon.

Each release solved a real friction point. But that progression revealed something about the interface itself. The tools the LLM actually calls (decompile this function, get cross-references to that address, rename this symbol, search for strings matching this pattern) described reverse engineering in the abstract, not IDA in particular. IDA was the engine behind those tools, but the tool surface itself was generic. An LLM asking to decompile `main` doesn't care whether the answer comes from Hex-Rays or Ghidra's decompiler. It cares about the pseudocode.

That realization is why ida-mcp is now [re-mcp](https://github.com/jtsylve/re-mcp) (reverse engineering MCP). Version 3.0 ships with a full [Ghidra](https://ghidra-sre.org/) backend alongside the existing IDA Pro backend, with a shared tool interface that makes LLM workflows portable across both.

## Why Ghidra matters here

The most common response I heard after publishing ida-mcp was some variation of "this looks great, but I don't have an IDA license." IDA Pro is the industry standard for binary analysis, but it costs thousands of dollars per seat. For students, independent researchers, CTF players, and hobbyists, that puts LLM-driven reverse engineering out of reach before it even starts.

Ghidra, released by the NSA as open source in 2019, has become the primary free alternative. It supports dozens of processor architectures, its decompiler is capable, and it has an active community building extensions and loaders. By adding Ghidra as a backend, re-mcp makes everything from 2.0 through 2.2 (multi-database analysis, progressive tool discovery, `execute` scripts, `batch` operations) available to anyone willing to install a free tool and a JDK.

## Getting started with Ghidra

The Ghidra backend requires Python 3.12+, [Ghidra 12+](https://ghidra-sre.org/), and JDK 21+. Ghidra's install path is found automatically from the `GHIDRA_INSTALL_DIR` environment variable or platform-specific default locations.

```bash
uv tool install re-mcp-ghidra
```

Then configure your MCP client:

```json
{
  "mcpServers": {
    "ghidra": {
      "command": "uvx",
      "args": ["re-mcp-ghidra"]
    }
  }
}
```

From there, everything works the way it did with IDA. Open a binary, wait for analysis to complete, and start asking questions.

The meta-tools from 2.2 work on the Ghidra backend too. Here's an `execute` script that finds functions referencing error strings and summarizes them:

```python
strings = await invoke("find_code_by_string", {
    "pattern": "invalid|error|fail", "limit": 50
})
seen = set()
results = []
for hit in strings["items"]:
    fn = hit.get("function_name", "")
    if not fn or fn in seen:
        continue
    seen.add(fn)
    decomp = await invoke("decompile_function", {
        "address": hit["function_address"]
    })
    results.append({
        "function": decomp["function_name"],
        "address": decomp["address"],
        "matched_string": hit["string_value"],
        "lines": len(decomp["decompiled_code"].splitlines())
    })
return {"functions_with_error_strings": results}
```

One tool call. The LLM gets back every function that references an error string, with its decompiled size, ready for triage. The same workflow pattern from the [2.2 post](/post/2026/04/21/ida-mcp-2.2) applies here (the only difference being response field names like `decompiled_code` vs. `pseudocode`).

## Comparing engines

There's a practical reason to support both backends even if you already have an IDA license. IDA and Ghidra have different analysis engines, different heuristics for function boundary detection, different type propagation strategies. Running the same binary through both and comparing the output is a common practice in professional reverse engineering; each tool catches things the other misses.

With re-mcp, you configure both servers, and the LLM can open the same binary in each and compare function lists, decompiler output, and cross-references across the two.

## One interface, two engines

Both backends implement the same core tool interface: identical tool names, identical parameters, and the same categories of information in responses (though individual field names in responses may differ slightly between engines). From a user's perspective, it doesn't matter which engine is running: the LLM issues the same tool calls and returns comparable results either way.

The shared surface covers the operations that define a reverse engineering session:

- **Functions**: list, decompile, disassemble, rename, set prototypes
- **Navigation**: cross-references (to and from), imports, exports, entry points, names
- **Search**: strings with regex filtering, byte patterns, immediate values
- **Types**: local type libraries, structures, enums, type application
- **Annotation**: comments, names, bookmarks
- **Patching**: byte-level modification, segment operations
- **Meta-tools**: `search_tools`, `get_schema`, `call`, `execute`, `batch`

An `execute` script that crawls error strings, decompiles referencing functions, and renames them follows the same logic on either engine; scripts only need to adjust for the field name differences noted above.

Each backend also retains capabilities specific to its engine. The IDA backend keeps everything from the 2.x releases: IDAPython scripting via `run_script`, file region mapping, executable rebuilding, IDC evaluation, and the eight guided prompts for structured analysis workflows. The Ghidra backend brings its own strengths: Function ID for automatic library function identification and data type archive support.

## Architecture and transport

re-mcp is a monorepo with three packages: **re-mcp-core** (supervisor, transport, meta-tools), **re-mcp-ida** (IDA Pro backend wrapping idalib), and **re-mcp-ghidra** (Ghidra backend wrapping [pyghidra](https://github.com/NationalSecurityAgency/ghidra/tree/master/Ghidra/Features/PyGhidra)). The core package doesn't depend on IDA or Ghidra. Backends are discovered through Python entry points, so you install only what you need:

```bash
# IDA users
uv tool install re-mcp-ida

# Ghidra users
uv tool install re-mcp-ghidra

# Both
uv tool install re-mcp --with re-mcp-ida --with re-mcp-ghidra
```

Future backends (Binary Ninja, radare2, or something that doesn't exist yet) would slot in as additional packages implementing the same worker interface, with no changes to the core or any existing backend.

re-mcp 3.0 switches the default transport to direct stdio: one session, workers terminate on disconnect. This is simpler to set up than the HTTP daemon that ida-mcp 2.2 defaulted to, and it works universally with every MCP client. For workflows that need persistence, the daemon is still available via `proxy` or `serve` subcommands (e.g., `re-mcp-ghidra serve`, `re-mcp-ida serve`). The transport mode is independent of the backend; all options work the same for `re-mcp-ida`, `re-mcp-ghidra`, and the unified `re-mcp --backend <name>` command.

## Migrating from ida-mcp

The legacy `ida-mcp` PyPI package now redirects to `re-mcp-ida`. Existing installations continue to work after upgrading:

```bash
uv tool install --upgrade ida-mcp
# or install directly
uv tool install re-mcp-ida
```

The MCP tool interface is backward compatible. Existing `execute` scripts, `batch` operations, and direct tool calls work without changes. Requirements are unchanged: IDA Pro 9+ with Python 3.12+. The main visible difference is the entry point name (`ida-mcp` becomes `re-mcp-ida`), though the old name continues to work as an alias.

Environment variables follow the same pattern as before, prefixed per backend. `IDA_MCP_` variables carry over unchanged for the IDA backend; the Ghidra backend uses `GHIDRA_MCP_` with the same suffixes.

## Links

- **Repository**: [github.com/jtsylve/re-mcp](https://github.com/jtsylve/re-mcp)
- **PyPI**: [re-mcp-ida](https://pypi.org/project/re-mcp-ida/) · [re-mcp-ghidra](https://pypi.org/project/re-mcp-ghidra/) · [re-mcp](https://pypi.org/project/re-mcp/)

If you run into issues or have feature requests, please [open an issue](https://github.com/jtsylve/re-mcp/issues) on GitHub.

---

*IDA Pro and Hex-Rays are trademarks of Hex-Rays SA. Ghidra is developed by the National Security Agency. re-mcp is an independent project and is not affiliated with or endorsed by Hex-Rays or the NSA.*
