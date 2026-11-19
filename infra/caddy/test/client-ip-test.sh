#!/usr/bin/env bash
# Owner: Agent H. Checks that Caddy hands the API the real client address and nothing the browser made up (CP5-02).
# The API trusts exactly one proxy hop (SMS_TRUST_PROXY=1), so the X-Forwarded-For that reaches it must hold only the
# address Caddy saw. A client that sends its own X-Forwarded-For must not be able to choose its address.
# Usage: infra/caddy/test/client-ip-test.sh   (needs caddy, node and curl on PATH; no Docker, no database)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$work"; }
trap cleanup EXIT

# A stand-in for the API: answers every request with the X-Forwarded-For header it received.
cat > "$work/echo.js" <<'JS'
require('node:http').createServer((req, res) => {
  res.setHeader('content-type', 'text/plain');
  res.end(String(req.headers['x-forwarded-for'] ?? ''));
}).listen(0, '127.0.0.1', function () { require('node:fs').writeFileSync(process.argv[2], String(this.address().port)); });
JS
node "$work/echo.js" "$work/port" & pids+=($!)
for _ in $(seq 50); do [[ -s "$work/port" ]] && break; sleep 0.1; done
port="$(cat "$work/port")"

# The real Caddyfile; only the test copy stops Caddy from installing its local CA into this machine's trust store.
sed 's/^\tadmin off$/\tadmin off\n\tskip_install_trust/' "$here/../Caddyfile" > "$work/Caddyfile"
export SMS_DOMAIN=sms.kansview.test SMS_TLS=internal SMS_API_UPSTREAM="127.0.0.1:$port" XDG_DATA_HOME="$work/data" XDG_CONFIG_HOME="$work/config"
caddy run --config "$work/Caddyfile" --adapter caddyfile > "$work/caddy.log" 2>&1 & pids+=($!)

get() { curl -sk --noproxy '*' --max-time 5 --resolve sms.kansview.test:8443:127.0.0.1 "$@"; }
for _ in $(seq 100); do get -o /dev/null https://sms.kansview.test:8443/api/v1/health 2>/dev/null && break; sleep 0.1; done

fail=0
check() { # name, expected, actual
  if [[ "$2" == "$3" ]]; then echo "ok   $1: '$3'"; else echo "FAIL $1: expected '$2', got '$3'"; fail=1; fi
}
# The api (and the worker, which shares its settings) must trust exactly the one Caddy hop.
check "compose SMS_TRUST_PROXY" '"1"' "$(sed -n '/^x-api-env:/,/^[^ ]/s/^  SMS_TRUST_PROXY: *\(.*\)$/\1/p' "$here/../../compose/docker-compose.yml")"
check "Caddyfile replaces X-Forwarded-For" "2" "$(grep -c 'header_up X-Forwarded-For {client_ip}' "$here/../Caddyfile")"
check "plain request" "127.0.0.1" "$(get https://sms.kansview.test:8443/api/v1/auth/login)"
check "spoofed X-Forwarded-For" "127.0.0.1" "$(get -H 'X-Forwarded-For: 10.9.8.7' https://sms.kansview.test:8443/api/v1/auth/login)"
check "spoofed list" "127.0.0.1" "$(get -H 'X-Forwarded-For: 10.9.8.7, 10.1.1.1' https://sms.kansview.test:8443/api/v1/auth/login)"
check "upload route" "127.0.0.1" "$(get -X POST -H 'X-Forwarded-For: 10.9.8.7' https://sms.kansview.test:8443/api/v1/imports)"

if [[ $fail -ne 0 ]]; then echo "--- caddy log"; tail -n 20 "$work/caddy.log"; exit 1; fi
echo "CLIENT IP TEST PASSED"
