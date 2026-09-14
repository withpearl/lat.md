<p align="center">
  <img src="templates/logo-dark.svg" alt="lat.md" width="500">
</p>

<p align="center">
  <a href="https://github.com/1st1/lat.md/actions/workflows/ci.yml"><img src="https://github.com/1st1/lat.md/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/lat.md"><img src="https://img.shields.io/npm/v/lat.md" alt="npm"></a>
</p>

<p align="center">A knowledge graph for your codebase, written in markdown.</p>

## The problem

`AGENTS.md` doesn't scale. A single flat file can describe a small project, but as a codebase grows, maintaining one monolithic document becomes impractical. Key design decisions get buried, business logic goes undocumented, and agents hallucinate context they should be able to look up.

## The idea

Compress the knowledge about your program domain into a **graph** — a set of interconnected markdown files that live in a `lat.md/` directory at the root of your project. Sections link to each other with `[[wiki links]]`, markdown files link into the codebase (`[[src/auth.ts#validateToken]]`), source files link back with `// @lat: [[section-id]]` comments, and `lat check` ensures nothing drifts out of sync.

- **Faster coding for agents** — instead of grepping through your codebase, agents search the knowledge graph to discover key design decisions, constraints, and domain context fast and consistently.

- **Faster workflow for humans** — your agents maintain lat files for you. When you review a diff, start with the semantic changes in `lat.md/` to understand *what* changed and *why*. Reviewing code becomes the secondary task.

- **Knowledge retention** — the context and reasoning behind your prompts is usually lost after a session ends. With lat, agents capture that knowledge into the graph as they work, so future sessions start with full context instead of rediscovering it from scratch.

- **Test specs with enforcement** — test cases can be described as sections in `lat.md/` and marked with `require-code-mention: true`. Each spec then must be referenced by a `// @lat:` comment in test code. `lat check` flags any spec without a backlink, so you can review and maintain test coverage from the knowledge graph.

The `lat` CLI gives agents and humans a system to navigate and maintain the graph:

- **`lat init`** — sets up popular coding agents with hooks and instructions to keep lat updated and correct
- **`lat check`** — enforces referential consistency; agents call it automatically before finishing work
- **`lat search`** and **`lat section`** — agents use these to understand your prompts and navigate the graph instead of endless `grep` calls

`lat` is a workflow that comes with tools — build pre-commit hooks and GitHub bots, run CI tasks that improve the knowledge graph in the background.

## Install

```bash
npm install -g lat.md
```

Then run `lat init` in the repo you want to use lat in.

### Cast build (`withpearl/lat.md`, branch `cast/rollout`)

This fork ships prebuilt CLI tarballs as [GitHub releases](https://github.com/withpearl/lat.md/releases) — performance fixes and a ~10x smaller search index that have not yet landed upstream. `npm install -g lat.md` installs the **upstream** package, not this build. Install a release by URL instead (no Rust or build step):

```bash
npm i -g https://github.com/withpearl/lat.md/releases/download/v0.12.2-cast.4/lat.md-0.12.2-cast.4.tgz
lat --version   # 0.12.2-cast.4
```

Coming from `0.12.2-cast.3` or earlier, rebuild the search index once per repo. An existing index keeps working, but stays at its old, uncompressed size until you do — and one grown by months of incremental updates also misses some results a fresh build finds:

```bash
lat reindex --local
```

Keep `--local`: in a checkout not yet pinned to the offline model, a bare `lat reindex` rebuilds with a hosted model if an API key is configured.

Revert with `npm i -g lat.md@latest`.

## How it works

Run `lat init` to scaffold a `lat.md/` directory, then write markdown files describing your architecture, business logic, test specs — whatever matters. Link between sections using `[[file#Section#Subsection]]` syntax. Link to source code symbols with `[[src/auth.ts#validateToken]]`. Annotate source code with `// @lat: [[section-id]]` (or `# @lat: [[section-id]]` in Python and PHP) comments to tie implementation back to concepts.

```
my-project/
├── lat.md/
│   ├── architecture.md    # system design, key decisions
│   ├── auth.md            # authentication & authorization logic
│   └── tests.md           # test specs (require-code-mention: true)
├── src/
│   ├── auth.ts            # // @lat: [[auth#OAuth Flow]]
│   └── server.ts          # // @lat: [[architecture#Request Pipeline]]
└── ...
```

## CLI

```bash
lat init                        # scaffold a lat.md/ directory
lat check                       # run full graph and documentation validation
lat locate "OAuth Flow"         # find sections by name (exact, fuzzy)
lat section "auth#OAuth Flow"   # show a section with its links and refs
lat refs "auth#OAuth Flow"      # find what references a section
lat search "how do we auth?"    # semantic search via embeddings
lat expand "fix [[OAuth Flow]]" # expand [[refs]] in a prompt for agents
lat mcp                         # start MCP server for editor integration
```

## Configuration

Semantic search (`lat search`) works **offline by default** — no API key required. It uses a bundled local embedding model (all-MiniLM-L6-v2, compiled to WebAssembly; no native binaries, no network).

To use higher-quality hosted embeddings instead, provide an OpenAI (`sk-...`) or Vercel AI Gateway (`vck_...`) API key, resolved in order:

1. `LAT_LLM_KEY` env var — direct value
2. `LAT_LLM_KEY_FILE` env var — path to a file containing the key
3. `LAT_LLM_KEY_HELPER` env var — shell command that prints the key (10s timeout)
4. Config file — power users can set `llm_key` manually. Run `lat config` to print its location.

Switch backends any time with `lat reindex` (`--local` to force the offline model, `--remote` to use your key).

## Development

Development requires Node.js 22, pnpm, and Rust installed through rustup. The
pnpm setup installs the matching WASM target and build tools project-locally.
See the [development process](lat.md/dev-process.md) for complete setup and
contribution guidance.

```bash
pnpm install
pnpm buildall
pnpm test
```
