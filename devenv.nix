{ pkgs, ... }:

{
  treefmt = {
    enable = true;

    config.programs = {
      nixfmt.enable = true;
      prettier = {
        enable = true;
        includes = [
          "*.ts"
          "*.mts"
          "*.js"
          "*.mjs"
          "*.json"
          "*.md"
          "*.yml"
          "*.yaml"
        ];
        excludes = [
          "references/**"
          "yarn.lock"
          "devenv.lock"
          "packages/plugin-openai-responses/src/generated/OpenResponses.ts"
          "packages/plugin-openai-responses/src/generated/OpenResponsesSchema.json"
        ];
      };
    };

    config.settings.excludes = [
      "references/**"
    ];
  };

  git-hooks.hooks.treefmt.enable = true;

  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    corepack.enable = true;
    lsp.enable = false;
  };
}
