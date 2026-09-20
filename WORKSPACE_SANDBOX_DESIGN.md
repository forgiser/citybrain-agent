# CityBrain Workspace Sandbox Design

## 1. Goal

CityBrain uses a project-level sandbox. The folder passed to `/init` is the
actual filesystem boundary, while `citybrain/` is only the generated Harness
control directory inside that boundary.

The required invariant is:

```text
Agent writes  -> sandboxRoot only
Agent reads   -> sandboxRoot or explicitly approved read roots
QGIS outputs  -> sandboxRoot only
QGIS inputs   -> approved read roots, read-only
temporary     -> workspaceRoot/.internal/tmp
```

This is an application-level Harness boundary. It is stronger than a prompt
instruction, but it is not an operating-system container. A future hardened
worker can add a Windows Job Object, restricted token, or container isolation.

## 2. Current Architecture

The boundary is split into these layers:

```text
/init
  -> WorkspaceManager
  -> workspace.json
  -> SandboxPolicy
  -> ToolRegistry / StreamingToolExecutor
  -> read_file, list_files, write_file, edit_file, QGIS tools
  -> ArtifactRegistry and execution logs
```

`SandboxPolicy` is the single runtime authority for path access. System
prompts may describe the policy, but a tool call is accepted or rejected by
the runtime policy.

## 3. Workspace Manifest

Each initialized workspace contains:

```text
citybrain/
  AGENTS.md
  workspace.json
  profile.md
  artifacts/
    process/
    result/
  .internal/
    tmp/
    logs/
      tool-execution.jsonl
      context-usage.jsonl
      context-trace.jsonl
    state/
```

The manifest records:

- `workspaceRoot`: the generated Harness control directory, normally `<projectDir>/citybrain`;
- `sandboxRoot`: the actual read/write boundary selected by `/init`;
- `projectDir`: the project associated with `/init`, currently the same as `sandboxRoot`;
- `mode`: `analysis` or `strict`;
- `readRoots`: approved read-only input directories;
- manifest creation and update timestamps.

The default `analysis` mode allows the initialized project/sandbox root to be
read and written. External data directories outside the project root must be
explicitly authorized with:

```text
/sandbox add-read E:\GeoAIOps\data
/sandbox
/sandbox remove-read E:\GeoAIOps\data
```

`strict` mode only allows reads inside the project/sandbox root. It is intended
for untrusted or self-contained tasks.

## 4. Access Rules

### Read operations

`read_file` and `list_files` resolve paths through `SandboxPolicy`:

- absolute paths must be inside `sandboxRoot` or an approved `readRoot`;
- relative paths are resolved against the project/sandbox root and workspace
  control directory;
- path traversal, drive escapes, UNC escapes, and symlink/junction escapes
  are rejected;
- approved external roots are read-only.

### Write operations

All future file-writing, copy, move, delete, download, and generated-report
tools must call `resolveWritePath` or `assertWritable`.

Write access is limited to `sandboxRoot`. The policy checks both the
normalized path and the canonical existing parent, preventing a symlink or
junction from redirecting a write outside the sandbox.

### QGIS operations

For `run_qgis_algorithm`:

- `INPUT`-like paths use read policy;
- `OUTPUT`-like paths use write policy;
- relative outputs resolve under the project/sandbox root, not `process.cwd()`;
- QGIS runs with project/sandbox `cwd`;
- `TEMP`, `TMP`, and `TMPDIR` point to `.internal/tmp`;
- returned output paths are checked again after the process exits.

An output path outside the workspace is a policy failure, even if
`qgis_process` itself accepts it.

## 5. Harness Execution Contract

Every side-effecting tool follows this lifecycle:

```text
Preflight
  -> parse arguments
  -> resolve and authorize paths
  -> register expected artifacts as pending

Execute
  -> run with workspace cwd and controlled environment
  -> stream progress and honor cancellation/timeout

Postflight
  -> verify output paths
  -> verify files exist and are usable
  -> mark artifacts ready, missing, or invalid
  -> persist the execution log
```

If preflight fails, the ToolRegistry returns a structured tool error to the
Agent instead of letting a path-policy exception terminate the Agent loop.

Artifact dependencies continue to use `pending -> ready/missing/invalid`
states. A read of a pending artifact waits for the producing task to settle,
which prevents early `ENOENT` reads during long QGIS jobs.

## 6. Session and Subagent Rules

The active session supplies the workspace policy to every tool call. A resumed
session reuses the workspace recorded in its session header and manifest.

Subagents inherit the parent's workspace and read roots. They may receive a
more restrictive policy, but they must never expand the allowed roots by
themselves.

Logs, context traces, tool results, plans, and internal recovery state are all
workspace-owned state and should remain below `.internal/`. User-visible
analysis products should remain below `artifacts/`.

## 7. Process Isolation Roadmap

The current implementation provides a logical Harness boundary. The next
hardened stage should:

1. execute QGIS in a dedicated worker process;
2. apply a Windows Job Object to terminate the complete process tree;
3. use an allowlisted environment and executable path;
4. prevent unrestricted shell execution;
5. add optional restricted-user or container execution.

## 8. Verification Matrix

The minimum test matrix is:

- `..\outside` read and write traversal;
- another drive and UNC path;
- symlink and junction redirection;
- external input under an approved read root;
- external input without approval;
- QGIS output inside and outside the workspace;
- relative QGIS output with spaces and non-ASCII characters;
- `TEMPORARY_OUTPUT` and generated sidecar files;
- long-running QGIS cancellation and timeout cleanup;
- session resume after workspace movement or deletion;
- subagent attempts to add or use a new root.

## 9. Implementation Status

Implemented in the first sandbox phase:

- workspace manifest creation;
- centralized `SandboxPolicy`;
- `read_file` and `list_files` enforcement;
- `write_file` and `edit_file` enforcement with read-before-write checks;
- QGIS input/output path enforcement;
- workspace-bound QGIS cwd and temporary environment;
- postflight output boundary verification;
- `/sandbox` inspection and external read-root management;
- sandbox propagation into delegated agents;
- `.internal/logs` and `.internal/state` path consolidation;
- policy failures returned as tool errors.

Still planned:

- copy/delete tools using the same policy;
- persisted artifact registry;
- OS-level worker isolation;
- automated path and process-isolation tests.
