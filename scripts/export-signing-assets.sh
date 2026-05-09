#!/usr/bin/env bash
#
# Interactive helper that collects every value you need to paste into
# GitHub. Walks the eight secrets one at a time, copies each to the
# clipboard (via pbcopy), and pauses so you can paste+save in the
# GitHub UI before moving on.
#
# Two scopes:
#   • Six Apple-identity secrets live at the **organisation** level
#     (privacykey GitHub org → Settings → Secrets and variables →
#     Actions). Set once, visible to every macOS-shipping repo in the
#     org. If you've already done this for another repo, skip past
#     them when prompted.
#   • Two Tauri updater secrets live in **this repo's** `macos-signing`
#     **environment** (gated by required-reviewer rule). Per-app —
#     never share across repos.
#
# The script tells you which scope to use for each one.
#
# Safe to re-run — no destructive operations, no writes outside $HOME.
#
# Usage:
#   bash scripts/export-signing-assets.sh
#
# Prereqs:
#   • You've already completed Parts 1-3 of https://privacytracker-docs.privacykey.org/develop/build-from-source on this Mac.
#   • pbcopy (shipped with macOS).

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only runs on macOS — it talks to Keychain and pbcopy." >&2
  exit 1
fi

BOLD=$(tput bold 2>/dev/null || true)
RESET=$(tput sgr0 2>/dev/null || true)
DIM=$(tput dim 2>/dev/null || true)
GREEN=$(tput setaf 2 2>/dev/null || true)
RED=$(tput setaf 1 2>/dev/null || true)
YELLOW=$(tput setaf 3 2>/dev/null || true)

say() { printf '%s\n' "$*"; }
hdr() { printf '\n%s%s%s\n%s%s%s\n' "$BOLD" "$1" "$RESET" "$DIM" "$(printf -- '─%.0s' $(seq 1 ${#1}))" "$RESET"; }
warn() { printf '%s⚠%s  %s\n' "$YELLOW" "$RESET" "$*"; }
ok() { printf '%s✓%s  %s\n' "$GREEN" "$RESET" "$*"; }
err() { printf '%s✗%s  %s\n' "$RED" "$RESET" "$*" >&2; }

wait_for_paste() {
  local name="$1"
  local scope="${2:-environment}"  # "org" or "environment"
  printf '\n    Secret name: %s%s%s\n' "$BOLD" "$name" "$RESET"
  if [[ "$scope" == "org" ]]; then
    printf '    Copied to clipboard. Paste it as an %sorganisation secret%s\n' "$BOLD" "$RESET"
    printf '    under %sgithub.com/organizations/privacykey/settings/secrets/actions%s.\n' \
      "$BOLD" "$RESET"
    printf '    Set %sRepository access%s to %sSelected repositories%s and pick the\n' \
      "$BOLD" "$RESET" "$BOLD" "$RESET"
    printf '    macOS-shipping repos (privacytracker, privacycommand, …).\n'
  else
    printf '    Copied to clipboard. Paste it as an %senvironment secret%s\n' "$BOLD" "$RESET"
    printf '    in this repo, under %sSettings → Environments → macos-signing%s.\n' \
      "$BOLD" "$RESET"
  fi
  printf '\n    %sPress ENTER when done to move to the next secret…%s ' "$DIM" "$RESET"
  read -r _ || true
}

# Optional per-secret skip — useful when org secrets already exist and
# you only need to refresh the per-repo Tauri keys.
SKIP_ORG=0

clear_clipboard() {
  : | pbcopy
}

trap clear_clipboard EXIT

# ---------------------------------------------------------------------------

hdr "privacytracker — signing asset helper"
say
say "This script copies each GitHub secret to your clipboard one at a time."
say "Follow along in GitHub → Settings → Environments → macos-signing."
say
say "You'll be asked for paths to two files and an optional password. If you"
say "haven't generated them yet, quit now and work through https://privacytracker-docs.privacykey.org/develop/build-from-source"
say "through Part 3 first."
say
read -r -p "Ready to proceed? [y/N] " proceed
if [[ "${proceed,,}" != "y" && "${proceed,,}" != "yes" ]]; then
  say "Aborted."
  exit 0
fi

say
say "${BOLD}Have you already configured the six Apple-identity secrets at the"
say "privacykey organisation level?${RESET} (Yes if you set them up for another"
say "macOS app already.) If yes, we'll skip steps 1-6 and go straight to the"
say "two Tauri updater secrets."
read -r -p "Skip org secrets (1-6)? [y/N] " skip_org
if [[ "${skip_org,,}" == "y" || "${skip_org,,}" == "yes" ]]; then
  SKIP_ORG=1
  ok "Skipping org-level secrets."
fi

# ---------- APPLE_SIGNING_IDENTITY ----------
if [[ $SKIP_ORG -eq 0 ]]; then
hdr "1/8  APPLE_SIGNING_IDENTITY  (organisation secret)"

say "Finding Developer ID Application certs in your login keychain…"
identities=$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/ {print $2}')
if [[ -z "$identities" ]]; then
  err "No 'Developer ID Application' cert found in Keychain."
  err "Complete Part 1 of https://privacytracker-docs.privacykey.org/develop/build-from-source, then re-run this script."
  exit 1
fi

mapfile -t ids <<<"$identities"
if (( ${#ids[@]} == 1 )); then
  signing_identity="${ids[0]}"
  ok "Using: $signing_identity"
else
  say "Multiple Developer ID Application identities found:"
  for i in "${!ids[@]}"; do
    printf '  [%d] %s\n' "$((i+1))" "${ids[i]}"
  done
  read -r -p "Pick one (1-${#ids[@]}): " choice
  signing_identity="${ids[$((choice-1))]}"
  ok "Using: $signing_identity"
fi

printf '%s' "$signing_identity" | pbcopy
wait_for_paste "APPLE_SIGNING_IDENTITY" "org"

# ---------- APPLE_CERTIFICATE + APPLE_CERTIFICATE_PASSWORD ----------
hdr "2/8  APPLE_CERTIFICATE  (organisation secret — base64 of the p12 export)"

while :; do
  read -r -p "Path to your Developer ID Application .p12 export: " p12_path
  p12_path="${p12_path/#\~/$HOME}"
  if [[ -f "$p12_path" ]]; then break; fi
  err "No file at $p12_path. Try again or Ctrl-C to quit."
done

# Pipe through tr to strip newlines — some older GitHub ingest paths tripped
# over wrapped base64. Modern GitHub handles both, but a single line is
# defensively correct.
base64 -i "$p12_path" | tr -d '\n' | pbcopy
ok "Base64 p12 is on the clipboard ($(wc -c < "$p12_path") bytes raw)."
wait_for_paste "APPLE_CERTIFICATE" "org"

hdr "3/8  APPLE_CERTIFICATE_PASSWORD  (organisation secret)"
say "Enter the password you set when exporting the p12."
say "(Input hidden. Leave blank if you truly used no password — not recommended.)"
read -r -s -p "p12 password: " p12_pass
echo
printf '%s' "$p12_pass" | pbcopy
unset p12_pass
wait_for_paste "APPLE_CERTIFICATE_PASSWORD" "org"

# ---------- APPLE_API_KEY ----------
hdr "4/8  APPLE_API_KEY  (organisation secret — contents of the .p8 file)"

while :; do
  read -r -p "Path to your App Store Connect API .p8 file: " p8_path
  p8_path="${p8_path/#\~/$HOME}"
  if [[ -f "$p8_path" ]]; then break; fi
  err "No file at $p8_path. Try again or Ctrl-C to quit."
done

cat "$p8_path" | pbcopy
ok "Full PEM contents on the clipboard."
wait_for_paste "APPLE_API_KEY" "org"

# ---------- APPLE_API_KEY_ID ----------
hdr "5/8  APPLE_API_KEY_ID  (organisation secret)"

# Try to infer from the .p8 filename (Apple names them AuthKey_<KEYID>.p8)
inferred_key_id=$(basename "$p8_path" | sed -n 's/^AuthKey_\([A-Z0-9]\{10\}\)\.p8$/\1/p')
if [[ -n "$inferred_key_id" ]]; then
  say "Inferred Key ID from filename: %s${BOLD}$inferred_key_id${RESET}"
  read -r -p "Use this? [Y/n] " accept
  if [[ -z "$accept" || "${accept,,}" == "y" || "${accept,,}" == "yes" ]]; then
    key_id="$inferred_key_id"
  fi
fi
if [[ -z "${key_id:-}" ]]; then
  read -r -p "Paste the 10-character Key ID (e.g. 2X9R4HXF34): " key_id
fi
printf '%s' "$key_id" | pbcopy
wait_for_paste "APPLE_API_KEY_ID" "org"

# ---------- APPLE_API_ISSUER ----------
hdr "6/8  APPLE_API_ISSUER  (organisation secret)"
say "The Issuer ID is a UUID shown at the top of the App Store Connect"
say "Keys page. Same value for every key created in your org."
read -r -p "Paste the Issuer UUID: " issuer_id
printf '%s' "$issuer_id" | pbcopy
wait_for_paste "APPLE_API_ISSUER" "org"
fi  # SKIP_ORG -eq 0

# ---------- TAURI_SIGNING_PRIVATE_KEY ----------
hdr "7/8  TAURI_SIGNING_PRIVATE_KEY  (environment secret — updater key contents)"

default_tauri_key="$HOME/.tauri/privacytracker.key"
read -r -p "Path to your Tauri updater private key [$default_tauri_key]: " tauri_key_path
tauri_key_path="${tauri_key_path:-$default_tauri_key}"
tauri_key_path="${tauri_key_path/#\~/$HOME}"

if [[ ! -f "$tauri_key_path" ]]; then
  warn "No key at $tauri_key_path."
  read -r -p "Generate one now with 'npx @tauri-apps/cli signer generate'? [y/N] " gen
  if [[ "${gen,,}" == "y" || "${gen,,}" == "yes" ]]; then
    mkdir -p "$(dirname "$tauri_key_path")"
    ( cd "$(dirname "$0")/.." && npx --no-install @tauri-apps/cli signer generate -w "$tauri_key_path" )
    say
    say "Now copy the public key printed above into src-tauri/tauri.conf.json"
    say "under plugins.updater.pubkey, and flip plugins.updater.active to true."
    read -r -p "Press ENTER when done… " _ || true
  else
    err "Can't proceed without a Tauri updater key. Re-run after generating it."
    exit 1
  fi
fi

cat "$tauri_key_path" | pbcopy
ok "Full key contents on the clipboard."
wait_for_paste "TAURI_SIGNING_PRIVATE_KEY" "environment"

# ---------- TAURI_SIGNING_PRIVATE_KEY_PASSWORD ----------
hdr "8/8  TAURI_SIGNING_PRIVATE_KEY_PASSWORD  (environment secret)"
say "The password you set when generating the Tauri updater key."
say "(Input hidden. If you used no password, leave blank and press ENTER.)"
read -r -s -p "Tauri key password: " tauri_pass
echo
printf '%s' "${tauri_pass:-}" | pbcopy
unset tauri_pass
wait_for_paste "TAURI_SIGNING_PRIVATE_KEY_PASSWORD" "environment"

# ---------- done ----------
clear_clipboard
ok "Clipboard cleared."
say
if [[ $SKIP_ORG -eq 1 ]]; then
  say "${BOLD}All done.${RESET} The two ${BOLD}macos-signing${RESET} environment secrets are set."
  say "Org-level Apple secrets were left untouched (you said they were already configured)."
else
  say "${BOLD}All done.${RESET} Six org-level secrets and two environment secrets are now in place."
fi
say
say "Next steps:"
say "  1. Add yourself as a required reviewer on the macos-signing environment."
say "  2. Restrict deployment tags to v* under the same environment settings."
say "  3. Push a tag: git tag v0.1.0 && git push origin v0.1.0"
say "  4. Approve the run in Actions → macOS desktop release."
say
