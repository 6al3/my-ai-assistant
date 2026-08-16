# DIG Local Agent Room

This mode is intentionally separate from Qubes/qrexec. It binds only to `127.0.0.1` and talks to a locally running Ollama instance on `127.0.0.1:11434` by default.

## What you get

- Coder, System, QA, or all three together.
- No Qubes integration in this mode.
- No API key and no cloud model required.
- Conversation history is stored in browser `localStorage` only.
- The HTTP listener is loopback-only, so other devices on the LAN cannot connect to it by default.

## First run

1. Install Ollama on the same computer.
2. Pull a local chat model, for example:

   `ollama pull qwen2.5:7b`

3. From the repository root run:

   `npm run local`

4. Open:

   `http://127.0.0.1:8787`

To use a different installed model:

`DIG_LOCAL_MODEL=<model-name> npm run local`

To use a different local port:

`DIG_LOCAL_PORT=8787 npm run local`

## Security boundary

This local mode does not call any qrexec code and does not open a listener on `0.0.0.0`. The model endpoint defaults to loopback. Do not change `DIG_OLLAMA_URL` to a remote host if you want the setup to remain fully local.
