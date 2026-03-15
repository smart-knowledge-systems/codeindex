# Homebrew formula template for cidx
# Tap: smart-knowledge-systems/homebrew-cidx
#
# To release a new version:
# 1. Update VERSION and the sha256 hashes for each bottle block
# 2. Run: brew audit --strict scripts/brew/cidx.rb
# 3. Commit and push to the homebrew-cidx tap repo

class Cidx < Formula
  desc "Fast, local-first semantic code search powered by tree-sitter and vector embeddings"
  homepage "https://github.com/smart-knowledge-systems/codeindex"
  version "CIDX_VERSION"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/smart-knowledge-systems/codeindex/releases/download/v#{version}/cidx-darwin-arm64.tar.gz"
      sha256 "CIDX_SHA256_DARWIN_ARM64"

      def install
        bin.install "cidx"
      end
    else
      url "https://github.com/smart-knowledge-systems/codeindex/releases/download/v#{version}/cidx-darwin-x64.tar.gz"
      sha256 "CIDX_SHA256_DARWIN_X64"

      def install
        bin.install "cidx"
      end
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/smart-knowledge-systems/codeindex/releases/download/v#{version}/cidx-linux-arm64.tar.gz"
      sha256 "CIDX_SHA256_LINUX_ARM64"

      def install
        bin.install "cidx"
      end
    else
      url "https://github.com/smart-knowledge-systems/codeindex/releases/download/v#{version}/cidx-linux-x64.tar.gz"
      sha256 "CIDX_SHA256_LINUX_X64"

      def install
        bin.install "cidx"
      end
    end
  end

  test do
    assert_match "cidx", shell_output("#{bin}/cidx --help 2>&1")
  end
end
