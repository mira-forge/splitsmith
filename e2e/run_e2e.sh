#!/bin/bash
# Splitsmith real-Obsidian end-to-end + corpus kit (Gate 3). Box only, $0, no network use by the plugin.
# Usage: e2e/run_e2e.sh <fresh workdir> <free X display, e.g. :71> <free CDP port>
# Env: NOSTAGES=1 leave the instance running for manual poking (prints the kill command)
#      STAGES=<file> stage script (default e2e/stages.mjs)   CORPUS_MODES (passed to stages)
# Same safety rules as the Cardsmith sr_test_kit: preflight refuses reuse; own Xvfb, HOME and ports;
# cleanup kills only the process groups it started.
set -euo pipefail
E2E="$(cd "$(dirname "$0")" && pwd)"; REPO="$(dirname "$E2E")"
W="${1:?workdir}"; D="${2:?display like :71}"; CDP="${3:?cdp port}"
OBS=/workspace/obsidian-smoke/squashfs-root/obsidian   # Obsidian 1.14.5 AppImage, extracted
[ -e "$W" ] && { echo "PREFLIGHT: $W exists; pick a fresh dir"; exit 2; }
N="${D#:}"; { [ -e "/tmp/.X$N-lock" ] || [ -e "/tmp/.X11-unix/X$N" ]; } && { echo "PREFLIGHT: display $D in use"; exit 2; }
ss -ltn | awk '{print $4}' | grep -qE "[:.]$CDP\$" && { echo "PREFLIGHT: port $CDP in use"; exit 2; }
[ -x "$OBS" ] || { echo "PREFLIGHT: Obsidian not found at $OBS"; exit 2; }
[ -f "$REPO/main.js" ] || { echo "PREFLIGHT: build first (npm run build)"; exit 2; }
mkdir -p "$W"/{home/.config/obsidian,shots,notes}
if [ -n "${NOCORPUS:-}" ]; then mkdir -p "$W/vault"; else "$E2E/make_corpus.sh" "$W/vault"; fi
cp -r "$E2E/fixtures/." "$W/vault/"
P="$W/vault/.obsidian/plugins/splitsmith"; mkdir -p "$P"
cp "$REPO"/main.js "$REPO"/manifest.json "$REPO"/styles.css "$P/"
sha256sum "$P"/main.js | tee "$W/build.sha256"; (cd "$REPO" && git rev-parse --short HEAD) > "$W/commit.txt"
echo '["splitsmith"]' > "$W/vault/.obsidian/community-plugins.json"
# Trash inside the vault (.trash): the xvfb box has no system trash. Excluded from every byte check.
echo '{"trashOption":"local","promptDelete":false}' > "$W/vault/.obsidian/app.json"
echo '{"theme":"obsidian"}' > "$W/vault/.obsidian/appearance.json"
VID=$(python3 -c 'import secrets;print(secrets.token_hex(8))')
echo "{\"vaults\":{\"$VID\":{\"path\":\"$W/vault\",\"ts\":1792950457000,\"open\":true}}}" > "$W/home/.config/obsidian/obsidian.json"
cd "$W"
PGS=()
cleanup() { for g in "${PGS[@]}"; do kill -TERM -- "-$g" 2>/dev/null || true; done; sleep 2; for g in "${PGS[@]}"; do kill -KILL -- "-$g" 2>/dev/null || true; done; }
trap cleanup EXIT
setsid Xvfb "$D" -screen 0 1600x1000x24 -nolisten tcp > xvfb.log 2>&1 & PGS+=($!)
for i in $(seq 1 50); do [ -e "/tmp/.X11-unix/X$N" ] && break; sleep 0.2; done
[ -e "/tmp/.X11-unix/X$N" ] || { echo "Xvfb $D did not start"; exit 3; }
start_obs() { HOME="$W/home" DISPLAY="$D" setsid "$OBS" --no-sandbox --remote-debugging-port=$CDP --user-data-dir="$W/home/.config/obsidian" >> obs.log 2>&1 & PGS+=($!); echo "${PGS[*]}" > pgids.txt; }
start_obs
for i in $(seq 1 60); do curl -s localhost:$CDP/json | grep -q '"page"' && break; sleep 0.5; done
if [ -n "${NOSTAGES:-}" ]; then trap - EXIT; echo "left running; stop with: kill -- -$(sed 's/ / -/g' pgids.txt)"; exit 0; fi
# The stage script asks for a restart by writing RESTART; this loop quits Obsidian's group and starts it again.
set +e
export CDP_PORT=$CDP W="$W" SHOTS="$W/shots" XDISPLAY="$D"
node --experimental-websocket --no-warnings "${STAGES:-$E2E/stages.mjs}" &
SP=$!
while kill -0 $SP 2>/dev/null; do
  if [ -f RESTART ]; then
    OG=${PGS[1]}; kill -TERM -- "-$OG" 2>/dev/null; for i in $(seq 1 40); do kill -0 -- "-$OG" 2>/dev/null || break; sleep 0.25; done; kill -KILL -- "-$OG" 2>/dev/null
    PGS=("${PGS[0]}"); start_obs; rm -f RESTART; touch RESTARTED
  fi
  sleep 0.5
done
wait $SP; RC=$?
echo "exit $RC"; tail -1 RESULT.txt 2>/dev/null
exit $RC
