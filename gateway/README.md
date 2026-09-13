# Alph gateway

LiteLLM Proxy (per-user keys, rate limits) + Postgres + Caddy (TLS, static app config) in front of the vLLM instances.

```
app ──HTTPS──▶ Caddy ──▶ LiteLLM :4000 ──▶ vLLM (gemma / qwen / nemotron)
               └─ /app/config.json   (admin API on 127.0.0.1:4000 only)
```

Caddy exposes only `/v1/models`, `/v1/chat/completions`, `/health/liveliness` and `/app/*`. Key management is reachable only from the gateway host (use an SSH tunnel).

## Run locally (no GPUs)

```sh
cd gateway
cp .env.example .env                    # defaults point at the mock server
docker compose --profile mock up -d
./scripts/create-key.sh you@example.org # prints sk-...
curl -s http://localhost:8080/v1/models -H "Authorization: Bearer sk-..."
```

The mock (`mock/mock_vllm.py`) streams fake reasoning + content and can simulate failures. Send these as the user message: `/error 429`, `/error 401`, `/error 500`, `/drop` (connection closes mid-stream), `/slow`. You can also run it without Docker: `python3 mock/mock_vllm.py --port 8000`.

## Deploy against real vLLM

1. On the gateway host: `cp .env.example .env` and set:
   - `GATEWAY_DOMAIN`
   - strong `POSTGRES_PASSWORD`, `LITELLM_MASTER_KEY` and `LITELLM_SALT_KEY`
   - `VLLM_API_KEY`
   - the three `*_API_BASE` URLs
2. In `litellm/config.yaml`, replace each `hosted_vllm/<name>` with the instance's served model name (`curl <vllm>/v1/models`).
3. TLS: choose an option in `caddy/Caddyfile`. For an org-issued certificate, put the files in `caddy/certs/`.
4. `docker compose up -d` (no `--profile mock`).
5. Firewall the vLLM instances so that only the gateway host can reach them.
6. Check that message content is not being stored: send a request, then confirm that the `LiteLLM_SpendLogs` rows have empty `messages`/`response`:
   ```sh
   docker compose exec postgres psql -U litellm -c 'select model, "user", total_tokens, messages, response from "LiteLLM_SpendLogs" order by "startTime" desc limit 3;'
   ```

## Keys

```sh
ssh -L 4000:localhost:4000 <gateway-host>              # from your machine
./scripts/create-key.sh alice@example.org 30 200000 3  # rpm, tpm, max parallel
./scripts/revoke-key.sh sk-...
```

## Adding a model

1. Add an entry to `litellm/config.yaml`, then run `docker compose restart litellm`.
2. Optionally add display and reasoning metadata under `models` in `public/app/config.json`. Caddy serves it live, so no restart is needed.

No app release is needed.

## Phase 0 probe: reasoning toggle and stream format per model

```sh
# Directly against each vLLM instance…
python3 scripts/probe_models.py --base http://<qwen-vllm>:8000 --key "$VLLM_API_KEY" --config public/app/config.json
# …and through the gateway. The results should match; otherwise LiteLLM is changing the request or response.
python3 scripts/probe_models.py --base https://<gateway> --key sk-... --config public/app/config.json
```

The probe script checks, for each model:

| Check | What to look for |
|---|---|
| Reasoning field | Reasoning text arrives in `reasoning` or `reasoning_content` (the app accepts both). |
| Reasoning toggle | The `offBody` variant produces **no** reasoning. If it still does, that model uses a different switch; update its `onBody`/`offBody` in `config.json`. |
| `<think>` tags | `THINK-TAGS-IN-CONTENT` means vLLM is running without `--reasoning-parser`. Fix the server; don't try to parse tags in the app. |
| Usage | `usage` is present. |

Also record each instance's `--max-model-len` as `contextWindow`.

`config.json` currently assumes `chat_template_kwargs.enable_thinking` for Qwen and Nemotron, and no reasoning for Gemma. These are unverified guesses until the probe confirms them.
