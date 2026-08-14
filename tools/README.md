# Tool Archive and Registry

This directory is for cataloging external tools without modifying their original source.

## Rules

- Preserve each upstream project unchanged.
- Record upstream repository, commit/tag, runtime, dependencies, and license.
- Keep original source separate from the assistant application code.
- Do not place API keys, access tokens, passwords, or other secrets in this directory.
- Tool entries are metadata/catalog entries unless an explicit, safe integration is implemented.

## Planned layout

```text
tools/
├── README.md
├── registry.json
└── adapters/
```

