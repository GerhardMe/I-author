{
  description = "Iauthor - private markdown writing app";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = nixpkgs.legacyPackages.${system}; in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            pnpm
            git
            rclone
            # PDF compilation: lualatex + the markdown package (+ house style
            # deps and pdfpages for fragment assembly, matching the
            # fundamentality toolbox)
            (pkgs.texlive.combine {
              # pinned nixpkgs uses the set-based texlive.combine API
              inherit (pkgs.texlive)
                scheme-medium
                markdown
                paralist
                parskip
                csvsimple
                gobble
                palatino
                microtype
                titlesec
                epigraph
                nextpage
                extsizes
                framed
                pdfpages
                pdfcol
                lettrine
                fancyhdr
                ;
            })
          ];
          shellHook = ''
            export PATH="$PWD/scripts:$PATH"
            echo "Iauthor dev shell"
            echo "  run        dev server on :4321"
            echo "  test-auth  auth unit tests"
            echo "  build      production build"
            echo "  deploy     test + build + sync to VPS + health check"
            echo "  lualatex   pdf compiler (texlive, on PATH)"
          '';
        };
      });
}