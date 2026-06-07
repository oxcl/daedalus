{
  description = "Daedalus AI Gateway";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        bun = pkgs.bun;

        daedalusPackage = pkgs.stdenv.mkDerivation {
          pname = "daedalus";
          version = "0.1.0";
          src = ./.;

          buildInputs = [ bun ];

          buildPhase = ''
            export HOME=$TMPHOME
            bun install --frozen-lockfile
            bun run typecheck
          '';

          installPhase = ''
            mkdir -p $out/share/daedalus
            cp -r src $out/share/daedalus/
            cp -r package.json $out/share/daedalus/
            cp -r node_modules $out/share/daedalus/
            cp bun.lock $out/share/daedalus/

            mkdir -p $out/bin
            cat > $out/bin/daedalus << wrapper
            #!/bin/sh
            exec ${bun}/bin/bun run $out/share/daedalus/src/server.ts
            wrapper
            chmod +x $out/bin/daedalus
          '';
        };

        daemonUser = "daedalus";
        daemonGroup = "daedalus";

      in
      {
        packages = {
          daedalus = daedalusPackage;
          default = daedalusPackage;
        };

        nixosModules.default = { config, lib, pkgs, ... }:
          let
            cfg = config.services.daedalus;
          in
          {
            options.services.daedalus = {
              enable = lib.mkEnableOption "Daedalus AI Gateway";
              package = lib.mkOption {
                type = lib.types.package;
                default = self.packages.${system}.daedalus;
                description = "Daedalus package to use";
              };
              port = lib.mkOption {
                type = lib.types.port;
                default = 6767;
                description = "Port to listen on";
              };
              configDir = lib.mkOption {
                type = lib.types.path;
                default = "/var/lib/daedalus/config";
                description = "Directory for provider config files";
              };
              dataDir = lib.mkOption {
                type = lib.types.path;
                default = "/var/lib/daedalus/data";
                description = "Directory for API keys and state";
              };
            };

            config = lib.mkIf cfg.enable {
              users.users.${daemonUser} = {
                isSystemUser = true;
                group = daemonGroup;
                home = cfg.dataDir;
                createHome = true;
              };

              users.groups.${daemonGroup} = { };

              systemd.services.daedalus = {
                description = "Daedalus AI Gateway";
                wantedBy = [ "multi-user.target" ];
                after = [ "network.target" ];
                serviceConfig = {
                  Type = "simple";
                  User = daemonUser;
                  Group = daemonGroup;
                  WorkingDirectory = cfg.dataDir;
                  ExecStart = "${cfg.package}/bin/daedalus";
                  Environment = [
                    "PORT=${toString cfg.port}"
                    "XDG_CONFIG_HOME=${cfg.configDir}"
                    "XDG_DATA_HOME=${cfg.dataDir}"
                  ];
                  Restart = "on-failure";
                  RestartSec = 5;
                  StandardOutput = "null";
                  StandardError = "null";
                  NoNewPrivileges = true;
                  ProtectSystem = "strict";
                  ProtectHome = true;
                  PrivateTmp = true;
                  StateDirectory = "daedalus";
                };
              };

              systemd.tmpfiles.rules = [
                "d ${cfg.configDir} 0755 ${daemonUser} ${daemonGroup} - -"
                "d ${cfg.dataDir} 0700 ${daemonUser} ${daemonGroup} - -"
              ];
            };
          };

        homeManagerModules.default = { config, lib, pkgs, ... }:
          let
            cfg = config.services.daedalus;
            xdgConfig = "${config.xdg.configHome}/daedalus";
            xdgData = "${config.xdg.dataHome}/daedalus";
          in
          {
            options.services.daedalus = {
              enable = lib.mkEnableOption "Daedalus AI Gateway";
              package = lib.mkOption {
                type = lib.types.package;
                default = self.packages.${system}.daedalus;
                description = "Daedalus package to use";
              };
              port = lib.mkOption {
                type = lib.types.port;
                default = 6767;
                description = "Port to listen on";
              };
            };

            config = lib.mkIf cfg.enable {
              home.packages = [ cfg.package ];

              xdg.configFile."daedalus/providers.json".text =
                builtins.toJSON { };

              systemd.user.services.daedalus = {
                Unit = {
                  Description = "Daedalus AI Gateway";
                  After = [ "network.target" ];
                };
                Service = {
                  Type = "simple";
                  ExecStart = "${cfg.package}/bin/daedalus";
                  Environment = [
                    "PORT=${toString cfg.port}"
                    "XDG_CONFIG_HOME=${xdgConfig}"
                    "XDG_DATA_HOME=${xdgData}"
                  ];
                  Restart = "on-failure";
                  RestartSec = 5;
                  StandardOutput = "null";
                  StandardError = "null";
                };
                Install = {
                  WantedBy = [ "default.target" ];
                };
              };

              systemd.user.tmpfiles.rules = [
                "d ${xdgData} 0700 - - - -"
              ];
            };
          };
      }
    );
}