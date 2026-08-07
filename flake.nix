{
  description = "pilegram — a pi ⇄ Telegram gateway (Bun) with local voice (whisper.cpp STT + Supertonic TTS)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));
    in
    {
      # Runtime tools the gateway shells out to for voice (§7):
      #   bun         — runs the app
      #   ffmpeg      — transcode voice notes ↔ OGG/Opus
      #   whisper-cpp — STT (whisper-cli), large-v3-turbo
      # TTS is Supertonic 3, run in-process via the `onnxruntime-node` npm dep
      # (see vendor/supertonic) — no Python, no phonemizer, nothing extra here.
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.bun pkgs.ffmpeg pkgs.whisper-cpp ];
          shellHook = ''
            # This dev host MITMs TLS; point bun/node at the system CA bundle so
            # outbound HTTPS (Telegram, HF model downloads) verifies. Harmless elsewhere.
            if [ -f /etc/ssl/certs/ca-certificates.crt ]; then
              export NODE_EXTRA_CA_CERTS="''${NODE_EXTRA_CA_CERTS:-/etc/ssl/certs/ca-certificates.crt}"
            fi
            echo "pilegram devshell — bun $(bun --version); whisper-cli, ffmpeg on PATH"
          '';
        };
      });

      # Hermetic build. `node_modules` is a fixed-output derivation (bun install,
      # pinned by hash) — this keeps a normal node_modules layout so the native
      # onnxruntime-node dylib resolves at runtime (unlike `bun build --compile`,
      # which drops the sibling libonnxruntime dylib). The app runs via `bun run`
      # with ffmpeg + whisper.cpp wrapped onto PATH. `nix run` works from anywhere.
      packages = forAll (pkgs:
        let
          nodeModules = pkgs.stdenv.mkDerivation {
            pname = "pilegram-node-modules";
            version = "0.0.0";
            src = ./.;
            nativeBuildInputs = [ pkgs.bun ];
            dontConfigure = true;
            buildPhase = ''
              export HOME="$TMPDIR"
              bun install --frozen-lockfile --no-progress --production
            '';
            installPhase = ''
              rm -rf node_modules/.cache
              cp -R node_modules "$out"
            '';
            dontFixup = true;
            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = "sha256-PpF7rO6XBmkMA6SCeVnh+pnkk/l6dwgMMzstxDP3rY4=";
          };
        in
        {
          default = pkgs.stdenv.mkDerivation {
            pname = "pilegram";
            version = "0.0.0";
            src = ./.;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            dontConfigure = true;
            dontBuild = true;
            installPhase = ''
              mkdir -p "$out/libexec/pilegram"
              cp -R src vendor package.json bun.lock "$out/libexec/pilegram/"
              ln -s ${nodeModules} "$out/libexec/pilegram/node_modules"
              makeWrapper ${pkgs.bun}/bin/bun "$out/bin/pilegram" \
                --add-flags "run $out/libexec/pilegram/src/index.ts" \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.ffmpeg pkgs.whisper-cpp ]}
            '';
            meta.mainProgram = "pilegram";
          };
          node-modules = nodeModules;
        });
    };
}
