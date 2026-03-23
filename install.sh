#!/usr/bin/env bash
# cpi (zippy) installer
# Usage: curl -fsSL https://contextone.dev/install | bash
set -euo pipefail

# --- Configuration ---
CPI_REPO="context-one/cpi"
CPI_BRANCH="main"
PI_PKG="@mariozechner/pi-coding-agent"
PI_CONFIG_DIR="${HOME}/.pi/agent"
CPI_PKG_DIR="${PI_CONFIG_DIR}/packages/cpi"
CPI_WRAPPER_NAME="cpi"
MIN_NODE_VERSION="20"

# Extensions to install via `pi install`
CPI_EXTENSIONS=(
  "npm:pi-mcp-adapter"
  "npm:pi-powerline-footer"
)

# --- Colors & formatting ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { printf "${BLUE}${BOLD}info${RESET}  %s\n" "$1"; }
success() { printf "${GREEN}${BOLD}  ok${RESET}  %s\n" "$1"; }
warn()    { printf "${YELLOW}${BOLD}warn${RESET}  %s\n" "$1"; }
error()   { printf "${RED}${BOLD} err${RESET}  %s\n" "$1" >&2; }
fatal()   { error "$1"; exit 1; }

# --- Platform detection ---
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) OS="macos" ;;
    Linux)  OS="linux" ;;
    *)      fatal "Unsupported operating system: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)             fatal "Unsupported architecture: $arch" ;;
  esac
}

# --- Prerequisite checks ---
check_command() {
  command -v "$1" >/dev/null 2>&1
}

check_node() {
  if ! check_command node; then
    fatal "Node.js is required but not found. Install Node.js >= ${MIN_NODE_VERSION} from https://nodejs.org"
  fi

  local node_major
  node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
  if [ "$node_major" -lt "$MIN_NODE_VERSION" ]; then
    fatal "Node.js >= ${MIN_NODE_VERSION} required (found v$(node --version)). Please upgrade: https://nodejs.org"
  fi
  success "Node.js $(node --version)"
}

check_npm() {
  if ! check_command npm; then
    fatal "npm is required but not found. It usually comes with Node.js."
  fi
  success "npm $(npm --version)"
}

check_git() {
  if ! check_command git; then
    fatal "git is required but not found. Install git from https://git-scm.com"
  fi
  success "git $(git --version | awk '{print $3}')"
}

# --- Installation steps ---
install_pi() {
  if check_command pi; then
    info "pi is already installed ($(pi --version 2>/dev/null || echo 'unknown')), updating..."
  else
    info "Installing pi coding agent..."
  fi
  npm install -g "${PI_PKG}@latest" --silent 2>/dev/null || npm install -g "${PI_PKG}@latest"
  success "pi $(pi --version 2>/dev/null || echo 'installed')"
}

setup_config_dir() {
  mkdir -p "${PI_CONFIG_DIR}"/{extensions,skills,prompts,themes,packages}
  success "Config directory: ${PI_CONFIG_DIR}"
}

install_cpi_package() {
  local expected_remote="https://github.com/${CPI_REPO}.git"
  info "Installing cpi package..."

  if [ -d "${CPI_PKG_DIR}" ]; then
    # Verify the existing clone points to our repo
    local remote_url
    remote_url="$(git -C "${CPI_PKG_DIR}" remote get-url origin 2>/dev/null || true)"
    if [ "${remote_url}" != "${expected_remote}" ]; then
      warn "Unexpected remote (${remote_url}), re-cloning..."
      rm -rf "${CPI_PKG_DIR}"
      git clone --depth 1 --branch "${CPI_BRANCH}" \
        "${expected_remote}" "${CPI_PKG_DIR}"
    else
      info "Updating existing cpi package..."
      git -C "${CPI_PKG_DIR}" fetch --depth 1 origin "${CPI_BRANCH}" 2>/dev/null && \
      git -C "${CPI_PKG_DIR}" reset --hard FETCH_HEAD 2>/dev/null || {
        warn "Update failed, re-cloning..."
        rm -rf "${CPI_PKG_DIR}"
        git clone --depth 1 --branch "${CPI_BRANCH}" \
          "${expected_remote}" "${CPI_PKG_DIR}"
      }
    fi
  else
    git clone --depth 1 --branch "${CPI_BRANCH}" \
      "${expected_remote}" "${CPI_PKG_DIR}"
  fi

  success "cpi package installed: ${CPI_PKG_DIR}"
}

merge_settings() {
  local settings_file="${PI_CONFIG_DIR}/settings.json"
  local cpi_settings="${CPI_PKG_DIR}/settings.json"

  if [ ! -f "${cpi_settings}" ]; then
    warn "No cpi settings.json found, skipping settings merge"
    return
  fi

  if [ ! -f "${settings_file}" ]; then
    # No existing settings — just copy defaults
    cp "${cpi_settings}" "${settings_file}"
    success "Created settings: ${settings_file}"
    return
  fi

  # Merge: ensure cpi package is in the packages list
  # Use node for JSON merging since jq may not be available
  # Paths passed via env vars to avoid shell injection
  SETTINGS_FILE="${settings_file}" CPI_SETTINGS="${cpi_settings}" node -e '
    const fs = require("fs");
    const existing = JSON.parse(fs.readFileSync(process.env.SETTINGS_FILE, "utf8"));
    const defaults = JSON.parse(fs.readFileSync(process.env.CPI_SETTINGS, "utf8"));

    // Only add fields that do not exist yet (non-destructive)
    for (const [key, value] of Object.entries(defaults)) {
      if (key === "packages") {
        // Merge packages array — ensure cpi package is present
        existing.packages = existing.packages || [];
        const cpiPkgs = Array.isArray(value) ? value : [value];
        for (const pkg of cpiPkgs) {
          if (!existing.packages.includes(pkg)) {
            existing.packages.push(pkg);
          }
        }
      } else if (!(key in existing)) {
        existing[key] = value;
      }
    }

    fs.writeFileSync(process.env.SETTINGS_FILE, JSON.stringify(existing, null, 2) + "\n");
  '
  success "Merged settings: ${settings_file}"
}

install_extensions() {
  if [ ${#CPI_EXTENSIONS[@]} -eq 0 ]; then return; fi
  info "Installing extensions..."
  for ext in "${CPI_EXTENSIONS[@]}"; do
    if pi install "$ext" >/dev/null 2>&1; then
      success "$ext"
    else
      warn "Failed to install $ext (you can retry with: pi install $ext)"
    fi
  done
}

install_wrapper() {
  local wrapper_dir
  local wrapper_path

  # Determine install location — prefer writable path
  if [ -w "/usr/local/bin" ]; then
    wrapper_dir="/usr/local/bin"
  else
    wrapper_dir="${HOME}/.local/bin"
  fi

  mkdir -p "${wrapper_dir}"
  wrapper_path="${wrapper_dir}/${CPI_WRAPPER_NAME}"

  cat > "${wrapper_path}" << 'WRAPPER'
#!/usr/bin/env bash
# cpi (zippy) — pre-configured pi coding agent
# Pi auto-loads the @context-one/cpi package from ~/.pi/agent/settings.json
# (registered by merge_settings during install), which loads all cpi extensions.
exec pi "$@"
WRAPPER

  chmod +x "${wrapper_path}"
  success "Installed ${CPI_WRAPPER_NAME} wrapper: ${wrapper_path}"

  # Check if wrapper is in PATH
  if ! check_command "${CPI_WRAPPER_NAME}"; then
    warn "${wrapper_dir} is not in your PATH"
    warn "Add it with:  export PATH=\"${wrapper_dir}:\$PATH\""
  fi
}

# --- Main ---
main() {
  printf "\n"
  printf "${BOLD}  cpi (zippy) installer${RESET}\n"
  printf "  Pre-configured pi coding agent harness\n"
  printf "\n"

  detect_platform
  info "Detected: ${OS} ${ARCH}"

  printf "\n${BOLD}Checking prerequisites...${RESET}\n"
  check_node
  check_npm
  check_git

  printf "\n${BOLD}Installing...${RESET}\n"
  install_pi
  setup_config_dir
  install_cpi_package
  merge_settings
  install_extensions
  install_wrapper

  printf "\n"
  printf "${GREEN}${BOLD}Installation complete!${RESET}\n"
  printf "\n"
  printf "  Run ${BOLD}cpi${RESET} to start the coding agent.\n"
  printf "  Run ${BOLD}pi /login${RESET} to authenticate with your LLM provider.\n"
  printf "\n"
  printf "  Config:     ${PI_CONFIG_DIR}/settings.json\n"
  printf "  Extensions: ${CPI_PKG_DIR}/extensions/\n"
  printf "  Skills:     ${CPI_PKG_DIR}/skills/\n"
  printf "\n"
}

main "$@"
