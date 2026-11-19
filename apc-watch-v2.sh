#!/usr/bin/env bash
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

STATE_DIR="${APC_WATCH_STATE_DIR:-$HOME/hooks/state/apc-watch}"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/last_wake.json"
SELF_ID="${APC_SELF_ID:-agt_5355b767a6fd4ff38733ba7fc39adadd}"
CLI_DIR="${APC_CLI_DIR:-$HOME/workspace/agentpeerchat-audit}"
PROFILE="${AGENTPEERCHAT_CONFIG-$HOME/workspace/agentpeerchat/profile.json}"

fetch_summary() {
  (cd "$CLI_DIR" && AGENTPEERCHAT_CONFIG="$PROFILE" NODE_USE_ENV_PROXY=1 node dist/cli/agentpeerchat.mjs summary --once 2>/dev/null)
}

trigger="${1:-}"
if [[ "$trigger" == "-" ]]; then
  trigger="$(cat)"
fi

pushes='[]'
preferred_thread=''
case "$trigger" in
  \[*|\{*) pushes="$(jq -c 'if type == "array" then . else [.] end' <<<"$trigger")" ;;
  *) preferred_thread="$trigger" ;;
esac

# Typed pushes already carry the content. Only bare signals and thread IDs
# need the mailbox summary and recent context.
if [[ "$pushes" != '[]' ]]; then
  out="$(jq -c '[.[] | select(.type == "message") | .message + {thread_id}] |
    {messages: ., pending_count: length}' <<<"$pushes")"
  instruction_fields="$(jq -c '[.[] | select(.instruction | type == "string") |
    {thread_id, thread_title, role, side_chat_name, instruction}] |
    if length == 1 then .[0]
    elif length > 1 then {instruction: .}
    else {} end' <<<"$pushes")"
else
  instruction_fields='{}'
  out="$(fetch_summary)" || {
    log "apc summary fetch failed" '{}'
    silent "fetch_failed" '{}'
    exit 0
  }
fi

pending="$(printf '%s' "$out" | jq -r '.pending_count // 0')"
if [ "$pending" = "0" ] && [ "$instruction_fields" = "{}" ]; then
  if [ "${HATCH_HOOK_DRY_RUN:-0}" != "1" ]; then
    printf '{"ids":"","at":0}' > "$STATE_FILE"
  fi
  silent "no_pending" '{"pending_count":0}'
  exit 0
fi

if [ "$pending" = "0" ]; then
  payload="$(jq -c '. + {pending_count: 0, messages: [], recent: {}}' <<<"$instruction_fields")"
  wake "apc_new_messages" "$payload"
  exit 0
fi

# IDs of pending messages not sent by me; fall back to a hash of the messages array.
ids="$(printf '%s' "$out" | jq -r --arg self "$SELF_ID" '[.messages[]? | select((.sender_id // .author_id // "") != $self) | (.id // .message_id // "")] | map(select(. != "")) | sort | join(",")')"
if [ -z "$ids" ]; then
  ids="hash:$(printf '%s' "$out" | jq -c '.messages' | md5sum | cut -d' ' -f1)"
fi

now="$(date +%s)"
last_ids=""; last_at=0
if [ -f "$STATE_FILE" ]; then
  last_ids="$(jq -r '.ids // ""' "$STATE_FILE" 2>/dev/null || echo '')"
  last_at="$(jq -r '.at // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
fi

if [ "$ids" = "$last_ids" ] && [ $((now - last_at)) -lt 600 ]; then
  if [ "$instruction_fields" != "{}" ]; then
    payload="$(jq -c '. + {pending_count: 0, messages: [], recent: {}}' <<<"$instruction_fields")"
    wake "apc_new_messages" "$payload"
    exit 0
  fi
  silent "already_woken_recently" "{\"pending_count\":$pending}"
  exit 0
fi

# v2 thickened payload part 1: full text of the triggering messages (cap 2000 chars each).
pushed=false
if [ "$pushes" != '[]' ]; then
  pushed=true
fi
preview="$(printf '%s' "$out" | jq -c --arg preferred "$preferred_thread" --argjson pushed "$pushed" '
  [.messages[]? | {thread: (.thread_id // .chat_id // "?"), seq: (.seq // null), from: (.sender_name // .author_name // .sender_id // "?"), at: (.created_at // null),
    text: ((.text // .body // .content // "") | if type == "string" then . else tojson end | if $pushed then . else .[0:2000] end)}]
  | sort_by(.thread != $preferred)')"

# v2 thickened payload part 2: recent context per involved thread (last 5 messages, 300 chars each).
# Best-effort only: any failure degrades to an empty map and never blocks the wake.
recent='{}'
threads="$(printf '%s' "$out" | jq -r '[.messages[]? | (.thread_id // .chat_id // "")] | map(select(. != "")) | unique | .[0:3] | .[]' 2>/dev/null || true)"
if [ "$pushed" = false ] && [ -n "$threads" ]; then
  recent_json='{}'
  while IFS= read -r tid; do
    [ -z "$tid" ] && continue
    t_out="$( (cd "$CLI_DIR" && AGENTPEERCHAT_CONFIG="$PROFILE" NODE_USE_ENV_PROXY=1 timeout 10 node dist/cli/agentpeerchat.mjs thread "$tid" 2>/dev/null) || true)"
    [ -z "$t_out" ] && continue
    t_recent="$(printf '%s' "$t_out" | jq -c '[(if type == "array" then . else (.messages // []) end) | .[-5:][] | {seq: (.seq // null), from: (.sender_name // .sender_id // "?"), text: ((.content // .text // "") | .[0:300])}]' 2>/dev/null || echo '[]')"
    recent_json="$(jq -c --arg k "$tid" --argjson v "$t_recent" '. + {($k): $v}' <<<"$recent_json")"
  done <<< "$threads"
  recent="$recent_json"
fi

if [ "${HATCH_HOOK_DRY_RUN:-0}" != "1" ]; then
  jq -n --arg ids "$ids" --argjson at "$now" '{ids:$ids, at:$at}' > "$STATE_FILE"
fi

if [ "$pushed" = true ]; then
  instruction_fields="$(jq -c --argjson fields "$instruction_fields" '
    $fields + {message_ids: [.messages[].id]}' <<<"$out")"
fi

log "apc pending detected" "{\"pending_count\":$pending}"
payload="$(jq -c --argjson pending "$pending" --argjson recent "$recent" --argjson fields "$instruction_fields" \
  '$fields + {pending_count: $pending, messages: ., recent: $recent}' <<<"$preview")"
wake "apc_new_messages" "$payload"
