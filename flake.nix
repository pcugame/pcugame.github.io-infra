{
  description = "Repository-local Node.js and Prisma development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/0bb2eedc20e4739f29e8045034f2828ad7054f8f";
    prisma-nixpkgs.url = "github:NixOS/nixpkgs/2372de7745375e13d487e9e385c11e34bf396215";
  };

  outputs = { nixpkgs, prisma-nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      prismaPkgs = import prisma-nixpkgs { inherit system; };
      engines = prismaPkgs.prisma-engines;
      api = builtins.fromJSON (builtins.readFile ./apps/api/package.json);
      prismaVersions = [
        api.devDependencies.prisma
        api.dependencies."@prisma/client"
        api.dependencies."@prisma/adapter-pg"
      ];
    in {
      devShells.${system}.default =
        assert pkgs.lib.assertMsg (pkgs.nodejs_26.version == "26.13.0")
          "The development shell requires Node.js 26.13.0";
        assert pkgs.lib.assertMsg (builtins.all (version: version == engines.version) prismaVersions)
          "Workspace Prisma CLI, client and adapter versions must match the Nix Prisma engines";
        pkgs.mkShell {
          packages = [ pkgs.nodejs_26 ];
          # Invoke the npm workspace CLI; only its native schema engine comes from Nix.
          PRISMA_SCHEMA_ENGINE_BINARY = "${engines}/bin/schema-engine";
        };
    };
}
