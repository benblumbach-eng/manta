#!/usr/bin/env bash
set -euo pipefail

R_WANT=4.4
BIOC_WANT=3.20
CUTADAPT_WANT=5.2
CRAN=https://cloud.r-project.org
RIG_URL=https://github.com/r-lib/rig/releases/download/latest
PKGS="dada2 Biostrings ShortRead"
pkg_want() { case "$1" in dada2) echo 1.34 ;; Biostrings) echo 2.74 ;; ShortRead) echo 1.64 ;; esac; }
UBUNTU_LIBS="build-essential gfortran pkg-config curl ca-certificates libcurl4-openssl-dev libssl-dev
libxml2-dev zlib1g-dev libbz2-dev liblzma-dev libpng-dev libjpeg-dev"
LOG="${TMPDIR:-/tmp}"
LOG="${LOG%/}/manta-install-dada2.log"

usage() {
  echo "usage: bash tools/dada2_to_otter/install_dada2.sh [--check]"
  echo "  installs R $R_WANT, Bioconductor $BIOC_WANT (dada2, Biostrings, ShortRead) and cutadapt $CUTADAPT_WANT"
  echo "  --check   only report what is installed; change nothing"
}

CHECK=0
case "${1:-}" in
  "") ;;
  --check) CHECK=1 ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

die() { echo "ERROR: $*" >&2; exit 1; }

if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
  die "run this without sudo; it asks for your password itself where needed"
fi
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

ORIG_PATH="$PATH"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac
export PATH

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin)
    PLATFORM=macos
    DESC="macOS $(sw_vers -productVersion 2>/dev/null || true) $ARCH" ;;
  Linux)
    OS_ID=""; OS_VER=""
    if [ -r /etc/os-release ]; then
      OS_ID="$(. /etc/os-release && printf '%s' "${ID:-}")"
      OS_VER="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
    fi
    [ "$OS_ID" = ubuntu ] ||
      die "this script supports Ubuntu 22.04/24.04 (also under WSL) and macOS; found: ${OS_ID:-unknown Linux}"
    PLATFORM=ubuntu
    DESC="Ubuntu $OS_VER $ARCH"
    if grep -qi microsoft /proc/version 2>/dev/null; then DESC="$DESC (WSL)"; fi
    case "$OS_VER" in 22.04|24.04) ;; *) DESC="$DESC — untested version, continuing" ;; esac ;;
  *) die "unsupported system: $OS" ;;
esac

r_version() {
  command -v Rscript >/dev/null 2>&1 || return 0
  Rscript -e 'cat(R.version$major, R.version$minor, sep = ".")' 2>/dev/null || true
}
r_pkgs() {
  Rscript -e 'for (p in c("BiocManager", "BiocVersion", "dada2", "Biostrings", "ShortRead")) cat(p, tryCatch(as.character(packageVersion(p)), error = function(e) "-"), "\n")' 2>/dev/null || true
}
field() { printf '%s\n' "$1" | awk -v k="$2" '$1 == k { print $2 }'; }
series() { printf '%s' "$1" | cut -d. -f1-2; }

detect() {
  LIBS_MISSING=""
  if [ "$PLATFORM" = ubuntu ]; then
    local p st
    for p in $UBUNTU_LIBS; do
      st="$(dpkg-query -W -f='${db:Status-Abbrev}' "$p" 2>/dev/null || true)"
      case "$st" in ii*) ;; *) LIBS_MISSING="$LIBS_MISSING $p" ;; esac
    done
    LIBS_MISSING="${LIBS_MISSING# }"
  fi
  RV="$(r_version)"
  case "$RV" in "$R_WANT".*) R_OK=1 ;; *) R_OK=0 ;; esac
  local out=""
  if [ "$R_OK" = 1 ]; then out="$(r_pkgs)"; fi
  BIOCV="$(field "$out" BiocVersion)"
  case "$BIOCV" in "$BIOC_WANT".*) BIOC_OK=1 ;; *) BIOC_OK=0 ;; esac
  PKGS_TODO=""
  PKG_LINES=""
  local pkg v
  for pkg in $PKGS; do
    v="$(field "$out" "$pkg")"
    if [ -n "$v" ] && [ "$v" != - ] && [ "$(series "$v")" = "$(pkg_want "$pkg")" ]; then
      PKG_LINES="$PKG_LINES$pkg|ok ($v)
"
    else
      PKGS_TODO="$PKGS_TODO $pkg"
      if [ -z "$v" ] || [ "$v" = - ]; then v=missing; else v="has $v"; fi
      PKG_LINES="$PKG_LINES$pkg|$v
"
    fi
  done
  PKGS_TODO="${PKGS_TODO# }"
  CUT_BIN="$(command -v cutadapt 2>/dev/null || true)"
  CUTV=""
  if [ -n "$CUT_BIN" ]; then CUTV="$(cutadapt --version 2>/dev/null | head -n 1 || true)"; fi
  if [ "$CUTV" = "$CUTADAPT_WANT" ]; then CUT_OK=1; else CUT_OK=0; fi
}

row() { printf '  %-20s %s\n' "$1" "$2"; }
report() {
  if [ "$PLATFORM" = ubuntu ]; then
    if [ -z "$LIBS_MISSING" ]; then row "system libraries" ok; else row "system libraries" "missing: $LIBS_MISSING"; fi
  fi
  if [ "$R_OK" = 1 ]; then row "R $R_WANT" "ok ($RV, $(command -v Rscript))"
  elif [ -n "$RV" ]; then row "R $R_WANT" "has R $RV"
  else row "R $R_WANT" missing; fi
  if [ "$BIOC_OK" = 1 ]; then row "Bioconductor $BIOC_WANT" "ok"
  elif [ -n "$BIOCV" ] && [ "$BIOCV" != - ]; then row "Bioconductor $BIOC_WANT" "has $BIOCV"
  else row "Bioconductor $BIOC_WANT" missing; fi
  local line
  printf '%s' "$PKG_LINES" | while IFS='|' read -r pkg line; do
    if [ -n "$pkg" ]; then row "$pkg $(pkg_want "$pkg")" "$line"; fi
  done
  if [ "$CUT_OK" = 1 ]; then row "cutadapt $CUTADAPT_WANT" "ok ($CUT_BIN)"
  elif [ -n "$CUTV" ]; then row "cutadapt $CUTADAPT_WANT" "has $CUTV ($CUT_BIN)"
  else row "cutadapt $CUTADAPT_WANT" missing; fi
}

manta_line() {
  local miss="" dv=""
  command -v Rscript >/dev/null 2>&1 || miss="$miss, rscript"
  command -v cutadapt >/dev/null 2>&1 || miss="$miss, cutadapt"
  if command -v Rscript >/dev/null 2>&1; then
    dv="$(Rscript -e 'cat(as.character(packageVersion("dada2")))' 2>/dev/null || true)"
  fi
  [ -n "$dv" ] || miss="$miss, dada2"
  if [ -z "$miss" ]; then
    MANTA_SAYS="DADA2 $dv ready."
    return 0
  fi
  MANTA_SAYS="FASTQ import is not possible on this server — missing on this machine: ${miss#, }."
  return 1
}

run_logged() {
  local pat="$1" rc line
  shift
  echo "\$ $*" >>"$LOG"
  set +e
  "$@" 2>&1 | tee -a "$LOG" | while IFS= read -r line; do
    if [ -n "$pat" ] && [[ $line =~ $pat ]]; then echo "      $line"; fi
  done
  rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" != 0 ]; then
    echo "    failed (exit $rc). The last lines of $LOG:" >&2
    tail -n 30 "$LOG" | sed 's/^/      /' >&2
    exit 1
  fi
}

install_libs() {
  run_logged '' as_root env DEBIAN_FRONTEND=noninteractive apt-get update -q
  local pat
  pat="^Setting up ($(printf '%s' "$LIBS_MISSING" | sed 's/ /|/g'))[: ]"
  run_logged "$pat" as_root env DEBIAN_FRONTEND=noninteractive \
    apt-get install -y -q --no-install-recommends $LIBS_MISSING
}

install_r() {
  if ! command -v rig >/dev/null 2>&1; then
    echo "    rig"
    if [ "$PLATFORM" = ubuntu ]; then
      curl -fsSL "$RIG_URL/rig-linux-$ARCH-latest.tar.gz" |
        as_root tar xz --no-same-owner --no-same-permissions -C /usr/local
    else
      mkdir -p "$HOME/.local"
      curl -fsSL "$RIG_URL/rig-macos-$ARCH-latest.tar.gz" | tar xz -C "$HOME/.local"
    fi
    command -v rig >/dev/null 2>&1 || die "rig was unpacked, but is not on the PATH"
  fi
  echo "    rig add $R_WANT"
  if [ "$PLATFORM" = ubuntu ]; then
    run_logged '' as_root env DEBIAN_FRONTEND=noninteractive rig add "$R_WANT"
  else
    rig add "$R_WANT"
  fi
  hash -r
  case "$(r_version)" in
    "$R_WANT".*) ;;
    *)
      local name
      name="$(rig list 2>/dev/null | grep -o "$R_WANT\.[0-9][0-9]*" | sort -t. -k3 -n | tail -n 1 || true)"
      [ -n "$name" ] || die "rig add $R_WANT finished, but rig lists no R $R_WANT"
      echo "    rig default $name"
      if [ "$PLATFORM" = ubuntu ]; then as_root rig default "$name"; else rig default "$name"; fi
      hash -r ;;
  esac
  case "$(r_version)" in
    "$R_WANT".*) ;;
    *) die "Rscript is still R $(r_version) instead of $R_WANT; check 'rig list' and 'command -v Rscript'" ;;
  esac
}

install_bioc() {
  Rscript -e 'if (file.access(.libPaths()[1], 2) != 0) { d <- Sys.getenv("R_LIBS_USER"); dir.create(d, recursive = TRUE, showWarnings = FALSE); cat("    user library:", d, "\n") }'
  local todo="" p code
  for p in $PKGS_TODO; do todo="$todo, \"$p\""; done
  code="options(Ncpus = 1L, warn = 1)"
  code="$code; if (!requireNamespace(\"BiocManager\", quietly = TRUE)) install.packages(\"BiocManager\", repos = \"$CRAN\")"
  code="$code; BiocManager::install(version = \"$BIOC_WANT\", ask = FALSE, update = FALSE)"
  if [ -n "$todo" ]; then
    code="$code; BiocManager::install(c(${todo#, }), version = \"$BIOC_WANT\", ask = FALSE, update = FALSE)"
  fi
  run_logged '^\* installing|^\* DONE|^ERROR|non-zero exit status|^package .*successfully unpacked|^Bioconductor version' \
    Rscript -e "$code"
}

install_cutadapt() {
  command -v uv >/dev/null 2>&1 ||
    die "uv is missing; install it first (README step 2): curl -LsSf https://astral.sh/uv/install.sh | sh"
  run_logged '^Installed|^Updated|^ \+ cutadapt' uv tool install --python 3.12 "cutadapt==$CUTADAPT_WANT"
  hash -r
}

echo "MANTA · tools for raw FASTQ import: R $R_WANT, Bioconductor $BIOC_WANT, cutadapt $CUTADAPT_WANT"
echo "System: $DESC"
echo
detect
report

TODO_LIBS=0; TODO_R=0; TODO_BIOC=0; TODO_CUT=0
[ -z "$LIBS_MISSING" ] || TODO_LIBS=1
[ "$R_OK" = 1 ] || TODO_R=1
if [ "$TODO_R" = 1 ] || [ "$BIOC_OK" = 0 ] || [ -n "$PKGS_TODO" ]; then TODO_BIOC=1; fi
[ "$CUT_OK" = 1 ] || TODO_CUT=1
if [ "$TODO_R" = 1 ]; then PKGS_TODO="$PKGS"; fi

if [ "$CHECK" = 0 ] && [ $((TODO_LIBS + TODO_R + TODO_BIOC + TODO_CUT)) -gt 0 ]; then
  echo
  echo "To install:"
  n=0
  if [ "$TODO_LIBS" = 1 ]; then n=$((n + 1)); echo "  $n. (sudo) apt-get install $LIBS_MISSING"; fi
  if [ "$TODO_R" = 1 ]; then
    n=$((n + 1))
    if [ "$PLATFORM" = ubuntu ]; then echo "  $n. (sudo) rig into /usr/local, then R $R_WANT as the default R"
    else echo "  $n. rig into ~/.local, then R $R_WANT as the default R (rig asks for your password)"; fi
  fi
  if [ "$TODO_BIOC" = 1 ]; then
    n=$((n + 1))
    if [ "$PLATFORM" = ubuntu ]; then t="partly compiled, 10-30 minutes"; else t="a few minutes"; fi
    echo "  $n. Bioconductor $BIOC_WANT with $(printf '%s' "$PKGS_TODO" | sed 's/ /, /g') into your R library ($t)"
  fi
  if [ "$TODO_CUT" = 1 ]; then n=$((n + 1)); echo "  $n. uv tool install cutadapt==$CUTADAPT_WANT (into ~/.local/bin)"; fi
  echo "  Full log: $LOG"
  if [ -t 0 ]; then
    read -r -p "Press Enter to start, Ctrl-C to cancel. " _
  fi
  : >"$LOG"
  if [ "$TODO_LIBS" = 1 ] || { [ "$TODO_R" = 1 ] && [ "$PLATFORM" = ubuntu ]; }; then
    if [ "$(id -u)" != 0 ]; then
      command -v sudo >/dev/null 2>&1 || die "sudo is missing; install the system libraries as root"
      if ! sudo -n true 2>/dev/null; then
        echo "sudo asks for your password:"
        sudo -v
      fi
    fi
  fi
  step=0; steps=$((TODO_LIBS + TODO_R + TODO_BIOC + TODO_CUT))
  if [ "$TODO_LIBS" = 1 ]; then step=$((step + 1)); echo; echo "[$step/$steps] system libraries"; install_libs; fi
  if [ "$TODO_R" = 1 ]; then step=$((step + 1)); echo; echo "[$step/$steps] R $R_WANT"; install_r; fi
  if [ "$TODO_BIOC" = 1 ]; then step=$((step + 1)); echo; echo "[$step/$steps] Bioconductor $BIOC_WANT"; install_bioc; fi
  if [ "$TODO_CUT" = 1 ]; then step=$((step + 1)); echo; echo "[$step/$steps] cutadapt $CUTADAPT_WANT"; install_cutadapt; fi
  echo
  detect
  report
  if [ "$R_OK" = 0 ] || [ "$BIOC_OK" = 0 ] || [ -n "$PKGS_TODO" ] || [ "$CUT_OK" = 0 ]; then
    if grep -q '^Killed' "$LOG" 2>/dev/null; then
      echo "A build step ran out of memory (\"Killed\" in the log). Free memory, for example with" >&2
      echo "  bash apps/manta_web/dev.sh stop --db" >&2
      echo "and run this script again; packages that finished are kept." >&2
    fi
    die "not everything is in place (see above); the full log: $LOG"
  fi
elif [ "$CHECK" = 0 ]; then
  echo
  echo "Everything is installed; nothing to do."
fi

echo
echo "Check"
if command -v Rscript >/dev/null 2>&1; then
  echo "  \$ Rscript -e 'packageVersion(\"dada2\")'"
  Rscript -e 'packageVersion("dada2")' 2>&1 | sed 's/^/    /' || true
fi
if command -v cutadapt >/dev/null 2>&1; then
  echo "  \$ cutadapt --version"
  cutadapt --version 2>&1 | sed 's/^/    /' || true
fi
rc=0
if [ "$R_OK" = 1 ] && [ -z "$PKGS_TODO" ]; then
  if Rscript -e 'suppressMessages({ library(dada2); library(Biostrings); library(ShortRead) })' >/dev/null 2>&1; then
    echo "  dada2, Biostrings and ShortRead load: ok"
  else
    echo "  dada2, Biostrings and ShortRead do not load; see: Rscript -e 'library(dada2)'"
    rc=1
  fi
fi
manta_line || rc=1
echo "  MANTA's import dialog will show: $MANTA_SAYS"
if [ "$rc" = 0 ] && { [ "$R_OK" = 0 ] || [ "$BIOC_OK" = 0 ] || [ -n "$PKGS_TODO" ] || [ "$CUT_OK" = 0 ]; }; then
  echo "  but the versions differ from the ones above; the same reads can then give other ASVs."
  rc=1
fi
if [ "$rc" = 0 ]; then
  case ":$ORIG_PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) [ "$(dirname "$(command -v cutadapt)")" != "$HOME/.local/bin" ] ||
         echo "  cutadapt is in ~/.local/bin; dev.sh finds it there. For your own shell: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
  [ "$CHECK" = 1 ] || echo "  If MANTA is running: bash apps/manta_web/dev.sh restart"
elif [ "$CHECK" = 1 ]; then
  echo "  To install what is missing: bash tools/dada2_to_otter/install_dada2.sh"
fi
exit "$rc"
