#!/usr/bin/env bash
# Scans tracked files for the things this repo could plausibly leak.
#
# This exists because GitHub's own secret scanning only recognises known
# PROVIDER formats (an AWS key, a Stripe key). The credentials that matter
# here are supermarket session cookies, which no provider pattern covers, and
# the repo is public. Push protection catches the generic cases; this catches
# the Dealwatch-shaped ones.
#
# Every pattern below is chosen to have no false positives against a clean
# tree, so a hit means look, not tune. Run with no arguments to scan tracked
# files; pass file paths to scan just those (used by the pre-commit hook).
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 2

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  mapfile -t files < <(git ls-files)
fi

[ "${#files[@]}" -eq 0 ] && exit 0

status=0
report() {
  printf '\n%s\n' "SECRET SCAN FAILED: $1"
  printf '%s\n' "$2"
  status=1
}

# 1. Live store session cookies. A raw capture from Coles, Woolworths or Aldi
# carries these, and any one of them is a working credential until it expires.
# The `["']?\s*` before the separator matters: in a JSON capture the name
# arrives as `"_abck":`, so the quote sits between the name and the colon.
cookie_hits=$(grep -InE '(_abck|bm_sz|bm_sv|ak_bmsc|reese84|incap_ses[_0-9]*|visid_incap[_0-9]*|nlbi_[0-9]+|wow-auth-token)["'\'']?\s*[=:]\s*["'\'']?[A-Za-z0-9%._~+/=-]{16,}' "${files[@]}" 2>/dev/null)
[ -n "$cookie_hits" ] && report "a store session cookie looks committed" "$cookie_hits"

# 2. JSON Web Tokens. Woolworths hands one out on every warmed page load.
jwt_hits=$(grep -InE 'eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}' "${files[@]}" 2>/dev/null)
[ -n "$jwt_hits" ] && report "a JWT looks committed" "$jwt_hits"

# 3. Private keys and certificates.
key_hits=$(grep -InE -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "${files[@]}" 2>/dev/null)
[ -n "$key_hits" ] && report "a private key looks committed" "$key_hits"

# 4. Terraform state or vars. State stores the Cloudflare API token in
# plaintext, and that token can mint further tokens.
tf_hits=$(printf '%s\n' "${files[@]}" | grep -E '\.tfstate(\.[0-9]+)?$|\.tfvars$' | grep -v '^example\.tfvars$|/example\.tfvars$')
[ -n "$tf_hits" ] && report "terraform state or vars are tracked" "$tf_hits"

if [ "$status" -ne 0 ]; then
  printf '\n%s\n' "Nothing was committed. Remove the secret, then re-run."
  printf '%s\n' "If this is a false positive, narrow the pattern in scripts/scan-secrets.sh rather than skipping the hook."
fi

exit "$status"
