# CityBrain

CityBrain is a small TypeScript terminal shell for future city data analysis
and city data governance workflows.

The current milestone focuses on the CLI experience only:

- Pi-style terminal rendering
- interactive text editor
- slash-command popup
- fuzzy command matching
- command selection with arrow keys
- local provider API key login
- provider model probing and model cache
- active model selection
- minimal Agent Loop with streaming chat
- persistent JSONL chat sessions
- explicit session resume flow
- QGIS runtime setup menu on startup (install guidance, path configuration)

Planning, QGIS processing, extensions, OAuth, branching, and compaction are
intentionally deferred. The first built-in tool is `read_file`, which lets the
agent read UTF-8 text files inside the current workspace.

## Start

```cmd
cd /d E:\Geo-agent
npm install
npm run dev
```

The shell starts with the `CITYBRAIN` workspace header. Type `/` to open the
command popup, type more characters to filter it, and use the arrow keys to
select a command.

Available commands:

```text
/help
/new
/clear
/resume
/model [provider/model]
/thinking [off|high|max]
/qgis [setup|detect|use <path>|clear]
/login [provider]
/logout [provider]
/session
/quit
/exit
```

`/login` opens a provider selector when no provider is supplied. It currently
stores API keys locally in:

```text
%USERPROFILE%\.citybrain\auth.json
```

You can override this directory with the `CITYBRAIN_AGENT_DIR` environment
variable. The stored file is local configuration and must not be committed to
source control.

After a successful login, CityBrain probes the provider's model endpoint. Only
models returned by that probe are shown. When no active model exists, CityBrain
selects the first discovered model for that provider. `/model` opens the model
selector, while `/model openai/gpt-4o` selects a model directly. The active
model is saved in:

```text
%USERPROFILE%\.citybrain\settings.json
```

Only models belonging to logged-in providers are shown.

The latest successful provider results are cached in:

```text
%USERPROFILE%\.citybrain\models-store.json
```

On startup CityBrain concurrently refreshes the models for saved providers.
If a probe temporarily fails, the last successful cache remains available and
the terminal reports which provider could not be refreshed.

With an active model, ordinary text is sent to the selected provider as a
streaming chat request. OpenAI, DeepSeek, Qwen, and OpenRouter use the official
`openai` SDK through a shared compatibility adapter. Anthropic and Google
Gemini currently use the lightweight legacy adapters. The current process keeps
the conversation context in a JSONL session file. CityBrain starts with a blank
new session by default. Use `/resume` to select a previous conversation, and
use `/new` or `/clear` to start another fresh conversation.

CityBrain does not create a session file when the shell starts or when a blank
session is opened with `/new`. The file is created only after the first message
is sent (or another session entry needs to be persisted). Use `/thinking` to
choose `off`, `high`, or `max` for the next model request. When a provider
returns reasoning content, it is shown above the answer in gray italic text
and is retained when the session is resumed.

The interactive shell exits only after two `Ctrl+C` presses within two seconds.
`Ctrl+D` does not exit the application.

## QGIS Runtime Setup

When startup detection finds no usable `qgis_process`, CityBrain opens a setup
menu:

```text
QGIS runtime not found. Spatial analysis tools are disabled.

Choose how to enable QGIS processing:

1. Install QGIS LTR locally (recommended)
2. Configure existing QGIS path
3. Use Docker runtime
4. Connect remote QGIS runner
5. Continue without QGIS
```

Option 1 opens the QGIS LTR download page (https://qgis.org/download/) in the
browser and prints install steps. Option 2 lists detected `qgis_process`
candidates (environment variables, `PATH`, common install locations) and also
allows typing a full path manually; the chosen executable is validated with
`qgis_process --version` and saved to `%USERPROFILE%\.citybrain\qgis-runtime.json`.
Options 3 and 4 are placeholders for planned Docker and remote runner support.
The same menu can be reopened later with `/qgis` or `/qgis setup`.

When the model needs workspace context, it can call the default `read_file`
tool. The tool accepts a relative path, rejects paths outside the current
workspace, reads regular UTF-8 files, and truncates output at 20,000
characters. The tool result is sent back to the model so it can continue with
an ordinary final answer.

CityBrain also tracks the current context usage. The footer uses a compact
Pi-style layout with cumulative input/output tokens, placeholder cost, context
load, and the active model:

```text
↑3.2k ↓77 $0.000 0.2%/1.0M (auto)          deepseek-v4-flash • high
```

When provider streams include token usage, assistant messages persist that
usage in the session file and context load uses it as the measured baseline.
Messages added after the last measured assistant response fall back to a simple
`chars / 4` estimate, matching the lightweight Pi-style behavior.

Sessions are stored under:

```text
%USERPROFILE%\.citybrain\sessions\
```

The session format is intentionally close to Pi's append-only JSONL approach:
the first line is a session header, and later lines are message or model-change
entries with `id`, `parentId`, `timestamp`, and `type` fields. CityBrain
does not automatically restore an old session on startup. `/resume` lists
previous sessions for the current working directory and rebuilds model context
from the selected session's saved user and assistant messages. In the resume
list, the active session is yellow, the keyboard-selected row is white, and
inactive rows are gray.

## Build A Global Command

```cmd
cd /d E:\Geo-agent
npm run build
npm link
citybrain
```

Remove the global link with:

```cmd
npm unlink -g citybrain
```

## Project Structure

```text
src/
|-- main.ts
|-- cli/
|   `-- cli.ts
|-- agent/
|   `-- agent-loop.ts
|-- app/
|   |-- interactive-app.ts
|   `-- shell-commands.ts
|-- auth/
|   |-- auth-storage.ts
|   |-- login-dialog.ts
|   |-- providers.ts
|   `-- secret-input.ts
|-- models/
|   |-- model-catalog.ts
|   |-- model-chat.ts
|   |-- model-probe.ts
|   |-- model-runtime.ts
|   |-- model-store.ts
|   `-- model-settings.ts
|-- session/
|   |-- session-manager.ts
|   `-- session-types.ts
```

The terminal shell uses `@earendil-works/pi-tui`, the TUI package used by the
local Pi project for terminal lifecycle, editor behavior, autocomplete, and
selection lists.
