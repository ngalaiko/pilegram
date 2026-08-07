# pilegram

A personal [pi](https://github.com/earendil-works/pi) coding agent, over Telegram.

## Features

- **Streaming replies** via Telegram message drafts (animated, then finalized).
- **Topics = sessions**: each Telegram topic is its own agent session with its own
  workspace and context; create/delete them with Telegram's native thread UI. The
  agent keeps each topic's **title and icon** relevant on its own.
- **Markdown → Telegram HTML**: headings, code, lists, tables, links render properly.
- **Images** in (vision) & out, **documents** in (path + inlined text) & out, **albums** both ways.
- **Voice**, fully local: voice notes are transcribed with **whisper.cpp**; replies
  come back as voice notes synthesized with **Supertonic** (in-process ONNX). Text
  always available as a fallback.
- **Reactions**: the agent can react to your messages instead of replying in text.
- **Steering**: a message sent mid-turn is injected into the running turn; prefix
  with `>` to queue it as a follow-up instead.
- **Rich inbound handling**: replies/quotes, forwards, edited messages, stickers,
  locations, contacts, polls, dice.

The only bot command is **`/stop`** (abort the current turn). Everything else you
type (or say, or send) is a prompt.

## Prerequisites

pilegram runs on **[Bun](https://bun.sh)** and shells out to three tools for voice:

| Tool | Why | Provides |
|---|---|---|
| **bun** ≥ 1.3 | runtime | — |
| **ffmpeg** | transcode audio ↔ OGG/Opus | `ffmpeg`, `ffprobe` |
| **whisper.cpp** | speech-to-text | `whisper-cli` |

TTS (Supertonic) runs in-process via the `onnxruntime-node` npm dependency — no
extra system package. Speech model weights download automatically on first use.

## Install

### Without Nix

Install the three tools with your package manager, then the app:

```bash
# macOS (Homebrew)
brew install oven-sh/bun/bun ffmpeg whisper-cpp

# Debian/Ubuntu: bun via https://bun.sh; ffmpeg via apt; whisper.cpp from source
#   (must expose a `whisper-cli` binary on PATH)
sudo apt install ffmpeg

git clone <this repo> && cd pilegram
bun install
export TELEGRAM_BOT_TOKEN=123456:AA...     # the one secret (or put it in .env)
bun run src/index.ts --allow 111222333     # your Telegram user id(s)
```

`whisper-cli`, `ffmpeg`, and `ffprobe` must be on your `PATH`. That's the only
requirement voice has — everything else is handled by `bun install`.

### With Nix

The flake builds a **hermetic** package — pinned toolchain (bun + ffmpeg +
whisper.cpp) *and* pinned `node_modules` — so it runs from anywhere, not just the
repo:

```bash
# one-shot: builds the package and runs it
TELEGRAM_BOT_TOKEN=… nix run github:you/pilegram -- --allow 111222333

# or install it onto your PATH
nix profile install github:you/pilegram
TELEGRAM_BOT_TOKEN=… pilegram --allow 111222333

# or a dev shell (bun, ffmpeg, whisper-cli), to run from source
nix develop
bun install
bun run src/index.ts --allow 111222333
```

`node_modules` is a fixed-output derivation: `bun install --frozen-lockfile`
whose result is pinned by content hash (this keeps the native `onnxruntime-node`
dylib intact — a real node_modules layout, unlike `bun build --compile`). **When
you change dependencies**, bump that hash: run `nix build .#node-modules`, copy
the `got: sha256-…` it prints into `outputHash` in `flake.nix`.

## Telegram setup (BotFather)

1. Create a bot with [@BotFather](https://t.me/BotFather) → copy the **token**.
2. **Enable topics**: BotFather → `/mybots` → your bot → *Bot Settings* → turn on
   **Threaded Mode**. (Without this, pilegram runs a single-session DM.)
3. Find **your numeric user id** (e.g. via [@userinfobot](https://t.me/userinfobot)).

## Configuration

The one **secret** is `TELEGRAM_BOT_TOKEN` (from the environment / `.env`, never a
flag — argv is visible in `ps`). Everything else is a **CLI flag** (`--help`):

| Flag | Required | Default | Notes |
|---|---|---|---|
| `--allow <ids>` | ✅ | — | comma-separated Telegram user ids; everyone else is dropped silently |
| `--state-dir <path>` | | `$XDG_CONFIG_HOME/pilegram` (else `~/.config/pilegram`) | SQLite db + conversation workspaces |
| `--models-dir <path>` | | `$XDG_CACHE_HOME/pilegram` (else `~/.cache/pilegram`) | downloaded speech models (~2 GB cache) |
| `--db-path <path>` | | `<state-dir>/pilegram.db` | override the db path |
| `--whisper-model <name>` | | `large-v3-turbo` | whisper.cpp ggml model (e.g. `base.en` for a fast/small English-only start) |
| `--voice <id>` | | `M1` | Supertonic voice: `M1`–`M5`, `F1`–`F5` |
| `--tz <zone>` | | `Europe/Stockholm` | local time shown to the agent |
| `--poll-timeout <sec>` | | `30` | long-poll seconds |
| `--log-level <level>` | | `info` | `debug`\|`info`\|`warn`\|`error` |
