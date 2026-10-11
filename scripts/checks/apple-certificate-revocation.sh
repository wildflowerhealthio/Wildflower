#!/usr/bin/env bash
# Asks Apple whether a signing certificate has been revoked. Sourced by the
# iOS and macOS App Store preflights after they import a .p12.
#
# `security find-identity -v` does not consult revocation, so a revoked
# certificate imports, resolves and signs, and is refused only by App Store
# Connect after the build — "Signing certificate is invalid" from the iOS
# export, "Certificate Revoked" from the macOS upload. The certificate names
# its OCSP responder and issuer, so the question needs no credentials.
#
# Needs `fail` and `warn` from the sourcing script and `ocsp_verdict` from
# apple-signing-lib.sh.

# Args: the input's name for messages, the identity's common name, the
# keychain it was imported into, and a scratch directory. Fails when Apple
# says revoked; warns and returns when it cannot get an answer.
check_not_revoked() {
  local label="$1" identity="$2" keychain="$3" dir="$4"
  local cert="$dir/$label.leaf.pem" issuer="$dir/$label.issuer.pem"
  local ocsp_url issuer_url response verdict

  if ! security find-certificate -c "$identity" -p "$keychain" > "$cert" 2>/dev/null; then
    warn "Could not read '$identity' back out of the keychain to check it is not revoked."
    return 0
  fi
  ocsp_url="$(openssl x509 -in "$cert" -noout -ocsp_uri 2>/dev/null || true)"
  issuer_url="$(openssl x509 -in "$cert" -noout -text 2>/dev/null |
    sed -n 's/^ *CA Issuers - URI://p' | head -n 1)"
  if [[ -z "$ocsp_url" || -z "$issuer_url" ]]; then
    warn "'$identity' names no OCSP responder or issuer, so whether it is revoked is not checked."
    return 0
  fi
  # Apple serves the issuer as DER; accept PEM too.
  if ! curl -fsSL --max-time 20 "$issuer_url" -o "$dir/$label.issuer" ||
    ! { openssl x509 -inform DER -in "$dir/$label.issuer" -out "$issuer" 2>/dev/null ||
      openssl x509 -in "$dir/$label.issuer" -out "$issuer" 2>/dev/null; }; then
    warn "Could not fetch the issuer of '$identity' from $issuer_url, so whether it is revoked is not checked."
    return 0
  fi

  # `-noverify`: the question is the status Apple reports, and the runner's
  # openssl does not carry Apple's roots to verify the response against.
  response="$(openssl ocsp -issuer "$issuer" -cert "$cert" -url "$ocsp_url" -noverify 2>&1 || true)"
  verdict="$(ocsp_verdict "$response")"
  case "$verdict" in
    good) echo "$label: Apple reports '$identity' is not revoked." ;;
    revoked)
      fail "$label holds '$identity', which Apple has revoked. It still imports and signs, but App Store Connect refuses whatever it signs. Run scripts/release/apple-signing-sync.sh to make and store a new one (see docs/Rust/Apple Signing Sync How-To.md)." ;;
    *) warn "Could not get a revocation status for '$identity' from $ocsp_url: $(tr '\n' ' ' <<< "$response")" ;;
  esac
}
