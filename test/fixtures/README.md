# Fixtures

Event streams and history recorded from `opencode-tellico serve` on
OpenCode 2.0.26+9b4ec57, 2026-10-13, against the live Tellico cluster.
Paths are rewritten to `/work/proj` and the hostname to `devbox`.

| File | Scenario |
|---|---|
| `fix-and-run.events.json` | `build-tellico-1`: read, edit, shell, answer |
| `fix-and-run.messages.json` | `GET /api/session/{id}/message` for the same session |
| `worker-dispatch.events.json` | `orchestrate-tellico-1` dispatches `tellico-worker-0` in the background; completion notice; lead resumes |
| `guard-and-interrupt.events.json` | `secret-guard` blocks a `.env` read (tool error), then the user interrupts |

## Re-recording

```sh
OPENCODE_PASSWORD=pw opencode-tellico serve --port 4123 &
curl -sN -u opencode:pw "http://127.0.0.1:4123/api/event?directory=$PWD" > events.sse &
# POST /api/session, then POST /api/session/{id}/prompt with {"text": ...}
```

Keep only `data:` lines of the sessions involved, parse each as JSON, and
save the array. Scrub absolute paths, usernames and hostnames.
