class Relay < Formula
  desc "Multi-agent orchestrator for Claude Code sessions with dashboard and CLI"   # <= 80 chars (brew audit)
  homepage "https://github.com/JeongJaeSoon/relay"
  version "0.1.0"
  license "MIT"

  on_arm do
    url "https://github.com/JeongJaeSoon/relay/releases/download/v#{version}/relay-#{version}-darwin-arm64.tar.gz"
    sha256 "ARM64_SHA256"
  end
  on_intel do
    url "https://github.com/JeongJaeSoon/relay/releases/download/v#{version}/relay-#{version}-darwin-x64.tar.gz"
    sha256 "X64_SHA256"
  end

  depends_on :macos
  depends_on "git"

  def install
    bin.install "relay"
  end

  def post_install
    (Pathname.new(Dir.home)/"Library/Logs/relay").mkpath   # launchd does not create log directories
  end

  service do
    run [opt_bin/"relay", "serve"]
    keep_alive successful_exit: false   # restart on crash only: serve() exits 0 to sleep after a failed boot of the same version
    working_dir Dir.home
    log_path "#{Dir.home}/Library/Logs/relay/stdout.log"
    error_log_path "#{Dir.home}/Library/Logs/relay/stderr.log"
    environment_variables PATH: "#{std_service_path_env}:#{Dir.home}/.local/bin", RELAY_SERVICE: "1", RELAY_BIN: opt_bin/"relay"   # RELAY_BIN: hooks/MCP point at the opt path, not the Cellar version
  end

  def caveats
    <<~EOS
      relay needs the Claude Code CLI (>= 2.1.251) logged in with your subscription:
        claude --version && claude   # then /login if needed
      First-time setup, then start the always-on service:
        relay setup --service
        brew services start relay
        relay open                    # http://127.0.0.1:8790
      Check the service context (PATH, Keychain vs token fallback):
        relay doctor --service
    EOS
  end

  test do
    assert_match "relay", shell_output("#{bin}/relay --version")
  end
end
