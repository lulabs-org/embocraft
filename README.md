# EmboCraft

English | [简体中文](README_CN.md)

A standalone, local multiplayer 3D voxel and embodied AI sandbox: TypeScript · pnpm workspace · React/Vite · Three.js · Node/Colyseus · PostgreSQL/Prisma.

> [!TIP]
> This project comes with complete online development and design documentation. For in-depth architecture, communication protocols, and AI Agent integration details, please refer to the [📚 Documentation Center](docs/index.md) (preview locally with `pnpm --filter docs dev`).

---

## Key Features

- 🤖 **LLM-Powered AI Players**: Integrates large language models such as DeepSeek, featuring autonomous observation, spatial navigation, multi-step reasoning & planning, and voxel editing capabilities.
- 🎙️ **Proximity Spatial Audio & Live Transcription**: Built-in Whisper ASR speech recognition and Piper offline TTS speech synthesis, with distance- and orientation-based 3D attenuation mixing, automatically broadcasting transcribed subtitles to nearby players and agents upon sentence completion.
- 🧱 **Authoritative Multiplayer World**: Three.js instanced voxel rendering, powered by a Node.js / Colyseus server that authoritatively validates movement physics, velocity, raycast collisions, gravity, and voxel adjacency support rules.
- 🔌 **Agent Gateway Central Management**: Dedicated HTTP/WebSocket endpoints for unified AI character lifecycle management, task plan queues, status acknowledgments, and token budget protection.

---

## Quick Start

Local development and Docker Compose share [.env.example](.env.example). Copy it to `.env` on first use, or update the relevant entries in an existing file:

```sh
cp -n .env.example .env
```

Follow the common, local, and Docker sections in the example. Set a database password before deploying with Docker; see [Configuration setup](docs/guide/getting-started.md#统一配置入口) for defaults and overrides.

### 1. Local Development Environment

Prerequisites: Node.js 22.13+, pnpm 10, PostgreSQL 17 binaries. Fully runnable locally without any cloud accounts.

```sh
# 1. Install dependencies
pnpm install --frozen-lockfile

# 2. Setup database and run migrations
pnpm db:generate
pnpm db:start      # Starts standalone PostgreSQL on local port 55432
pnpm db:migrate    # Runs Prisma database migrations

# 3. Start frontend and server development servers
pnpm dev

# 4. Start AI players in another terminal (or non-AI mock bots)
pnpm agent:ai --api-key sk-your-deepseek-api-key
# Non-AI mock bot: pnpm agent:mock
```

Once started, open http://127.0.0.1:5173 in your browser. You can open two separate incognito windows with different nicknames to test multiplayer interaction.

> For in-memory database fallback, troubleshooting, and detailed step-by-step guides, refer to the [Getting Started Guide](docs/guide/getting-started.md).

### 2. One-Click Full-Stack Docker Deployment

This project provides out-of-the-box Docker Compose orchestration covering the Web frontend, Node backend, PostgreSQL database, and an integrated Speaches voice container (Whisper ASR + Piper TTS):

```sh
# Start all services with one command
pnpm docker:up
# Or: docker compose up -d --build

# Stop container services
pnpm docker:down
```

After launch:

- **Web Frontend**: Visit `http://localhost`
- **Swagger API Docs**: Visit `http://localhost:2567/api-docs`

> For detailed container configuration, upgrading from older versions, and microphone permission troubleshooting, see the [Docker Deployment Guide](docs/guide/getting-started.md#docker-全栈一键部署).

---

## Controls

| Action              | Controls                                                             | Description                                                                   |
| ------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Look / Camera**   | Click canvas to lock pointer, `Esc` to release                       | Pointer controls camera yaw and pitch                                         |
| **Movement**        | `W` / `A` / `S` / `D`                                                | Move forward / left / backward / right                                        |
| **Jump**            | `Space`                                                              | Vertical jump (can climb 1-block steps)                                       |
| **Voxel Editing**   | Crosshair within 6 blocks: Left Click to break, Right Click to place | Bottom hotbar supports quick placement / removal and material selection       |
| **Text Chat**       | Bottom-left chat input                                               | Supports global broadcast chat and `@nickname` private messages               |
| **Proximity Voice** | Voice control panel                                                  | Microphone voice transmission, 3D spatial audio listening, and speech-to-text |

---

## Repository Structure

The project is structured as a pnpm workspace monorepo:

```text
embocraft/
├── apps/
│   ├── server/            # Colyseus authoritative world, HTTP admin APIs & persistent storage
│   └── web/               # React 18 + Three.js client, lobby & console UI
├── packages/
│   ├── shared/            # Shared world protocol, physics calculations & deterministic terrain
│   └── agent-runtime/     # Agent decision-making & task scheduler runtime shared by CLI and server
├── docs/                  # Official documentation site powered by VitePress
└── scripts/               # Ops scripts for local DB control, Agent management CLI, etc.
```

For in-depth architectural layering, module dependency contracts, and design boundaries, please see [Architecture & Code Organization](docs/guide/architecture.md).

---

## Documentation Index

| Section                 | Document                                                       | Description                                                                  |
| ----------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Getting Started**     | [Getting Started](docs/guide/getting-started.md)               | Setup, local development, Docker deployment, and troubleshooting             |
| **System Architecture** | [Architecture & Code Organization](docs/guide/architecture.md) | Frontend/backend modules, lifecycles, constraints, and design boundaries     |
| **Protocols**           | [Protocols & Extension Boundaries](docs/protocol/overview.md)  | Authoritative world state sync, input validation, and extension rules        |
|                         | [Chat & Proximity Voice](docs/protocol/chat.md)                | Spatial audio WebRTC signaling, microphone transcription, and broadcast flow |
| **AI Agent**            | [AI Player Integration](docs/agent/players.md)                 | DeepSeek model integration, reasoning toolchain, and task loop               |
|                         | [Agent Gateway](docs/agent/gateway.md)                         | Admin tokens, HTTP control endpoints, and WebSocket state subscription       |
|                         | [Unified Event Runtime](docs/agent/runtime.md)                 | Task executor, checkpoint persistence, and token budget protection           |
| **Voice Services**      | [Voice Service Management](docs/voice/setup.md)                | Whisper ASR and Piper TTS model installation and configuration               |
| **Changelog**           | [Validation Records](docs/changelog/validation.md)             | Dual-browser regression, network recovery, and acceptance tests              |
|                         | [Pi Migration](docs/changelog/pi-migration.md)                 | Evolution records for Agent runtime architecture                             |

---

## Quality Assurance

```sh
pnpm check             # Full repo typecheck, ESLint, unit tests, and build
pnpm lint              # Source code linting
pnpm test:integration  # Multi-client world protocol integration tests
pnpm format:check      # Code format check
```

---

## License

This project is open-sourced under the [MIT](LICENSE) License.
