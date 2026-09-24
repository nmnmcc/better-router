{ pkgs, ... }:

{
  packages = [
    pkgs.treefmt
    pkgs.prettier
    pkgs.nixfmt
  ];

  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    corepack.enable = true;
    lsp.enable = false;
  };
}
