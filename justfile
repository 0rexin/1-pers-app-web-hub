ts    := "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
label := "io.github.0rexin.fannyhub"
plist := home_directory() / "Library/LaunchAgents" / label + ".plist"
port  := env_var_or_default("PORT", "4747")

# run in this terminal (ctrl-c stops it)
run:
    bun server.ts

# scaffold the brain and make it its own local git repo — safe to repeat
init:
    mkdir -p brain/inbox brain/notes brain/projects brain/areas brain/resources brain/archive
    [ -f brain/README.md ] || cp brain.template.md brain/README.md
    [ -d brain/.git ] || git -C brain init -q
    git -C brain add -A && git -C brain commit -qm "brain: init" || true

# always-on: start at login + reachable from the tailnet
on: init
    #!/bin/sh
    set -e
    mkdir -p local/logs
    cat > "{{plist}}" <<EOF
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict>
      <key>Label</key><string>{{label}}</string>
      <key>ProgramArguments</key><array><string>/opt/homebrew/bin/bun</string><string>server.ts</string></array>
      <key>WorkingDirectory</key><string>{{justfile_directory()}}</string>
      <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string><key>PORT</key><string>{{port}}</string></dict>
      <key>RunAtLoad</key><true/>
      <key>KeepAlive</key><true/>
      <key>StandardOutPath</key><string>{{justfile_directory()}}/local/logs/server.log</string>
      <key>StandardErrorPath</key><string>{{justfile_directory()}}/local/logs/server.err.log</string>
    </dict></plist>
    EOF
    launchctl bootout "gui/$(id -u)/{{label}}" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "{{plist}}"
    "{{ts}}" serve --bg --yes --http 80 "http://127.0.0.1:{{port}}"
    just url

# stop everything `on` started
off:
    -launchctl bootout "gui/$(id -u)/{{label}}"
    -trash "{{plist}}"
    -"{{ts}}" serve --http 80 off

# the address to open on the phone
url:
    @"{{ts}}" status --json | jq -r '"http://" + (.Self.DNSName | split(".")[0]) + "/"'

test:
    bun test
